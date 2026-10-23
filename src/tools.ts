import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
import type { PlutoDb } from './db.js';
import { formatLocal, isPast, localDateTimeToUtcIso, startOfPreviousLocalDayAt19, subtractHoursIso } from './time.js';

export type ToolContext = {
  db: PlutoDb;
  actor: string;
  timezone: string;
  now?: Date;
};

export const toolSchemas: Tool[] = [
  {
    name: 'add_item',
    description: 'Add one bucket-list item. Use this repeatedly for batched adds. Put place names in location when clear.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, notes: { type: 'string' }, location: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an existing non-removed bucket-list item by exact id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, title: { type: 'string' }, notes: { type: 'string' }, location: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'stage_remove',
    description: 'Stage removal and ask for yes/no. Use before remove_item for any delete request, including delete everything.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'] },
  },
  {
    name: 'remove_item',
    description: 'Remove items only after the user says yes to a staged removal.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'] },
  },
  {
    name: 'complete_item',
    description: 'Mark a bucket-list item done by exact id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'list_items',
    description: 'List items by status.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'all'] } }, required: ['status'] },
  },
  {
    name: 'schedule_item',
    description: 'Set a scheduled date/time for an item. when must be Melbourne local YYYY-MM-DDTHH:mm.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, when: { type: 'string' } }, required: ['id', 'when'] },
  },
  {
    name: 'set_reminder',
    description: 'Set a one-off reminder. when must be Melbourne local YYYY-MM-DDTHH:mm.',
    input_schema: {
      type: 'object',
      properties: { when: { type: 'string' }, text: { type: 'string' }, item_id: { type: 'integer' } },
      required: ['when', 'text'],
    },
  },
  { name: 'list_reminders', description: 'List pending reminders.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_reminder', description: 'Cancel a pending reminder by id.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'remember_fact', description: 'Save a stable fact about Ethan, the cousin, preferences, constraints, or the group.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'list_facts', description: 'List saved facts.', input_schema: { type: 'object', properties: {} } },
  { name: 'forget_fact', description: 'Forget a saved fact by id.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
];

export async function executeTool(name: string, input: any, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'add_item': {
      const item = ctx.db.addItem({ title: input.title, notes: input.notes, location: input.location, addedBy: ctx.actor });
      return `added #${item.id} ${label(item)}`;
    }
    case 'update_item': {
      const item = ctx.db.updateItem(Number(input.id), { title: input.title, notes: input.notes, location: input.location });
      return item ? `updated #${item.id} → ${label(item)}` : `could not find #${input.id}`;
    }
    case 'stage_remove': {
      const ids = uniqueNumbers(input.ids);
      const items = ids.map((id) => ctx.db.getItem(id)).filter(Boolean) as any[];
      if (items.length === 0) return 'nothing matching that to remove';
      ctx.db.setPendingRemove({ type: 'remove', ids: items.map((item) => item.id), requestedBy: ctx.actor, expiresAt: new Date((ctx.now ?? new Date()).getTime() + 15 * 60000).toISOString() });
      if (items.length === 1) return `removing #${items[0].id} ${label(items[0])}. sure? (yes/no)`;
      return `removing ${items.map((item) => `#${item.id} ${label(item)}`).join(', ')}. sure? (yes/no)`;
    }
    case 'remove_item': {
      const ids = uniqueNumbers(input.ids);
      const removed = ctx.db.removeItems(ids);
      ctx.db.clearPendingRemove();
      if (removed.length === 0) return 'nothing removed';
      return removed.length === 1 ? 'gone' : `gone: ${removed.map((item) => `#${item.id}`).join(', ')}`;
    }
    case 'complete_item': {
      const item = ctx.db.completeItem(Number(input.id));
      return item ? `ticked off #${item.id} ${label(item)} ✅` : `could not find #${input.id}`;
    }
    case 'list_items': {
      const items = ctx.db.listItems(input.status || 'open');
      return renderItems(items, ctx.db.listItems('done').length);
    }
    case 'schedule_item': {
      const utc = localDateTimeToUtcIso(input.when, ctx.timezone);
      if (isPast(utc, ctx.now ?? new Date())) return 'that time is in the past, so i skipped it';
      const item = ctx.db.scheduleItem(Number(input.id), utc);
      if (!item) return `could not find #${input.id}`;
      addScheduleReminders(ctx, item.id, item.title, utc);
      return `locked: #${item.id} ${label(item)}, ${formatLocal(utc, ctx.timezone)}\ni'll remind you the night before and 2 hours before`;
    }
    case 'set_reminder': {
      const utc = localDateTimeToUtcIso(input.when, ctx.timezone);
      if (isPast(utc, ctx.now ?? new Date())) return 'that reminder is in the past, so i skipped it';
      ctx.db.addReminder({ fireAt: utc, text: `reminder: ${input.text}`, itemId: input.item_id ?? null });
      return `sure, ${formatLocal(utc, ctx.timezone)}`;
    }
    case 'list_reminders': {
      const reminders = ctx.db.listReminders();
      return reminders.length ? reminders.map((r) => `#${r.id} ${formatLocal(r.fire_at, ctx.timezone)} — ${r.text}`).join('\n') : 'no pending reminders';
    }
    case 'cancel_reminder': {
      return ctx.db.cancelReminder(Number(input.id)) ? `cancelled reminder #${input.id}` : `could not find reminder #${input.id}`;
    }
    case 'remember_fact': {
      const fact = ctx.db.addFact(input.text, ctx.actor);
      return `noted fact #${fact.id}: ${fact.text}`;
    }
    case 'list_facts': {
      const facts = ctx.db.listFacts();
      return facts.length ? facts.map((f) => `#${f.id} ${f.text}`).join('\n') : 'i do not know much yet';
    }
    case 'forget_fact': {
      return ctx.db.forgetFact(Number(input.id)) ? 'forgotten' : `could not find fact #${input.id}`;
    }
    default:
      return `unknown tool ${name}`;
  }
}

export function addScheduleReminders(ctx: ToolContext, itemId: number, title: string, scheduledUtc: string): void {
  const now = ctx.now ?? new Date();
  const nightBefore = startOfPreviousLocalDayAt19(scheduledUtc, ctx.timezone);
  const twoHours = subtractHoursIso(scheduledUtc, 2);
  if (!isPast(nightBefore, now)) ctx.db.addReminder({ itemId, fireAt: nightBefore, text: `tomorrow ${formatLocal(scheduledUtc, ctx.timezone, { hour: 'numeric', minute: '2-digit', hour12: true })}: ${title}` });
  if (!isPast(twoHours, now)) ctx.db.addReminder({ itemId, fireAt: twoHours, text: `${title} in 2 hours` });
}

export function renderItems(items: Array<{ id: number; title: string; location: string | null; scheduled_for?: string | null }>, doneCount: number): string {
  if (items.length === 0) return `${doneCount} done. nothing open right now`;
  return [`bucket list 🪣`, ...items.map((item) => `#${item.id} ${label(item)}`), `${doneCount} done`].join('\n');
}

function label(item: { title: string; location?: string | null }): string {
  return item.location ? `${item.title}, ${item.location}` : item.title;
}

function uniqueNumbers(values: unknown): number[] {
  return Array.isArray(values) ? [...new Set(values.map(Number).filter(Number.isFinite))] : [];
}
