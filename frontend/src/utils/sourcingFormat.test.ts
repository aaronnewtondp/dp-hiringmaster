import { describe, it, expect } from 'vitest';
import { channelBlurb, dueLabel, exceptionLabel, isPortal, plural, topN, ymd } from './sourcingFormat.ts';

describe('dueLabel', () => {
  it('reads relative to today', () => {
    expect(dueLabel('2026-10-14', '2026-10-14')).toBe('Due today');
    expect(dueLabel('2026-10-15', '2026-10-14')).toBe('Due tomorrow');
    expect(dueLabel('2026-10-13', '2026-10-14')).toBe('1 day overdue');
    expect(dueLabel('2026-10-10', '2026-10-14')).toBe('4 days overdue');
    expect(dueLabel('2026-11-10', '2026-10-14')).toBe('Due 10 Nov');
  });
  it('falls back to the raw value for a bad date', () => {
    expect(dueLabel('soon', '2026-10-14')).toBe('soon');
  });
});

describe('ymd', () => {
  it('formats the local calendar date and offsets across month/year ends', () => {
    const d = new Date(2026, 11, 30, 23, 59);
    expect(ymd(0, d)).toBe('2026-12-30');
    expect(ymd(2, d)).toBe('2027-01-01');
    expect(ymd(-30, d)).toBe('2026-11-30');
  });
});

describe('topN / plural / labels', () => {
  it('top N plus the remainder', () => {
    expect(topN([1, 2, 3, 4, 5, 6, 7], 5)).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(topN([1, 2], 5)).toEqual({ shown: [1, 2], more: 0 });
    expect(topN([1, 2, 3], Infinity)).toEqual({ shown: [1, 2, 3], more: 0 });
  });
  it('plural', () => { expect(plural(1, 'day')).toBe('1 day'); expect(plural(2, 'day')).toBe('2 days'); expect(plural(0, 'day')).toBe('0 days'); });
  it('exception labels fall back to the raw code', () => {
    expect(exceptionLabel('VOLUME_GAP')).toBe('Not enough qualified candidates');
    expect(exceptionLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
  it('every channel has a blurb and portals are identified', () => {
    for (const c of ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach']) expect(channelBlurb(c).length).toBeGreaterThan(10);
    expect(isPortal('LinkedIn')).toBe(true);
    expect(isPortal('Agency')).toBe(false);
  });
});
