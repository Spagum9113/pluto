import cron from 'node-cron';
import type { PlutoDb } from './db.js';
import { clip, log } from './log.js';
import { formatLocal, isMoreThanOneHourLate, isoWeekKey, localParts } from './time.js';

export type SendFn = (text: string) => Promise<void>;

export function dueReminderTexts(db: PlutoDb, now = new Date()): { id: number; text: string; skip: boolean }[] {
  return db.dueReminders(now.toISOString()).map((reminder) => ({
    id: reminder.id,
    text: reminder.text,
    skip: isMoreThanOneHourLate(reminder.fire_at, now),
  }));
}

export async function sendDueReminders(db: PlutoDb, send: SendFn, now = new Date()): Promise<void> {
  for (const reminder of db.dueReminders(now.toISOString())) {
    db.markReminderSent(reminder.id);
    if (isMoreThanOneHourLate(reminder.fire_at, now)) {
      log('reminder', `skipped #${reminder.id}, more than an hour late`);
      continue;
    }
    log('reminder', `sending #${reminder.id}: ${clip(reminder.text)}`);
    await send(reminder.text);
  }
}

export function buildWeeklyNudge(db: PlutoDb, now = new Date(), timezone = 'Australia/Melbourne'): string | undefined {
  const p = localParts(now, timezone);
  const weekday = p.weekday?.toLowerCase();
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  if (weekday !== 'thursday' || hour !== 19 || minute > 5) return undefined;

  const week = isoWeekKey(now, timezone);
  if (db.getSetting('last_nudge') === week) return undefined;
  if (db.hasScheduleInNextDays(7, now)) return undefined;

  const open = db.listItems('open').filter((item) => !item.scheduled_for).slice(0, 2);
  if (open.length < 2) return undefined;

  db.setSetting('last_nudge', week);
  return `nothing planned this weekend 👀\n\nhow about #${open[0].id} ${open[0].title} or #${open[1].id} ${open[1].title}`;
}

export async function sendWeeklyNudge(db: PlutoDb, send: SendFn, now = new Date(), timezone = 'Australia/Melbourne'): Promise<void> {
  const text = buildWeeklyNudge(db, now, timezone);
  if (text) {
    log('nudge', clip(text));
    await send(text);
  }
}

export function startScheduler(db: PlutoDb, send: SendFn, timezone: string): void {
  cron.schedule(
    '* * * * *',
    async () => {
      await sendDueReminders(db, send);
      await sendWeeklyNudge(db, send, new Date(), timezone);
    },
    { timezone },
  );
}

export function reminderSummary(fireAtIso: string, timezone: string): string {
  return formatLocal(fireAtIso, timezone);
}
