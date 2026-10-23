import fs from 'node:fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { Config } from './config.js';
import type { PlutoDb } from './db.js';
import { runAgent } from './agent.js';
import { isPlutoMessage, shouldTriggerClaude, stripBotPrefix } from './router.js';

export type PlutoSocket = {
  sendPluto: (text: string) => Promise<void>;
};

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export async function startWhatsApp(config: Config, db: PlutoDb): Promise<PlutoSocket> {
  fs.mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  let pairingRequested = false;

  const connect = async (): Promise<any> => {
    const sock = makeWASocket({
      auth: state,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    } as any);

    const maybeRequestPairing = async () => {
      if (pairingRequested || !config.pairPhone || state.creds.registered) return;
      pairingRequested = true;
      const code = await sock.requestPairingCode(config.pairPhone);
      logger.warn({ pairingCode: code }, 'enter this pairing code in whatsapp linked devices');
    };

    setTimeout(() => void maybeRequestPairing().catch((err) => logger.error({ err }, 'pairing code failed')), 2000);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !config.pairPhone) qrcode.generate(qr, { small: true });
      if (connection === 'open') logger.info('connected to whatsapp');
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode, shouldReconnect }, 'whatsapp connection closed');
        if (shouldReconnect) void connect();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        await handleMessage(sock, config, db, message).catch((err) => logger.error({ err }, 'message handler failed'));
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
      db.addChatLine(config.ownerName, text, false);
      await sendPluto(sock, db, remoteJid, config.botPrefix, "yo 👋 i'm pluto. i'll keep your bucket list and nag you until you actually do stuff\n\nsay \"pluto add ...\" to start, or \"pluto help\" for the rest");
    }
    return;
  }

  if (remoteJid !== bound) return;

  const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const quotedBot = db.isSentByPluto(quotedId);
  const fromBot = isPlutoMessage({ fromMe, id: msgId, text }, { has: (id) => db.isSentByPluto(id) }, config.botPrefix);
  const sender = fromBot ? 'pluto' : fromMe ? config.ownerName : msg.pushName || 'cousin';
  db.addChatLine(sender, stripBotPrefix(text, config.botPrefix), fromBot);

  if (fromBot) return;
  if (isSetup && fromMe) {
    await sendPluto(sock, db, remoteJid, config.botPrefix, "i'm already on in here");
    return;
  }

  const pending = db.getPendingRemove();
  if (!shouldTriggerClaude({ text, botNames: config.botNames, quotedBot, pending })) return;

  logger.info({ trigger: true, sender, fromMe }, 'triggering pluto');
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
    logger.info({ sent: true }, 'sent pluto message');
  }
}

export function extractText(msg: any): string | undefined {
  const message = msg.message;
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
