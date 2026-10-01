import { describe, it, expect } from 'vitest';
import { splitReasons } from './rejectionReasons.ts';
import { REJECTION_REASONS } from '../types/index.ts';

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
