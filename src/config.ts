import 'dotenv/config';
import path from 'node:path';

export type Config = {
  anthropicApiKey: string;
  model: string;
  timezone: string;
  dataDir: string;
  authDir: string;
  dbPath: string;
  botNames: string[];
  botPrefix: string;
  ownerName: string;
  pairPhone?: string;
};

const DEFAULT_PREFIX = '🐧 pluto: ';

export function loadConfig(env = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const botNames = (env.BOT_NAMES || 'pluto')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.MODEL || 'claude-haiku-5-5',
    timezone: env.TIMEZONE || 'Australia/Melbourne',
    dataDir,
    authDir: path.join(dataDir, 'auth'),
    dbPath: path.join(dataDir, 'bucket.db'),
    botNames,
    botPrefix: env.BOT_PREFIX ?? DEFAULT_PREFIX,
    ownerName: env.OWNER_NAME || 'ethan',
    pairPhone: env.PAIR_PHONE?.trim() || undefined,
  };
}

export const config = loadConfig();
