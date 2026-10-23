import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { PlutoDb } from './db.js';
import { executeTool, toolSchemas, type ToolResult } from './tools.js';
import { localDateTimeForPrompt } from './time.js';
import { clip, log } from './log.js';
import { limitReply } from './router.js';
import type { MessageKey } from './db.js';

export type AgentReply = {
  text: string;
  react?: string;
  poll?: { name: string; values: string[] };
  pinSent?: boolean;
  pinQuoted?: boolean;
  expect?: boolean;
};

export type AgentInput = {
  db: PlutoDb;
  apiKey: string;
  model: string;
  timezone: string;
  actor: string;
  text: string;
  personalityPath?: string;
  now?: Date;
  quotedKey?: MessageKey;
};

export async function runAgent(input: AgentInput): Promise<AgentReply> {
  log('claude', input.model);
  const client = new Anthropic({ apiKey: input.apiKey });
  const messages: any[] = [{ role: 'user', content: buildUserMessage(input.db, input.text) }];
  const system = buildSystemPrompt(input);
  const effects: ToolResult[] = [];

  for (let round = 0; round < 6; round++) {
    const response: any = await client.messages.create({
      model: input.model,
      max_tokens: 500,
      system,
      tools: toolSchemas as any,
      messages,
    } as any);

    messages.push({ role: 'assistant', content: response.content });
    const toolUses = response.content.filter((block: any) => block.type === 'tool_use');
    if (toolUses.length === 0) {
      log('claude', 'finished');
      return mergeReply(limitReply(finalText(response.content)), effects);
    }

    const results = [];
    for (const tool of toolUses) {
      log('tool', `${tool.name} ${clip(JSON.stringify(tool.input ?? {}))}`);
      const result = executeTool(tool.name, tool.input ?? {}, {
        db: input.db,
        actor: input.actor,
        timezone: input.timezone,
        now: input.now,
        quotedKey: input.quotedKey,
      });
      effects.push(result);
      log('tool', `→ ${clip(result.text || result.poll?.name || result.react || 'ok')}`);
      results.push({ type: 'tool_result', tool_use_id: tool.id, content: result.text || 'ok' });
    }
    messages.push({ role: 'user', content: results });
  }

  return mergeReply('try that again', effects);
}

export function buildSystemPrompt(input: AgentInput): string {
  const personality = fs.existsSync(input.personalityPath ?? 'personality.md')
    ? fs.readFileSync(input.personalityPath ?? 'personality.md', 'utf8')
    : 'you are pluto.';
  const facts = input.db.listFacts();
  const open = input.db.listItems('open');
  const last = input.db.getLastAction();

  return `${personality}

current local time: ${localDateTimeForPrompt(input.now ?? new Date(), input.timezone)} (${input.timezone})

facts:
${facts.length ? facts.map((f) => `#${f.id} ${f.text}`).join('\n') : '(none)'}

open items:
${open.length ? open.map((item) => `#${item.id} ${item.title}${item.location ? `, ${item.location}` : ''}${item.scheduled_for ? ` scheduled ${item.scheduled_for}` : ''}`).join('\n') : '(none)'}

last change:
${last ? JSON.stringify(last) : '(none)'}

rules:
- one message, two sentences, unless the reply is a list
- do not write a penguin or the word pluto
- use tools for every change
- nvm or undo calls undo_last
- two or three ambiguous matches: send_poll, change nothing, write no text
- no web search and no invented facts`;
}

export function buildUserMessage(db: PlutoDb, newMessage: string): string {
  const lines = db.recentChat(30).map((line) => `${line.sender}: ${line.text}`).join('\n');
  return `recent chat:\n${lines || '(none)'}\n\nnew message:\n${newMessage}`;
}

export function mergeReply(text: string, effects: ToolResult[]): AgentReply {
  const poll = effects.find((effect) => effect.poll)?.poll;
  const react = [...effects].reverse().find((effect) => effect.react)?.react;
  const toolText = [...effects].reverse().find((effect) => effect.text)?.text ?? '';
  const body = poll ? '' : limitReply(text || toolText);
  return {
    text: body,
    react,
    poll,
    pinSent: effects.some((effect) => effect.pinSent),
    pinQuoted: effects.some((effect) => effect.pinQuoted),
    expect: Boolean(poll) || effects.some((effect) => effect.expect) || body.includes('?'),
  };
}

function finalText(content: any[]): string {
  return content.filter((block) => block.type === 'text').map((block) => block.text.trim()).filter(Boolean).join(' ');
}
