import fs from 'node:fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { Config } from './config.js';
import type { PlutoDb } from './db.js';
import { runAgent } from './agent.js';
import { clip, log } from './log.js';
import { isPlutoMessage, shouldTriggerClaude, stripBotPrefix } from './router.js';

export type PlutoSocket = {
  sendPluto: (text: string) => Promise<void>;
};

const baileysLogger = pino({ level: 'silent' });

export async function startWhatsApp(config: Config, db: PlutoDb): Promise<PlutoSocket> {
  fs.mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  let pairingRequested = false;

  const connect = async (): Promise<any> => {
    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    } as any);

    const maybeRequestPairing = async () => {
      if (pairingRequested || !config.pairPhone || state.creds.registered) return;
      pairingRequested = true;
      const code = await sock.requestPairingCode(config.pairPhone);
      log('pair', `code ${code}. WhatsApp → Linked devices → Link with phone number`);
    };

    setTimeout(() => void maybeRequestPairing().catch((err) => log('error', err instanceof Error ? err.message : String(err))), 2000);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !config.pairPhone) {
        log('login', 'scan this QR in WhatsApp → Linked devices');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') log('whatsapp', 'connected');
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        log('whatsapp', shouldReconnect ? `disconnected (${statusCode ?? 'unknown'}), reconnecting` : 'logged out. scan again to reconnect');
        if (shouldReconnect) void connect();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        await handleMessage(sock, config, db, message).catch((err) => log('error', err instanceof Error ? err.message : String(err)));
      }
    });

    return sock;
  };

  let currentSock = await connect();

  return {
    sendPluto: async (text: string) => {
      const jid = db.getGroupJid();
      if (!jid) return;
      currentSock = currentSock ?? (await connect());
      await sendPluto(currentSock, db, jid, config.botPrefix, text);
    },
  };
}

async function handleMessage(sock: any, config: Config, db: PlutoDb, msg: any): Promise<void> {
  const remoteJid = msg.key?.remoteJid;
  const msgId = msg.key?.id;
  const fromMe = Boolean(msg.key?.fromMe);
  const text = extractText(msg);
  if (!remoteJid || !text) return;

  const bound = db.getGroupJid();
  const isSetup = text.trim() === '!setup';
  if (!bound) {
    if (isSetup && fromMe && remoteJid.endsWith('@g.us')) {
      db.bindGroup(remoteJid);
      log('setup', 'this group is now the only chat Pluto will use');
      db.addChatLine(config.ownerName, text, false);
      await sendPluto(sock, db, remoteJid, config.botPrefix, "yo 👋 i'm pluto. i'll keep your bucket list and nag you until you actually do stuff\n\nsay \"pluto add ...\" to start, or \"pluto help\" for the rest");
    } else if (remoteJid.endsWith('@g.us')) {
      log('wait', 'ignoring a group until you send !setup from your phone');
    }
    return;
  }

  if (remoteJid !== bound) {
    log('skip', 'message outside the bound group');
    return;
  }

  const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const quotedBot = db.isSentByPluto(quotedId);
  const fromBot = isPlutoMessage({ fromMe, id: msgId, text }, { has: (id) => db.isSentByPluto(id) }, config.botPrefix);
  const sender = fromBot ? 'pluto' : fromMe ? config.ownerName : msg.pushName || 'cousin';
  db.addChatLine(sender, stripBotPrefix(text, config.botPrefix), fromBot);

  if (fromBot) return;

  log('chat', `${sender}: ${clip(stripBotPrefix(text, config.botPrefix))}`);
  if (isSetup && fromMe) {
    log('setup', 'already bound to this group');
    await sendPluto(sock, db, remoteJid, config.botPrefix, "i'm already on in here");
    return;
  }

  const pending = db.getPendingRemove();
  if (!shouldTriggerClaude({ text, botNames: config.botNames, quotedBot, pending })) {
    log('skip', 'saved for context, no reply');
    return;
  }

  log('reply', `${sender} triggered Pluto${quotedBot ? ' by quoting' : ''}`);
  await sock.sendPresenceUpdate('composing', remoteJid);
  await delay(900);
  const reply = await runAgent({
    db,
    apiKey: config.anthropicApiKey,
    model: config.model,
    timezone: config.timezone,
    actor: sender,
    text: stripBotPrefix(text, config.botPrefix),
    personalityPath: 'personality.md',
  });
  await sendPluto(sock, db, remoteJid, config.botPrefix, reply);
}

async function sendPluto(sock: any, db: PlutoDb, jid: string, prefix: string, text: string): Promise<void> {
  const bubbles = text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean).slice(0, 3);
  for (const bubble of bubbles.length ? bubbles : ['done']) {
    await sock.sendPresenceUpdate('composing', jid);
    await delay(Math.min(2500, Math.max(700, bubble.length * 25)));
    const sent = await sock.sendMessage(jid, { text: `${prefix}${bubble}` });
    const id = sent?.key?.id;
    if (id) db.addSentId(id);
    db.addChatLine('pluto', bubble, true);
    log('send', clip(bubble));
  }
}

export function extractText(msg: any): string | undefined {
  const message = msg.message;
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
