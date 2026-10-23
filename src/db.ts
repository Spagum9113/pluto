import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nowUtc } from './time.js';

export type ItemStatus = 'open' | 'done' | 'removed';

export type Item = {
  id: number;
  title: string;
  notes: string | null;
  location: string | null;
  status: ItemStatus;
  scheduled_for: string | null;
  added_by: string | null;
  created_at: string;
  completed_at: string | null;
};

export type Fact = { id: number; text: string; added_by: string | null; created_at: string };
export type Reminder = { id: number; item_id: number | null; fire_at: string; text: string; sent: number };
export type ChatLine = { id: number; sender: string; text: string; from_bot: number; at: string };
export type PendingRemove = { type: 'remove'; ids: number[]; requestedBy: string; expiresAt: string };

export class PlutoDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT,
        location TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        scheduled_for TEXT,
        added_by TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        added_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY,
        item_id INTEGER,
        fire_at TEXT NOT NULL,
        text TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_log (
        id INTEGER PRIMARY KEY,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        from_bot INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sent_ids (
        msg_id TEXT PRIMARY KEY,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  getGroupJid(): string | undefined {
    return this.getSetting('group_jid');
  }

  bindGroup(jid: string): void {
    this.setSetting('group_jid', jid);
  }

  addSentId(msgId: string, at = nowUtc()): void {
    this.db.prepare('INSERT OR IGNORE INTO sent_ids(msg_id, at) VALUES(?, ?)').run(msgId, at);
  }

  isSentByPluto(msgId?: string | null): boolean {
    if (!msgId) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM sent_ids WHERE msg_id = ?').get(msgId));
  }

  addChatLine(sender: string, text: string, fromBot: boolean, at = nowUtc()): void {
    this.db.prepare('INSERT INTO chat_log(sender, text, from_bot, at) VALUES(?, ?, ?, ?)').run(sender, text, fromBot ? 1 : 0, at);
  }

  recentChat(limit = 30): ChatLine[] {
    return this.db.prepare('SELECT * FROM chat_log ORDER BY id DESC LIMIT ?').all(limit).reverse() as ChatLine[];
  }

  addItem(input: { title: string; notes?: string; location?: string; addedBy?: string }): Item {
    const info = this.db.prepare('INSERT INTO items(title, notes, location, status, added_by, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(input.title.trim(), input.notes ?? null, input.location ?? null, 'open', input.addedBy ?? null, nowUtc());
    return this.getItem(Number(info.lastInsertRowid))!;
  }

  getItem(id: number): Item | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
  }

  listItems(status: 'open' | 'done' | 'all' = 'open'): Item[] {
    if (status === 'all') return this.db.prepare("SELECT * FROM items WHERE status != 'removed' ORDER BY id").all() as Item[];
    return this.db.prepare('SELECT * FROM items WHERE status = ? ORDER BY id').all(status) as Item[];
  }

  updateItem(id: number, patch: { title?: string; notes?: string | null; location?: string | null }): Item | undefined {
    const item = this.getItem(id);
    if (!item || item.status === 'removed') return undefined;
    this.db.prepare('UPDATE items SET title = ?, notes = ?, location = ? WHERE id = ?')
      .run(patch.title?.trim() || item.title, patch.notes === undefined ? item.notes : patch.notes, patch.location === undefined ? item.location : patch.location, id);
    return this.getItem(id);
  }

  removeItems(ids: number[]): Item[] {
    const items = ids.map((id) => this.getItem(id)).filter((x): x is Item => Boolean(x));
    const stmt = this.db.prepare("UPDATE items SET status = 'removed' WHERE id = ? AND status != 'removed'");
    const tx = this.db.transaction((xs: Item[]) => xs.forEach((item) => stmt.run(item.id)));
    tx(items);
    return items;
  }

  completeItem(id: number): Item | undefined {
    const item = this.getItem(id);
    if (!item || item.status === 'removed') return undefined;
    this.db.prepare("UPDATE items SET status = 'done', completed_at = ? WHERE id = ?").run(nowUtc(), id);
    return this.getItem(id);
  }

  scheduleItem(id: number, scheduledForUtc: string): Item | undefined {
    const item = this.getItem(id);
    if (!item || item.status === 'removed') return undefined;
    this.db.prepare("UPDATE items SET status = 'open', scheduled_for = ? WHERE id = ?").run(scheduledForUtc, id);
    return this.getItem(id);
  }

  addReminder(input: { fireAt: string; text: string; itemId?: number | null }): Reminder {
    const info = this.db.prepare('INSERT INTO reminders(item_id, fire_at, text, sent) VALUES(?, ?, ?, 0)').run(input.itemId ?? null, input.fireAt, input.text);
    return this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid) as Reminder;
  }

  listReminders(includeSent = false): Reminder[] {
    return this.db.prepare(`SELECT * FROM reminders ${includeSent ? '' : 'WHERE sent = 0'} ORDER BY fire_at`).all() as Reminder[];
  }

  cancelReminder(id: number): boolean {
    const info = this.db.prepare('UPDATE reminders SET sent = 1 WHERE id = ? AND sent = 0').run(id);
    return info.changes > 0;
  }

  dueReminders(nowIso: string): Reminder[] {
    return this.db.prepare('SELECT * FROM reminders WHERE sent = 0 AND fire_at <= ? ORDER BY fire_at').all(nowIso) as Reminder[];
  }

  markReminderSent(id: number): void {
    this.db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
  }

  addFact(text: string, addedBy?: string): Fact {
    const info = this.db.prepare('INSERT INTO facts(text, added_by, created_at) VALUES(?, ?, ?)').run(text.trim(), addedBy ?? null, nowUtc());
    return this.db.prepare('SELECT * FROM facts WHERE id = ?').get(info.lastInsertRowid) as Fact;
  }

  listFacts(): Fact[] {
    return this.db.prepare('SELECT * FROM facts ORDER BY id').all() as Fact[];
  }

  forgetFact(id: number): boolean {
    const info = this.db.prepare('DELETE FROM facts WHERE id = ?').run(id);
    return info.changes > 0;
  }

  setPendingRemove(pending: PendingRemove): void {
    this.setSetting('pending', JSON.stringify(pending));
  }

  getPendingRemove(now = new Date()): PendingRemove | undefined {
    const raw = this.getSetting('pending');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PendingRemove;
    if (new Date(parsed.expiresAt).getTime() <= now.getTime()) {
      this.deleteSetting('pending');
      return undefined;
    }
    return parsed;
  }

  clearPendingRemove(): void {
    this.deleteSetting('pending');
  }

  hasScheduleInNextDays(days: number, now = new Date()): boolean {
    const until = new Date(now.getTime() + days * 86400000).toISOString();
    const row = this.db.prepare("SELECT 1 FROM items WHERE status != 'removed' AND scheduled_for IS NOT NULL AND scheduled_for >= ? AND scheduled_for <= ? LIMIT 1")
      .get(now.toISOString(), until);
    return Boolean(row);
  }
}
