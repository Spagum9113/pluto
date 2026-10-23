import fs from 'node:fs';
import { config } from './config.js';
import { PlutoDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { startWhatsApp } from './whatsapp.js';

if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new PlutoDb(config.dbPath);
const wa = await startWhatsApp(config, db);
startScheduler(db, wa.sendPluto, config.timezone);

console.log('pluto is running');
