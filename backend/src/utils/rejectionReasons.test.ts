import { describe, it, expect } from 'vitest';
import { joinReasons, normalizeReasons, splitReasons, REASON_DELIMITER } from './rejectionReasons.js';

describe('normalizeReasons', () => {
  it('returns the array form as a clean list', () => {
    expect(normalizeReasons(['Missing mandatory skill', 'Communication gap'])).toEqual(['Missing mandatory skill', 'Communication gap']);
  });

  it('still honours the legacy single-string field', () => {
    expect(normalizeReasons(undefined, 'Skills Mismatch')).toEqual(['Skills Mismatch']);
    expect(normalizeReasons([], 'Skills Mismatch')).toEqual(['Skills Mismatch']);
  });

  it('prefers the array when both are sent', () => {
    expect(normalizeReasons(['A', 'B'], 'ignored')).toEqual(['A', 'B']);
  });

  it('treats a bare string in the array field as one reason', () => {
    expect(normalizeReasons('Compensation mismatch')).toEqual(['Compensation mismatch']);
  });

  it('trims, collapses whitespace, drops empties and de-duplicates (case-insensitively, keeping the first spelling)', () => {
    expect(normalizeReasons(['  Communication   gap ', '', '   ', 'communication gap', 'Short average tenure']))
      .toEqual(['Communication gap', 'Short average tenure']);
  });

  it('never trusts the shape: junk yields an empty list instead of throwing', () => {
    for (const bad of [null, undefined, 42, {}, [null, 7, {}, false], [[]]]) {
      expect(normalizeReasons(bad)).toEqual([]);
    }
    expect(normalizeReasons({}, 99)).toEqual([]);
  });

  it('removes the delimiter character from a reason so it can always be split back apart', () => {
    const out = normalizeReasons(['Skills; experience gap', 'Other']);
    expect(out).toEqual(['Skills, experience gap', 'Other']);
    expect(splitReasons(joinReasons(out))).toEqual(out);
  });

  it('caps the number and length of reasons', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Reason ${i}`);
    expect(normalizeReasons(many)).toHaveLength(12);
    expect(normalizeReasons(['x'.repeat(5000)])[0]).toHaveLength(200);
  });
});

describe('joinReasons / splitReasons', () => {
  it('round-trips real reasons, including ones with slashes and dashes', () => {
    const reasons = ['Cultural / values concern', 'Role filled — other candidate preferred', 'Short average tenure'];
    const stored = joinReasons(reasons);
    expect(stored).toBe(reasons.join(REASON_DELIMITER));
    expect(splitReasons(stored)).toEqual(reasons);
  });

  it('reads an older single-reason value unchanged', () => {
    expect(splitReasons('Missing mandatory skill')).toEqual(['Missing mandatory skill']);
  });

  it('is empty for nothing', () => {
    expect(splitReasons(null)).toEqual([]);
    expect(splitReasons(undefined)).toEqual([]);
    expect(splitReasons('')).toEqual([]);
  });
});
