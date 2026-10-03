export function nowIso(): string {
  return new Date().toISOString();
}

export function toIsoString(value: string | null | undefined, fallback = nowIso()): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

export function daysFromNow(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}
