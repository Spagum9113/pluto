export function log(area: string, message: string): void {
  const time = new Intl.DateTimeFormat('en-AU', {
    timeZone: process.env.TIMEZONE || 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
  console.log(`${time}  ${area.padEnd(9)} ${message}`);
}

export function clip(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
