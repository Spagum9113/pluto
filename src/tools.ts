import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
import type { MessageKey, PlutoDb } from './db.js';
import { formatLocal, isPast, localDateTimeToUtcIso, startOfPreviousLocalDayAt19, subtractHoursIso } from './time.js';

export type ToolContext = {
  db: PlutoDb;
  actor: string;
  timezone: string;
  now?: Date;
  quotedKey?: MessageKey;
};

export type ToolResult = {
  text: string;
  react?: string;
  poll?: { name: string; values: string[] };
  pinSent?: boolean;
  pinQuoted?: boolean;
  expect?: boolean;
};

export const toolSchemas: Tool[] = [
  {
    name: 'add_item',
    description: 'Add one bucket-list item. Call again to add several. Put a place in location, not the title.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, notes: { type: 'string' }, location: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'update_item',
    description: 'Edit one item by exact id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, notes: { type: 'string' }, location: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'remove_item',
    description: 'Remove items now. Do not ask yes/no. If two or three items could match, call send_poll instead.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'] },
  },
  {
    name: 'complete_item',
    description: 'Mark an item done by exact id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'list_items',
    description: 'List items. status is open, done, or all.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'all'] } }, required: ['status'] },
  },
  {
    name: 'schedule_item',
    description: 'Schedule an item. when is Melbourne local YYYY-MM-DDTHH:mm.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, when: { type: 'string' } }, required: ['id', 'when'] },
  },
  {
    name: 'set_reminder',
    description: 'Set a one-off reminder. when is Melbourne local YYYY-MM-DDTHH:mm.',
    input_schema: { type: 'object', properties: { when: { type: 'string' }, text: { type: 'string' }, item_id: { type: 'integer' } }, required: ['when', 'text'] },
  },
  { name: 'list_reminders', description: 'List pending reminders.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_reminder', description: 'Cancel a reminder by id.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'remember_fact', description: 'Save a fact about ethan, stella, or the group.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'list_facts', description: 'List saved facts.', input_schema: { type: 'object', properties: {} } },
  { name: 'forget_fact', description: 'Forget a fact by id.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'undo_last', description: 'Undo the last list, fact, or reminder change.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'send_poll',
    description: 'Send a WhatsApp poll with 2 or 3 choices. Use this to pick a weekend item or when two or three items match. Do not also change the list.',
    input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'options'] },
  },
  {
    name: 'react',
    description: 'React to the message that triggered you. One emoji.',
    input_schema: { type: 'object', properties: { emoji: { type: 'string' } }, required: ['emoji'] },
  },
  { name: 'pin_quoted', description: 'Pin the message the person replied to, for 7 days.', input_schema: { type: 'object', properties: {} } },
];

