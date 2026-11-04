import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeAging } from './aging.js';

const DAY = 86400000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

// computeAging reads the clock itself, and the fixtures here are calendar dates (midnight UTC), so the answers must not depend on WHEN the suite runs: it
// used to read the real clock twice (once in the fixture, once in the code), which failed when a run crossed midnight UTC between the two reads, and a day
// count that is right at noon could be one off at 23:59 if the code ever mixed up "date" and "instant". The clock is frozen, and the whole file is run at
// three times of day, including the first and last millisecond of a UTC day.
const NOON = '2026-03-15T12:00:00.000Z';
const TIMES_OF_DAY = [['the first millisecond of a UTC day', '2026-03-15T00:00:00.000Z'], ['noon', NOON], ['the last millisecond of a UTC day', '2026-03-15T23:59:59.999Z']] as const;

describe.each(TIMES_OF_DAY)('computeAging at %s', (_label, now) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });
  agingSuite();
});

describe('computeAging — the clock is the one that was set', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('days_open follows the faked clock, a day at a time, and is the same at every time of day', () => {
    vi.useFakeTimers();
    for (const time of ['2026-03-15T00:00:00.000Z', '2026-03-15T23:59:59.999Z']) {
      vi.setSystemTime(new Date(time));
      expect(computeAging('2026-03-05', null, 'P0', 'Approved').days_open).toBe(10);
    }
    vi.setSystemTime(new Date('2026-03-16T00:00:00.000Z'));       // the next UTC midnight: one more day
    expect(computeAging('2026-03-05', null, 'P0', 'Approved').days_open).toBe(11);
  });
});

function agingSuite() {
  it('never alerts for a status outside Approved/Live – Sourcing, regardless of dates', () => {
    for (const status of ['Draft', 'Under Review', 'On Hold', 'Closed – Filled', 'Closed – Cancelled']) {
      const result = computeAging(iso(200 * DAY), iso(100 * DAY), 'P0', status);
      expect(result.aging_alert).toBe('ok');
      expect(result.days_overdue).toBe(0);
    }
  });

  it('still computes days_open for a non-aging-eligible status (visible stat, just no alert)', () => {
    const result = computeAging(iso(10 * DAY), null, 'P1', 'On Hold');
    expect(result.days_open).toBe(10);
    expect(result.aging_alert).toBe('ok');
  });

  it('returns days_open=0 for a null start date', () => {
    const result = computeAging(null, null, 'P1', 'Approved');
    expect(result.days_open).toBe(0);
  });

  describe('no target_closure_date set — falls back to days-open thresholds', () => {
    it('is ok below the yellow threshold', () => {
      const result = computeAging(iso(9 * DAY), null, 'P0', 'Approved');
      expect(result.aging_alert).toBe('ok');
    });

    it('is yellow at/above the yellow threshold but below red', () => {
      const result = computeAging(iso(10 * DAY), null, 'P0', 'Approved');
      expect(result.aging_alert).toBe('yellow');
    });

    it('is red at/above the red threshold', () => {
      const result = computeAging(iso(23 * DAY), null, 'P0', 'Live – Sourcing');
      expect(result.aging_alert).toBe('red');
    });

    it('days_overdue stays 0 even when flagged via the days-open fallback', () => {
      const result = computeAging(iso(30 * DAY), null, 'P0', 'Approved');
      expect(result.aging_alert).toBe('red');
      expect(result.days_overdue).toBe(0);
    });
  });

  describe('target_closure_date set — alert is anchored to overdue-past-target, not days open', () => {
    it('is ok when the target is still in the future, no matter how long the role has been open', () => {
      const farFuture = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
      const result = computeAging(iso(500 * DAY), farFuture, 'P0', 'Approved');
      expect(result.aging_alert).toBe('ok');
      expect(result.days_overdue).toBe(0);
    });

    it('is ok the day the target closes (daysPastTarget <= 0)', () => {
      const today = iso(0);
      const result = computeAging(iso(50 * DAY), today, 'P0', 'Approved');
      expect(result.aging_alert).toBe('ok');
    });

    it('is yellow once past target by the priority’s yellow threshold', () => {
      const result = computeAging(iso(50 * DAY), iso(15 * DAY), 'P1', 'Approved');
      expect(result.aging_alert).toBe('yellow');
      expect(result.days_overdue).toBe(15);
    });

    it('is red once past target by the priority’s red threshold', () => {
      const result = computeAging(iso(100 * DAY), iso(45 * DAY), 'P1', 'Live – Sourcing');
      expect(result.aging_alert).toBe('red');
      expect(result.days_overdue).toBe(45);
    });

    it('a long-open role with a recently-pushed-out target clears back to ok', () => {
      const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
      const result = computeAging(iso(200 * DAY), tomorrow, 'P0', 'Approved');
      expect(result.aging_alert).toBe('ok');
    });
  });

  it('P2 and P3 intentionally share the same yellow threshold (30) despite differing red thresholds', () => {
    const p2 = computeAging(iso(30 * DAY), null, 'P2', 'Approved');
    const p3 = computeAging(iso(30 * DAY), null, 'P3', 'Approved');
    expect(p2.aging_alert).toBe('yellow');
    expect(p3.aging_alert).toBe('yellow');
  });

  it('falls back to P1 thresholds for an unrecognized priority value', () => {
    // @ts-expect-error deliberately passing an invalid priority to exercise the `|| AGING_THRESHOLDS.P1` fallback
    const result = computeAging(iso(15 * DAY), null, 'BOGUS', 'Approved');
    expect(result.aging_alert).toBe('yellow'); // P1 yellow = 15
  });
}
