import { describe, it, expect } from 'vitest';
import {
  istDate, isWorkingDay, addWorkingDays, workingDaysBetween, lastWorkingDays, endOfIstDay, mondayOf, addCalendarDays,
} from './workingDays.js';

// 2026-10-12 is a Monday, 2026-10-17 a Saturday, 2026-10-18 a Sunday.
describe('istDate', () => {
  it('maps an instant to its IST calendar date', () => {
    // 20:00 UTC on the 12th is already 01:30 IST on the 13th.
    expect(istDate('2026-10-12T20:00:00Z')).toBe('2026-10-13');
    expect(istDate('2026-10-12T18:29:59Z')).toBe('2026-10-12');
    expect(istDate('2026-10-12T18:30:00Z')).toBe('2026-10-13');
  });
});

describe('isWorkingDay', () => {
  it('treats Sat/Sun as non-working by default', () => {
    expect(isWorkingDay('2026-10-12')).toBe(true);
    expect(isWorkingDay('2026-10-17')).toBe(false);
    expect(isWorkingDay('2026-10-18')).toBe(false);
  });
  it('honours a custom weekend, and does not model public holidays (Aaron, 2026-10-19: not worth the complexity)', () => {
    expect(isWorkingDay('2026-10-17', { weekend: [0] })).toBe(true); // 6-day week
    expect(isWorkingDay('2026-10-15')).toBe(true);                   // Thursday — a weekday is always a working day
  });
});

describe('addWorkingDays', () => {
  it('adds within a week', () => {
    expect(addWorkingDays('2026-10-12', 1)).toBe('2026-10-13');
    expect(addWorkingDays('2026-10-12', 4)).toBe('2026-10-16');
  });
  it('skips the weekend', () => {
    expect(addWorkingDays('2026-10-16', 1)).toBe('2026-10-19'); // Fri -> Mon
    expect(addWorkingDays('2026-10-17', 1)).toBe('2026-10-19'); // Sat -> Mon
    expect(addWorkingDays('2026-10-12', 5)).toBe('2026-10-19');
  });
  it('n = 0 returns the input, even on a weekend', () => {
    expect(addWorkingDays('2026-10-17', 0)).toBe('2026-10-17');
  });
  it('walks backwards for negative n', () => {
    expect(addWorkingDays('2026-10-19', -1)).toBe('2026-10-16'); // Mon -> Fri
  });
  it('cannot loop forever on a calendar with no working days', () => {
    expect(() => addWorkingDays('2026-10-12', 1, { weekend: [0, 1, 2, 3, 4, 5, 6] })).not.toThrow();
  });
});

describe('workingDaysBetween', () => {
  it('counts (from, to]', () => {
    expect(workingDaysBetween('2026-10-12', '2026-10-13')).toBe(1);
    expect(workingDaysBetween('2026-10-12', '2026-10-12')).toBe(0);
    expect(workingDaysBetween('2026-10-13', '2026-10-12')).toBe(0);
  });
  it('excludes weekends', () => {
    expect(workingDaysBetween('2026-10-16', '2026-10-19')).toBe(1); // Sat+Sun skipped
    expect(workingDaysBetween('2026-10-12', '2026-10-19')).toBe(5);
  });
});

describe('lastWorkingDays', () => {
  it('returns the n most recent working days oldest-first', () => {
    expect(lastWorkingDays('2026-10-14', 3)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
  });
  it('rolls back over a weekend from a Sunday', () => {
    expect(lastWorkingDays('2026-10-18', 2)).toEqual(['2026-10-15', '2026-10-16']);
  });
});

describe('endOfIstDay / mondayOf / addCalendarDays', () => {
  it('end of an IST day is 18:29:59.999 UTC the same date', () => {
    expect(endOfIstDay('2026-10-12').toISOString()).toBe('2026-10-12T18:29:59.999Z');
  });
  it('finds the Monday of a week', () => {
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2026-10-18')).toBe('2026-10-12'); // Sunday belongs to the Mon–Sun week before
    expect(mondayOf('2026-10-14')).toBe('2026-10-12');
  });
  it('crosses month and year boundaries', () => {
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
