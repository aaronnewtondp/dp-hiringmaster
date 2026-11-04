/**
 * Dates computed from the REAL clock at run time, so no spec carries a hard-coded date that silently becomes "the past" one day
 * (the old fixed 2027-01-15 / 02-01 / 02-10 / 03-15 values) and no spec pins an exact instant by accident.
 *
 *   futureIso(30)                                        '2026-12-03T14:07:11.482Z'   exactly now + 30 days
 *   futureIso(30, { hour: 10, offset: '+05:30' })        '2026-12-03T10:00:00+05:30'  10:00 IST on the IST date 30 days from now
 *   futureLocalDateTime(30, { hour: 11 })                '2026-12-03T11:00'           the value of an <input type="datetime-local">
 *   pastIso(3)                                           '2026-10-31T14:07:11.482Z'   exactly now - 3 days
 *   futureDateOnly(60)                                   '2027-01-02'                 a <input type="date"> / DATE column value (UTC date)
 *   futureDateOnly(60, { offset: '+05:30' })                                          the same, as the IST calendar date
 *
 * `offset` is 'Z' (default) or '+HH:MM' / '-HH:MM'. Fixed offsets only: there is no DST arithmetic here on purpose.
 */

const DAY_MS = 86_400_000;

export interface IsoOptions {
  /** Wall-clock hour (0-23) in `offset`. Giving `hour` (or `minute`) fixes the time of day; omitting both keeps the current instant. */
  hour?: number;
  /** Wall-clock minute (0-59), default 0 when `hour` is given. */
  minute?: number;
  /** 'Z' (default) or '+HH:MM' / '-HH:MM'. */
  offset?: string;
}

function offsetMinutes(offset: string): number {
  if (offset === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) throw new Error(`dates.ts: offset must be 'Z' or '+HH:MM' / '-HH:MM', got '${offset}'`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const two = (n: number) => String(n).padStart(2, '0');

/** The calendar date (YYYY-MM-DD) that it is in `offset` right now plus `days` whole days. */
function zonedDate(days: number, offset: string): string {
  const shifted = new Date(Date.now() + offsetMinutes(offset) * 60_000 + days * DAY_MS);
  return `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}`;
}

/** now + `days` days (negative = past) as an ISO-8601 string; with `hour` / `minute` the time of day is fixed in `offset`. */
export function futureIso(days: number, opts: IsoOptions = {}): string {
  if (opts.hour === undefined && opts.minute === undefined) {
    return new Date(Date.now() + days * DAY_MS).toISOString();
  }
  const offset = opts.offset ?? 'Z';
  return `${zonedDate(days, offset)}T${two(opts.hour ?? 0)}:${two(opts.minute ?? 0)}:00${offset}`;
}

/** now - `days` days as an ISO-8601 string (same options as futureIso). */
export function pastIso(days: number, opts: IsoOptions = {}): string {
  return futureIso(-days, opts);
}

/** YYYY-MM-DD, `days` days from today (UTC calendar date, or the calendar date in `opts.offset`). */
export function futureDateOnly(days: number, opts: { offset?: string } = {}): string {
  return zonedDate(days, opts.offset ?? 'Z');
}

/** YYYY-MM-DD, `days` days before today. */
export function pastDateOnly(days: number, opts: { offset?: string } = {}): string {
  return futureDateOnly(-days, opts);
}

/**
 * 'YYYY-MM-DDTHH:mm' — what an `<input type="datetime-local">` takes and shows: no zone, the browser's own local time. The app turns it
 * into an instant using the BROWSER's zone, so assert against that zone (see tests/e2e/06-schedule-round.spec.ts), not against UTC.
 */
export function futureLocalDateTime(days: number, opts: { hour?: number; minute?: number } = {}): string {
  const base = new Date(Date.now() + days * DAY_MS);
  const date = `${base.getFullYear()}-${two(base.getMonth() + 1)}-${two(base.getDate())}`;
  return `${date}T${two(opts.hour ?? 10)}:${two(opts.minute ?? 0)}`;
}
