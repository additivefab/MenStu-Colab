export const OVERVIEW_TIMEZONE = "Asia/Shanghai" as const;

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

function parsedInstant(value: string | Date) {
  if (value instanceof Date) return value;
  if (dateKeyPattern.test(value)) return new Date(`${value}T12:00:00+08:00`);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized);
}

export function instantTimestamp(value: string | Date) {
  return parsedInstant(value).getTime();
}

export function shanghaiDateKey(value: string | Date) {
  if (typeof value === "string" && dateKeyPattern.test(value)) return value;
  const date = parsedInstant(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: OVERVIEW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function utcDay(dateKey: string) {
  if (!dateKeyPattern.test(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  const normalized = new Date(value).toISOString().slice(0, 10);
  return normalized === dateKey ? value : null;
}

export function calendarDayDiff(laterDate: string, earlierDate: string) {
  const later = utcDay(laterDate);
  const earlier = utcDay(earlierDate);
  if (later === null || earlier === null) return null;
  return Math.round((later - earlier) / 86_400_000);
}

export function isOverdueInShanghai(dueDate: string | null, now: string | Date) {
  if (!dueDate || !dateKeyPattern.test(dueDate)) return false;
  const today = shanghaiDateKey(now);
  const daysPastDue = today ? calendarDayDiff(today, dueDate) : null;
  return daysPastDue !== null && daysPastDue > 0;
}

export function daysSinceInShanghai(value: string | null, now: string | Date) {
  if (!value) return null;
  const today = shanghaiDateKey(now);
  const occurred = shanghaiDateKey(value);
  if (!today || !occurred) return null;
  const difference = calendarDayDiff(today, occurred);
  return difference === null ? null : Math.max(0, difference);
}

export function shanghaiWeekStart(now: string | Date) {
  const today = shanghaiDateKey(now);
  if (!today) return null;
  const utc = utcDay(today);
  if (utc === null) return null;
  const day = new Date(utc).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  return new Date(utc - daysFromMonday * 86_400_000).toISOString().slice(0, 10);
}

export function isInCurrentShanghaiWeek(value: string | null, now: string | Date) {
  if (!value) return false;
  const occurred = shanghaiDateKey(value);
  const today = shanghaiDateKey(now);
  const start = shanghaiWeekStart(now);
  return Boolean(occurred && today && start && occurred >= start && occurred <= today);
}