export function executeTool(name: string, input: any, ctx: ToolContext): ToolResult {
  switch (name) {
    case 'add_item': {
      const item = ctx.db.addItem({ title: input.title, notes: input.notes, location: input.location, addedBy: ctx.actor });
      ctx.db.noteAdd(item.id);
      return { text: `added #${item.id} ${label(item)}`, react: '👍' };
    }
    case 'update_item': {
      const before = ctx.db.getItem(Number(input.id));
      const item = ctx.db.updateItem(Number(input.id), { title: input.title, notes: input.notes, location: input.location });
      if (before && item) ctx.db.setLastAction({ kind: 'update', item: before });
      return { text: item ? `updated #${item.id} ${label(item)}` : `could not find #${input.id}` };
    }
    case 'remove_item': {
      const ids = uniqueNumbers(input.ids);
      const items = ids.map((id) => ctx.db.getItem(id)).filter((item) => item && item.status !== 'removed');
      if (items.length === 0) return { text: 'nothing matching that' };
      ctx.db.setLastAction({ kind: 'remove', items: items as any });
      ctx.db.removeItems(items.map((item) => item!.id));
      return { text: items.length === 1 ? `removed #${items[0]!.id} ${label(items[0]!)}` : `removed ${items.map((item) => `#${item!.id}`).join(', ')}` };
    }
    case 'complete_item': {
      const before = ctx.db.getItem(Number(input.id));
      const item = ctx.db.completeItem(Number(input.id));
      if (before && item) ctx.db.setLastAction({ kind: 'complete', item: before });
      return { text: item ? `ticked off #${item.id} ${label(item)}` : `could not find #${input.id}`, react: item ? '✅' : undefined };
    }
    case 'list_items': {
      const items = ctx.db.listItems(input.status || 'open');
      return { text: renderItems(items, ctx.db.listItems('done').length), pinSent: true };
    }
    case 'schedule_item': {
      const before = ctx.db.getItem(Number(input.id));
      const utc = localDateTimeToUtcIso(input.when, ctx.timezone);
      if (isPast(utc, ctx.now ?? new Date())) return { text: 'that time already passed' };
      const item = ctx.db.scheduleItem(Number(input.id), utc);
      if (!item || !before) return { text: `could not find #${input.id}` };
      const reminderIds = addScheduleReminders(ctx, item.id, item.title, utc);
      ctx.db.setLastAction({ kind: 'schedule', item: before, reminderIds });
      return { text: `locked #${item.id} ${label(item)}, ${formatLocal(utc, ctx.timezone)}`, pinSent: true };
    }
    case 'set_reminder': {
      const utc = localDateTimeToUtcIso(input.when, ctx.timezone);
      if (isPast(utc, ctx.now ?? new Date())) return { text: 'that reminder already passed' };
      const reminder = ctx.db.addReminder({ fireAt: utc, text: `reminder: ${input.text}`, itemId: input.item_id ?? null });
      ctx.db.setLastAction({ kind: 'reminder', reminderId: reminder.id });
      return { text: `sure, ${formatLocal(utc, ctx.timezone)}` };
    }
    case 'list_reminders': {
      const reminders = ctx.db.listReminders();
      return { text: reminders.length ? reminders.map((r) => `#${r.id} ${formatLocal(r.fire_at, ctx.timezone)} ${r.text}`).join('\n') : 'no reminders' };
    }
    case 'cancel_reminder': {
      return { text: ctx.db.cancelReminder(Number(input.id)) ? `cancelled reminder #${input.id}` : `could not find reminder #${input.id}` };
    }
    case 'remember_fact': {
      const fact = ctx.db.addFact(input.text, ctx.actor);
      ctx.db.setLastAction({ kind: 'fact', factId: fact.id });
      return { text: 'noted' };
    }
    case 'list_facts': {
      const facts = ctx.db.listFacts();
      return { text: facts.length ? facts.map((f) => f.text).join('\n') : 'i do not know much yet' };
    }
    case 'forget_fact': {
      return { text: ctx.db.forgetFact(Number(input.id)) ? 'forgotten' : `could not find fact #${input.id}` };
    }
    case 'undo_last':
      return { text: ctx.db.undoLast() };
    case 'send_poll': {
      const options = Array.isArray(input.options) ? input.options.map(String).filter(Boolean).slice(0, 3) : [];
      if (options.length < 2) return { text: 'need at least two choices' };
      return { text: '', poll: { name: String(input.question), values: options }, expect: true };
    }
    case 'react':
      return { text: '', react: String(input.emoji || '').slice(0, 8) };
    case 'pin_quoted':
      return ctx.quotedKey ? { text: 'pinned for 7 days', pinQuoted: true } : { text: 'reply to the message you want pinned' };
    default:
      return { text: `unknown tool ${name}` };
  }
}

export function addScheduleReminders(ctx: ToolContext, itemId: number, title: string, scheduledUtc: string): number[] {
  const now = ctx.now ?? new Date();
  const ids: number[] = [];
  const nightBefore = startOfPreviousLocalDayAt19(scheduledUtc, ctx.timezone);
  const twoHours = subtractHoursIso(scheduledUtc, 2);
  if (!isPast(nightBefore, now)) ids.push(ctx.db.addReminder({ itemId, fireAt: nightBefore, text: `tomorrow ${formatLocal(scheduledUtc, ctx.timezone, { hour: 'numeric', minute: '2-digit', hour12: true })}: ${title}` }).id);
  if (!isPast(twoHours, now)) ids.push(ctx.db.addReminder({ itemId, fireAt: twoHours, text: `${title} in 2 hours` }).id);
  return ids;
}

export function renderItems(items: Array<{ id: number; title: string; location: string | null }>, doneCount: number): string {
  if (items.length === 0) return `${doneCount} done. nothing open.`;
  return [...items.map((item) => `#${item.id} ${label(item)}`), `${doneCount} done.`].join('\n');
}

function label(item: { title: string; location?: string | null }): string {
  return item.location ? `${item.title}, ${item.location}` : item.title;
}

function uniqueNumbers(values: unknown): number[] {
  return Array.isArray(values) ? [...new Set(values.map(Number).filter(Number.isFinite))] : [];
}
