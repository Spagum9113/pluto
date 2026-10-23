import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlutoDb } from '../src/db.js';
import { handlePendingAnswer } from '../src/agent.js';
import { isPlutoMessage, shouldTriggerClaude } from '../src/router.js';
import { buildWeeklyNudge, dueReminderTexts } from '../src/scheduler.js';
import { addScheduleReminders } from '../src/tools.js';
import { localDateTimeToUtcIso } from '../src/time.js';

const TZ = 'Australia/Melbourne';

function tempDb(): PlutoDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pluto-test-'));
  return new PlutoDb(path.join(dir, 'bucket.db'));
}

test('trigger heuristic responds to names, actions, quotes, and pending yes/no', () => {
  assert.equal(shouldTriggerClaude({ text: 'u free sat?', botNames: ['pluto'], quotedBot: false }), false);
  assert.equal(shouldTriggerClaude({ text: 'pluto list', botNames: ['pluto'], quotedBot: false }), true);
  assert.equal(shouldTriggerClaude({ text: "what's left", botNames: ['pluto'], quotedBot: false }), true);
  assert.equal(shouldTriggerClaude({ text: 'random reply', botNames: ['pluto'], quotedBot: true }), true);
  assert.equal(shouldTriggerClaude({ text: 'yes', botNames: ['pluto'], quotedBot: false }), false);
  assert.equal(shouldTriggerClaude({ text: 'yes', botNames: ['pluto'], quotedBot: false, pending: { type: 'remove', ids: [1], requestedBy: 'jay', expiresAt: new Date(Date.now() + 60000).toISOString() } }), true);
});

test('own-number detection treats sent ids and prefix as Pluto, while Ethan is still a user', () => {
  const sentIds = { has: (id?: string | null) => id === 'pluto-id' };
  assert.equal(isPlutoMessage({ fromMe: true, id: 'pluto-id', text: 'anything' }, sentIds, '🐧 pluto: '), true);
  assert.equal(isPlutoMessage({ fromMe: true, id: 'other', text: '🐧 pluto: hello' }, sentIds, '🐧 pluto: '), true);
  assert.equal(isPlutoMessage({ fromMe: true, id: 'ethan-id', text: 'pluto list' }, sentIds, '🐧 pluto: '), false);
  assert.equal(isPlutoMessage({ fromMe: false, id: 'pluto-id', text: '🐧 pluto: echo' }, sentIds, '🐧 pluto: '), false);
});

test('melbourne local time converts to the expected UTC instant', () => {
  assert.equal(localDateTimeToUtcIso('2026-10-25T09:00', TZ), '2026-10-24T22:00:00.000Z');
});

test('schedule reminders skip past reminders and create future ones', () => {
  const db = tempDb();
  const item = db.addItem({ title: 'skydiving' });
  const now = new Date('2026-10-23T08:00:00.000Z');
  const scheduled = localDateTimeToUtcIso('2026-10-25T09:00', TZ);
  addScheduleReminders({ db, actor: 'ethan', timezone: TZ, now }, item.id, item.title, scheduled);
  const reminders = db.listReminders();
  assert.equal(reminders.length, 2);
  assert.equal(reminders[0].fire_at, '2026-10-24T08:00:00.000Z');
  assert.equal(reminders[1].fire_at, '2026-10-24T20:00:00.000Z');
});

test('overdue reminders over one hour are skipped', () => {
  const db = tempDb();
  db.addReminder({ fireAt: '2026-10-23T08:00:00.000Z', text: 'reminder: test' });
  const due = dueReminderTexts(db, new Date('2026-10-23T09:01:00.000Z'));
  assert.equal(due[0].skip, true);
});

test('weekly nudge picks two oldest open items when next seven days are empty', () => {
  const db = tempDb();
  db.addItem({ title: 'balloon' });
  db.addItem({ title: 'dumplings' });
  db.addItem({ title: 'skydive' });
  const text = buildWeeklyNudge(db, new Date('2026-10-22T08:02:00.000Z'), TZ);
  assert.match(text ?? '', /#1 balloon/);
  assert.match(text ?? '', /#2 dumplings/);
  assert.doesNotMatch(text ?? '', /#3/);
  assert.equal(buildWeeklyNudge(db, new Date('2026-10-22T08:03:00.000Z'), TZ), undefined);
});

test('soft remove waits for yes and persists through settings', () => {
  const db = tempDb();
  const item = db.addItem({ title: 'skydive' });
  db.setPendingRemove({ type: 'remove', ids: [item.id], requestedBy: 'ethan', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(handlePendingAnswer(db, 'no'), 'cool, keeping it');
  assert.equal(db.getItem(item.id)?.status, 'open');
  db.setPendingRemove({ type: 'remove', ids: [item.id], requestedBy: 'ethan', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(handlePendingAnswer(db, 'yes'), 'gone');
  assert.equal(db.getItem(item.id)?.status, 'removed');
});
