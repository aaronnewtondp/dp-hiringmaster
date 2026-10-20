// Working-day math for the Sourcing module (Asia/Kolkata, no DST).
//
// None existed before this: every SLA elsewhere in HMS is wall-clock hours and dates are
// UTC-sliced. The SOP's "within 1 working day of approval" needs a real calendar, so this is
// a small pure helper — Mon–Fri by default with a configurable weekend. Public holidays are
// deliberately NOT modelled (Aaron, 2026-10-19: not worth the complexity). All "dates" are plain
// 'YYYY-MM-DD' strings in IST so they round-trip through DATE columns without timezone drift.

const IST_OFFSET_MS = 330 * 60 * 1000; // +05:30, India has no DST

export interface WorkingCalendar {
  /** JS weekday numbers treated as non-working (0 = Sunday … 6 = Saturday). Default [0, 6]. */
  weekend?: number[];
}

export const DEFAULT_CALENDAR: Required<WorkingCalendar> = { weekend: [0, 6] };

function cal(c?: WorkingCalendar): Required<WorkingCalendar> {
  return { weekend: c?.weekend ?? DEFAULT_CALENDAR.weekend };
}

/** The IST calendar date ('YYYY-MM-DD') a given instant falls on. */
export function istDate(d: Date | string | number): string {
  const ms = (d instanceof Date ? d : new Date(d)).getTime() + IST_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse an IST 'YYYY-MM-DD' to a UTC-noon Date used purely for weekday/day arithmetic. */
function dayAnchor(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`);
}

export function weekdayOf(dateStr: string): number {
  return dayAnchor(dateStr).getUTCDay();
}

export function addCalendarDays(dateStr: string, n: number): string {
  const d = dayAnchor(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWorkingDay(dateStr: string, c?: WorkingCalendar): boolean {
  const k = cal(c);
  return !k.weekend.includes(weekdayOf(dateStr));
}

/**
 * The date `n` working days after `from` (exclusive of `from` itself). n = 0 returns `from`
 * unchanged even when it is not a working day. Negative n walks backwards.
 */
export function addWorkingDays(from: string, n: number, c?: WorkingCalendar): string {
  let cur = from;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  // Bounded: a calendar that marks every weekday a weekend must not loop forever.
  let guard = 0;
  while (left > 0 && guard++ < 3660) {
    cur = addCalendarDays(cur, step);
    if (isWorkingDay(cur, c)) left--;
  }
  return cur;
}

/** Working days in the half-open interval (from, to] — 0 when to <= from. */
export function workingDaysBetween(from: string, to: string, c?: WorkingCalendar): number {
  if (to <= from) return 0;
  let n = 0;
  let cur = from;
  let guard = 0;
  while (cur < to && guard++ < 3660) {
    cur = addCalendarDays(cur, 1);
    if (isWorkingDay(cur, c)) n++;
  }
  return n;
}

/** The last `n` working days up to and including `today` (or the most recent working day), oldest first. */
export function lastWorkingDays(today: string, n: number, c?: WorkingCalendar): string[] {
  const out: string[] = [];
  let cur = today;
  let guard = 0;
  while (out.length < n && guard++ < 3660) {
    if (isWorkingDay(cur, c)) out.unshift(cur);
    cur = addCalendarDays(cur, -1);
  }
  return out;
}

/** End of the given IST day (23:59:59.999 IST) as an instant — commitments are overdue only once their due *day* has ended. */
export function endOfIstDay(dateStr: string): Date {
  return new Date(new Date(`${dateStr}T23:59:59.999Z`).getTime() - IST_OFFSET_MS);
}

/** Monday of the IST week containing `dateStr` (weeks run Mon–Sun for the weekly outbound target). */
export function mondayOf(dateStr: string): string {
  const wd = weekdayOf(dateStr); // 0 = Sun
  return addCalendarDays(dateStr, -((wd + 6) % 7));
}
