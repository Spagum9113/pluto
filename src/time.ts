export function utcIso(date = new Date()): string {
  return date.toISOString();
}

export function nowUtc(): string {
  return utcIso(new Date());
}

export function localParts(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(date);

  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const localAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return localAsUtc - date.getTime();
}

export function localDateTimeToUtcIso(local: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) throw new Error(`Expected local datetime YYYY-MM-DDTHH:mm, got ${local}`);
  const [, y, mo, d, h, mi] = match;
  const naiveUtc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0));
  const first = new Date(naiveUtc.getTime() - timeZoneOffsetMs(naiveUtc, timezone));
  const second = new Date(naiveUtc.getTime() - timeZoneOffsetMs(first, timezone));
  return second.toISOString();
}

export function formatLocal(iso: string, timezone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...opts,
  })
    .format(new Date(iso))
    .replace(/:00\s/g, ' ')
    .toLowerCase();
}

export function localDateTimeForPrompt(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${p.weekday}, ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function startOfPreviousLocalDayAt19(scheduledUtcIso: string, timezone: string): string {
  const date = new Date(scheduledUtcIso);
  const p = localParts(date, timezone);
  const localNoon = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12, 0, 0));
  localNoon.setUTCDate(localNoon.getUTCDate() - 1);
  const prev = localParts(localNoon, timezone);
  return localDateTimeToUtcIso(`${prev.year}-${prev.month}-${prev.day}T19:00`, timezone);
}

export function subtractHoursIso(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() - hours * 60 * 60 * 1000).toISOString();
}

export function isMoreThanOneHourLate(fireAtIso: string, now = new Date()): boolean {
  return now.getTime() - new Date(fireAtIso).getTime() > 60 * 60 * 1000;
}

export function isPast(iso: string, now = new Date()): boolean {
  return new Date(iso).getTime() <= now.getTime();
}

export function isoWeekKey(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  const local = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((local.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
