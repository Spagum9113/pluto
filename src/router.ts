import type { PendingRemove } from './db.js';

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isBotText(text: string, prefix: string): boolean {
  return text.trimStart().startsWith(prefix);
}

export function isPlutoMessage(input: { fromMe: boolean; id?: string | null; text?: string }, sentIds: { has(id?: string | null): boolean }, prefix: string): boolean {
  if (!input.fromMe) return false;
  if (sentIds.has(input.id)) return true;
  return Boolean(input.text && isBotText(input.text, prefix));
}

export function shouldTriggerClaude(input: {
  text: string;
  botNames: string[];
  quotedBot: boolean;
  pending?: PendingRemove;
}): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  if (input.quotedBot) return true;
  if (input.pending && /^(yes|yep|yeah|y|no|nah|n)$/i.test(text)) return true;
  if (input.botNames.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text))) return true;
  return /^(add|remove|delete|change|edit|done|did|list\b|what's left|whats left|remind|remember|forget|schedule|let's do|lets do)\b/i.test(text);
}

export function stripBotPrefix(text: string, prefix: string): string {
  return isBotText(text, prefix) ? text.trimStart().slice(prefix.length).trimStart() : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
