import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { PlutoDb } from './db.js';
import { executeTool, toolSchemas } from './tools.js';
import { localDateTimeForPrompt } from './time.js';
import { normalizeText } from './router.js';

export type AgentInput = {
  db: PlutoDb;
  apiKey: string;
  model: string;
  timezone: string;
  actor: string;
  text: string;
  personalityPath?: string;
  now?: Date;
};

export async function runAgent(input: AgentInput): Promise<string> {
  const quick = handlePendingAnswer(input.db, input.text);
  if (quick) return quick;

  const client = new Anthropic({ apiKey: input.apiKey });
  const messages: any[] = [{ role: 'user', content: buildUserMessage(input.db, input.text) }];
  const system = buildSystemPrompt(input);

  for (let round = 0; round < 6; round++) {
    const response: any = await client.messages.create({
      model: input.model,
      max_tokens: 900,
      system,
      tools: toolSchemas as any,
      messages,
    } as any);

    messages.push({ role: 'assistant', content: response.content });
    const toolUses = response.content.filter((block: any) => block.type === 'tool_use');
    if (toolUses.length === 0) return finalText(response.content);

    const results = [];
    for (const tool of toolUses) {
      const result = await executeTool(tool.name, tool.input ?? {}, {
        db: input.db,
        actor: input.actor,
        timezone: input.timezone,
        now: input.now,
      });
      results.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  return 'brain got stuck. try that again?';
}

export function handlePendingAnswer(db: PlutoDb, text: string): string | undefined {
  const pending = db.getPendingRemove();
  if (!pending) return undefined;
  const normalized = normalizeText(text);
  if (/^(no|nah|n)$/.test(normalized)) {
    db.clearPendingRemove();
    return 'cool, keeping it';
  }
  if (/^(yes|yep|yeah|y)$/.test(normalized)) {
    const removed = db.removeItems(pending.ids);
    db.clearPendingRemove();
    return removed.length === 1 ? 'gone' : `gone: ${removed.map((item) => `#${item.id}`).join(', ')}`;
  }
  return undefined;
}

export function buildSystemPrompt(input: AgentInput): string {
  const personality = fs.existsSync(input.personalityPath ?? 'personality.md')
    ? fs.readFileSync(input.personalityPath ?? 'personality.md', 'utf8')
    : 'you are pluto, a concise whatsapp bucket-list bot.';
  const facts = input.db.listFacts();
  const open = input.db.listItems('open');
  const pending = input.db.getPendingRemove(input.now);

  return `${personality}\n\ncurrent local time: ${localDateTimeForPrompt(input.now ?? new Date(), input.timezone)} (${input.timezone})\n\nfacts:\n${facts.length ? facts.map((f) => `#${f.id} ${f.text}`).join('\n') : '(none)'}\n\nopen items:\n${open.length ? open.map((item) => `#${item.id} ${item.title}${item.location ? `, ${item.location}` : ''}${item.scheduled_for ? ` scheduled ${item.scheduled_for}` : ''}`).join('\n') : '(none)'}\n\npending delete:\n${pending ? JSON.stringify(pending) : '(none)'}\n\nrules:\n- reply like a friend in the group, not an assistant\n- one to three short bubbles, separated by blank lines\n- use tools for every list, fact, or reminder mutation\n- for delete/remove requests, call stage_remove first and wait for yes/no\n- if a delete request matches multiple possible items, ask which item instead of staging\n- exact item numbers always\n- never invent facts, prices, web info, or calendar info\n- no web search exists in v1\n- if asked an off-topic joke/philosophy question, give a short pluto-ish answer and steer back to the bucket list`;
}

export function buildUserMessage(db: PlutoDb, newMessage: string): string {
  const lines = db.recentChat(30).map((line) => `${line.sender}: ${line.text}`).join('\n');
  return `recent chat:\n${lines || '(none)'}\n\nnew message:\n${newMessage}`;
}

function finalText(content: any[]): string {
  const text = content.filter((block) => block.type === 'text').map((block) => block.text.trim()).filter(Boolean).join('\n\n');
  return text || 'done';
}
