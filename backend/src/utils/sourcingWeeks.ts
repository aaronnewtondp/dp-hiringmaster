// Weekly performance tracker for a tracked channel (LinkedIn / Naukri/IIMjobs / Direct Outreach) — pure date math, unit-tested.
//
// The tracker starts the day the channel's post is logged (`anchor`, an IST date) and runs in consecutive 7-day windows:
// window k = anchor + 7k … anchor + 7k + 6 (both ends inclusive, IST calendar days). A window is FINISHED once its last day has
// ended, i.e. today is after `end`. Each finished window is compared with the weekly target: actual >= target is met (green),
// anything less is missed (red). `actual` is every application to the role tagged with the channel on the application form,
// qualified or not.
import { addCalendarDays } from './workingDays.js';

export interface WeekWindow { start: string; end: string }
export interface DayCount { n: number; q: number }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d: unknown): d is string => typeof d === 'string' && DATE_RE.test(d);

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000);
}

/** Every window that has already finished by `today`, oldest first. Empty for a bad date or an anchor that is today or later. */
export function completedWindows(anchor: string, today: string, max = 120): WeekWindow[] {
  if (!isDate(anchor) || !isDate(today)) return [];
  const out: WeekWindow[] = [];
  for (let k = 0; k < max; k++) {
    const start = addCalendarDays(anchor, 7 * k);
    const end = addCalendarDays(start, 6);
    if (end >= today) break;
    out.push({ start, end });
  }
  return out;
}

/** The window that contains `today` (the week in progress), or null when the tracker has not started. */
export function currentWindow(anchor: string, today: string): WeekWindow | null {
  if (!isDate(anchor) || !isDate(today) || anchor > today) return null;
  const k = Math.floor(daysBetween(anchor, today) / 7);
  const start = addCalendarDays(anchor, 7 * k);
  return { start, end: addCalendarDays(start, 6) };
}

/** Sum the per-day counts that fall inside a window (inclusive). */
export function sumWindow(byDay: ReadonlyMap<string, DayCount>, w: WeekWindow): { actual: number; qualified: number } {
  let actual = 0, qualified = 0;
  for (const [day, c] of byDay) {
    if (day >= w.start && day <= w.end) { actual += c.n; qualified += c.q; }
  }
  return { actual, qualified };
}

export function isTargetMet(actual: number, target: number): boolean { return actual >= target; }

/** The tracker must never start before the day after the last finished week of an earlier run (a channel closed and reopened). */
export function effectiveAnchor(anchor: string, lastEnd: string | null): string {
  if (!lastEnd || !isDate(lastEnd)) return anchor;
  const next = addCalendarDays(lastEnd, 1);
  return next > anchor ? next : anchor;
}

/**
 * The week in progress, cut short because the channel stopped being measured (closed, left out, the role put on hold or closed): from
 * the start of the week in progress up to and including `stopDate`. Always partial — the day it stops has not ended, so even a stop on the
 * week's last day is not a finished week. Null when the week has not started yet or `stopDate` precedes it.
 */
export function partialWindow(anchor: string, stopDate: string): { window: WeekWindow; partial: true } | null {
  const w = currentWindow(anchor, stopDate);
  if (!w) return null;
  const end = stopDate < w.end ? stopDate : w.end;
  return { window: { start: w.start, end }, partial: true };
}

export interface WeekRow { target: number; actual: number; met: boolean; partial?: boolean }
/** Totals over the FINISHED weeks. A week cut short is shown in the list but is neither a tracked week nor a miss, so it is left out here. */
export function summarizeWeeks(rows: WeekRow[]): { weeks: number; met: number; actual: number; target: number } {
  return rows.filter(r => !r.partial).reduce((t, r) => ({ weeks: t.weeks + 1, met: t.met + (r.met ? 1 : 0), actual: t.actual + r.actual, target: t.target + r.target }),
    { weeks: 0, met: 0, actual: 0, target: 0 });
}
