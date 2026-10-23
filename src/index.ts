import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { PlutoDb } from './db.js';
import { log } from './log.js';
import { startScheduler } from './scheduler.js';
import { startWhatsApp } from './whatsapp.js';

if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

async function waitForSessionCopy(): Promise<void> {
  if (process.env.WAIT_FOR_SESSION !== '1') return;
  const readyPath = path.join(config.dataDir, 'READY');
  if (fs.existsSync(readyPath)) return;
  log('login', `waiting for ${readyPath} before opening WhatsApp`);
  while (!fs.existsSync(readyPath)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  log('login', 'session copy is ready');
}

fs.mkdirSync(config.dataDir, { recursive: true });
await waitForSessionCopy();

const db = new PlutoDb(config.dbPath);
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
const wa = await startWhatsApp(config, db);
startScheduler(db, wa.sendPluto, config.timezone);

const group = db.getGroupJid();
log('ready', group ? `listening in the bound group` : 'waiting for !setup in the group');
