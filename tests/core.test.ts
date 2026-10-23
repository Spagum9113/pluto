import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlutoDb } from '../src/db.js';
import { helpText, isHelpRequest, isPlutoMessage, shouldTriggerClaude, typingDelayMs } from '../src/router.js';
import { buildWeeklyNudge, dueReminderTexts } from '../src/scheduler.js';
import { addScheduleReminders, executeTool } from '../src/tools.js';
import { localDateTimeToUtcIso } from '../src/time.js';

const TZ = 'Australia/Melbourne';

function tempDb(): PlutoDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pluto-test-'));
  return new PlutoDb(path.join(dir, 'bucket.db'));
}

test('trigger answers to pluto, quotes, and an open question only', () => {
  assert.equal(shouldTriggerClaude({ text: 'u free sat?', botNames: ['pluto'], quotedBot: false }), false);
  assert.equal(shouldTriggerClaude({ text: 'add skydiving', botNames: ['pluto'], quotedBot: false }), false);
  assert.equal(shouldTriggerClaude({ text: "what's left", botNames: ['pluto'], quotedBot: false }), false);
  assert.equal(shouldTriggerClaude({ text: 'yo pluto add the balloon', botNames: ['pluto'], quotedBot: false }), true);
  assert.equal(shouldTriggerClaude({ text: 'the balloon one', botNames: ['pluto'], quotedBot: true }), true);
  assert.equal(shouldTriggerClaude({ text: 'the balloon one', botNames: ['pluto'], quotedBot: false, expecting: true }), true);
  assert.equal(shouldTriggerClaude({ text: 'yeah after 2', botNames: ['pluto'], quotedBot: false, quotedSomeoneElse: true, expecting: true }), false);
  assert.equal(shouldTriggerClaude({ text: 'pluto add it', botNames: ['pluto'], quotedBot: false, quotedSomeoneElse: true }), true);
  assert.equal(typingDelayMs('hi'), 2500);
  assert.equal(typingDelayMs('x'.repeat(200)), 4000);
});

test('own-number detection treats sent ids and prefix as Pluto, while Ethan is still a user', () => {
  const sentIds = { has: (id?: string | null) => id === 'pluto-id' };
  assert.equal(isPlutoMessage({ fromMe: true, id: 'pluto-id', text: 'anything' }, sentIds, '🐧 '), true);
  assert.equal(isPlutoMessage({ fromMe: true, id: 'other', text: '🐧 hello' }, sentIds, '🐧 '), true);
  assert.equal(isPlutoMessage({ fromMe: true, id: 'ethan-id', text: 'pluto list' }, sentIds, '🐧 '), false);
  assert.equal(isPlutoMessage({ fromMe: false, id: 'pluto-id', text: '🐧 echo' }, sentIds, '🐧 '), false);
});

test('pluto help is a fixed list, and other help lines are not', () => {
  assert.equal(isHelpRequest('pluto help', ['pluto']), true);
  assert.equal(isHelpRequest('yo pluto help', ['pluto']), true);
  assert.equal(isHelpRequest('pluto help?', ['pluto']), true);
  assert.equal(isHelpRequest('pluto help me pick', ['pluto']), false);
  assert.equal(isHelpRequest('help', ['pluto']), false);
  assert.equal(isHelpRequest('help', ['pluto'], true), true);
  assert.equal(isHelpRequest('the balloon', ['pluto'], true), false);
  const text = helpText();
  assert.match(text, /^WHAT I CAN DO\n\n1\. 📋 LIST — open or done/);
  assert.match(text, /6\. ↩️ UNDO — say nvm/);
  assert.match(text, /polls, 7-day pins, and a thursday nudge happen on their own/);
  assert.match(text, /SAY PLUTO, or quote me$/);
  assert.equal(text.includes('🐧'), false);
});

test('an open item with the same title is not added again', () => {
  const db = tempDb();
  const first = db.addItem({ title: 'Hot Air Balloon', location: 'yarra valley' });
  const again = executeTool('add_item', { title: '  hot air balloon  ', location: 'somewhere else' }, { db, actor: 'ethan', timezone: TZ });
  assert.equal(again.text, 'already #1 Hot Air Balloon, yarra valley');
  assert.equal(again.react, undefined);
  assert.equal(db.listItems('open').length, 1);
  db.completeItem(first.id);
  const redo = executeTool('add_item', { title: 'hot air balloon' }, { db, actor: 'ethan', timezone: TZ });
  assert.equal(redo.text, 'added #2 hot air balloon');
  assert.equal(db.listItems('open').length, 1);
  db.removeItems([2]);
  const afterRemove = executeTool('add_item', { title: 'hot air balloon' }, { db, actor: 'ethan', timezone: TZ });
  assert.equal(afterRemove.text, 'added #3 hot air balloon');
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

test('undo puts the last add back and an open question expires', () => {
  const db = tempDb();
  const item = db.addItem({ title: 'skydive' });
  db.noteAdd(item.id);
  assert.equal(db.undoLast(), 'removed #1');
  assert.equal(db.getItem(item.id)?.status, 'removed');
  assert.equal(db.isExpecting(new Date()), false);
  db.setExpectingUntil(new Date(Date.now() + 60_000).toISOString());
  assert.equal(db.isExpecting(new Date()), true);
  db.setExpectingUntil(new Date(Date.now() - 1000).toISOString());
  assert.equal(db.isExpecting(new Date()), false);
});
