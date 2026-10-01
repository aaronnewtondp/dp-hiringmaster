import { describe, it, expect } from 'vitest';
import { reasonFields, splitReasons, REASON_DELIMITER } from './rejectionReasons.ts';
import { REJECTION_REASONS } from '../types/index.ts';

describe('reasonFields', () => {
  it('sends both the list and the older joined string, so either backend version records the same thing', () => {
    expect(reasonFields(['Communication gap', 'Short average tenure'])).toEqual({
      rejection_reason_cats: ['Communication gap', 'Short average tenure'],
      rejection_reason_cat: 'Communication gap; Short average tenure',
    });
    expect(reasonFields(['Compensation mismatch'])).toEqual({ rejection_reason_cats: ['Compensation mismatch'], rejection_reason_cat: 'Compensation mismatch' });
  });
  it('sends nothing at all for no reasons', () => {
    expect(reasonFields([])).toEqual({});
  });
  it('the joined string splits back into the same reasons', () => {
    const f = reasonFields(['A', 'B', 'C']);
    expect(splitReasons(f.rejection_reason_cat)).toEqual(['A', 'B', 'C']);
    expect(f.rejection_reason_cat).toBe(['A', 'B', 'C'].join(REASON_DELIMITER));
  });
});

describe('splitReasons', () => {
  it('splits a multi-reason value into its parts', () => {
    expect(splitReasons('Missing mandatory skill; Communication gap')).toEqual(['Missing mandatory skill', 'Communication gap']);
  });
  it('leaves an older single reason alone', () => {
    expect(splitReasons('Compensation mismatch')).toEqual(['Compensation mismatch']);
  });
  it('is empty for nothing', () => {
    expect(splitReasons(undefined)).toEqual([]);
    expect(splitReasons(null)).toEqual([]);
    expect(splitReasons('')).toEqual([]);
  });
  it('round-trips every real rejection reason joined together (none of them contains the delimiter)', () => {
    expect(splitReasons(REJECTION_REASONS.join('; '))).toEqual(REJECTION_REASONS);
  });
});
