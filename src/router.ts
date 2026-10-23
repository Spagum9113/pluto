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

export function mentionsBot(text: string, botNames: string[]): boolean {
  const normalized = normalizeText(text);
  return botNames.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(normalized));
}

export function shouldTriggerClaude(input: {
  text: string;
  botNames: string[];
  quotedBot: boolean;
  quotedSomeoneElse?: boolean;
  expecting?: boolean;
  pending?: PendingRemove;
}): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  const named = mentionsBot(text, input.botNames);
  if (input.quotedSomeoneElse && !named) return false;
  if (input.quotedBot || named) return true;
  return Boolean(input.expecting);
}

export function stripBotPrefix(text: string, prefix: string): string {
  return isBotText(text, prefix) ? text.trimStart().slice(prefix.length).trimStart() : text;
}

export function helpText(): string {
  return `WHAT I CAN DO

1. 📋 LIST — open or done
2. ➕ ITEMS — add, edit, remove, or tick off
3. 📅 SCHEDULE — ping the night before and 2 hours before
4. ⏰ REMIND — set, list, or cancel
5. 🧠 FACTS — remember, list, or forget
6. ↩️ UNDO — say nvm

polls, 7-day pins, and a thursday nudge happen on their own
SAY PLUTO, or quote me`;
}

export function isHelpRequest(text: string, botNames: string[], quotedBot = false): boolean {
  const named = mentionsBot(text, botNames);
  if (!named && !quotedBot) return false;
  const rest = remainderAfterNames(text, botNames);
  if (rest === 'help') return true;
  return named && rest === 'yo help';
}

function remainderAfterNames(text: string, botNames: string[]): string {
  let rest = normalizeText(text).replace(/[?!.,]+/g, ' ');
  for (const name of botNames) {
    rest = rest.replace(new RegExp(`\\b${escapeRegExp(normalizeText(name))}\\b`, 'g'), ' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
}

export function limitReply(text: string): string {
  const cleaned = text.replace(/^[\s🐧]+/u, '').trim();
  if (!cleaned) return '';
  if (cleaned.includes('\n')) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, 2).join(' ');
}

export function typingDelayMs(text: string): number {
  return Math.min(4000, Math.max(2500, text.length * 25));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
