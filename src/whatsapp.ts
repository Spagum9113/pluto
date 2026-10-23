import fs from 'node:fs';
import makeWASocket, { DisconnectReason, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { Config } from './config.js';
import type { MessageKey, PlutoDb } from './db.js';
import { runAgent, type AgentReply } from './agent.js';
import { clip, log } from './log.js';
import { isPlutoMessage, mentionsBot, shouldTriggerClaude, stripBotPrefix, typingDelayMs } from './router.js';

export type PlutoSocket = {
  sendPluto: (text: string) => Promise<void>;
};

const baileysLogger = pino({ level: 'silent' });
const PIN_7_DAYS = 604800 as const;

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
      await deliverText(currentSock, db, jid, config.botPrefix, text);
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
      rememberSender(db, config.ownerName, msg);
      log('setup', 'this group is now the only chat Pluto will use');
      db.addChatLine(config.ownerName, text, false);
      await deliverText(sock, db, remoteJid, config.botPrefix, "hey. i'll keep the list.");
    } else if (remoteJid.endsWith('@g.us')) {
      log('wait', 'ignoring a group until you send !setup from your phone');
    }
    return;
  }

  if (remoteJid !== bound) {
    log('skip', 'message outside the bound group');
    return;
  }

  const quoted = quotedInfo(msg, remoteJid);
  const quotedBot = db.isSentByPluto(quoted?.id);
  const fromBot = isPlutoMessage({ fromMe, id: msgId, text }, { has: (id) => db.isSentByPluto(id) }, config.botPrefix);
  const sender = fromBot ? 'pluto' : fromMe ? config.ownerName : msg.pushName || 'stella';
  if (!fromBot) rememberSender(db, sender, msg);
  db.addChatLine(sender, stripBotPrefix(text, config.botPrefix), fromBot);
  if (fromBot) return;

  log('chat', `${sender}: ${clip(stripBotPrefix(text, config.botPrefix))}`);
  if (isSetup && fromMe) {
    log('setup', 'already bound to this group');
    await deliverText(sock, db, remoteJid, config.botPrefix, "i'm already on.");
    return;
  }

  const expecting = db.isExpecting();
  const named = mentionsBot(text, config.botNames);
  if (!shouldTriggerClaude({ text, botNames: config.botNames, quotedBot, quotedSomeoneElse: Boolean(quoted && !quotedBot), expecting })) {
    log('skip', 'saved for context, no reply');
    return;
  }
  if (expecting && !named && !quotedBot) db.clearExpecting();

  log('reply', `${sender} triggered Pluto${quotedBot ? ' by quoting' : expecting && !named ? ' with an answer' : ''}`);
  const reply = await runAgent({
    db,
    apiKey: config.anthropicApiKey,
    model: config.model,
    timezone: config.timezone,
    actor: sender,
    text: stripBotPrefix(text, config.botPrefix),
    personalityPath: 'personality.md',
    quotedKey: quoted,
  });
  await deliverReply(sock, db, remoteJid, config.botPrefix, reply, messageKey(msg), quoted);
}

async function deliverReply(sock: any, db: PlutoDb, jid: string, prefix: string, reply: AgentReply, triggerKey?: MessageKey, quotedKey?: MessageKey): Promise<void> {
  if (reply.react && triggerKey) await react(sock, jid, triggerKey, reply.react);
  if (reply.poll) {
    await deliverPoll(sock, db, jid, prefix, reply.poll.name, reply.poll.values);
    db.setExpectingUntil(new Date(Date.now() + 5 * 60 * 1000).toISOString());
    return;
  }
  if (!reply.text) return;
  const sent = await deliverText(sock, db, jid, prefix, reply.text);
  if (reply.pinSent && sent) await pinForSevenDays(sock, db, jid, sent);
  if (reply.pinQuoted && quotedKey) await pinForSevenDays(sock, db, jid, quotedKey);
  if (reply.expect) db.setExpectingUntil(new Date(Date.now() + 5 * 60 * 1000).toISOString());
  else db.clearExpecting();
}

async function deliverText(sock: any, db: PlutoDb, jid: string, prefix: string, text: string): Promise<MessageKey | undefined> {
  const body = text.trim();
  if (!body) return undefined;
  const mentioned = withMentions(db, body);
  await sock.sendPresenceUpdate('composing', jid);
  await delay(typingDelayMs(body));
  const sent = await sock.sendMessage(jid, { text: `${prefix}${mentioned.text}`, mentions: mentioned.mentions });
  const key = sent?.key?.id ? messageKey(sent) : undefined;
  if (key?.id) db.addSentId(key.id);
  db.addChatLine('pluto', body, true);
  log('send', clip(body));
  return key;
}

async function deliverPoll(sock: any, db: PlutoDb, jid: string, prefix: string, name: string, values: string[]): Promise<void> {
  await sock.sendPresenceUpdate('composing', jid);
  await delay(typingDelayMs(name));
  const sent = await sock.sendMessage(jid, { poll: { name: `${prefix}${name}`, values, selectableCount: 1 } });
  const id = sent?.key?.id;
  if (id) db.addSentId(id);
  db.addChatLine('pluto', name, true);
  log('poll', clip(name));
}

async function react(sock: any, jid: string, key: MessageKey, emoji: string): Promise<void> {
  await sock.sendMessage(jid, { react: { text: emoji, key } });
  log('react', emoji);
}

async function pinForSevenDays(sock: any, db: PlutoDb, jid: string, key: MessageKey): Promise<void> {
  const previous = db.getPinnedKey();
  if (previous?.id) {
    await sock.sendMessage(jid, { pin: { key: previous, type: proto.PinInChat.Type.UNPIN_FOR_ALL, time: PIN_7_DAYS } }).catch((err: unknown) => log('pin', err instanceof Error ? err.message : 'unpin failed'));
  }
  await sock.sendMessage(jid, { pin: { key, type: proto.PinInChat.Type.PIN_FOR_ALL, time: PIN_7_DAYS } });
  db.setPinnedKey(key);
  log('pin', '7 days');
}

function withMentions(db: PlutoDb, text: string): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  let out = text;
  for (const [name, jid] of Object.entries(db.people())) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (!pattern.test(out)) continue;
    mentions.push(jid);
    if (jid.endsWith('@s.whatsapp.net')) out = out.replace(pattern, `@${jid.split('@')[0]}`);
  }
  return { text: out, mentions };
}

function rememberSender(db: PlutoDb, name: string, msg: any): void {
  const jid = msg.key?.participant || msg.key?.participantAlt;
  if (name && jid) db.rememberPerson(name, jid);
}

function quotedInfo(msg: any, remoteJid: string): MessageKey | undefined {
  const context = msg.message?.extendedTextMessage?.contextInfo;
  if (!context?.stanzaId) return undefined;
  return { remoteJid, id: context.stanzaId, participant: context.participant, fromMe: false };
}

function messageKey(msg: any): MessageKey | undefined {
  if (!msg.key?.id || !msg.key?.remoteJid) return undefined;
  return { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: Boolean(msg.key.fromMe), participant: msg.key.participant };
}

export function extractText(msg: any): string | undefined {
  const message = msg.message;
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
