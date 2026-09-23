import { describe, it, expect } from 'vitest';
import { tieredStandardHours } from './slaChecker.js';

describe('tieredStandardHours (Hiring SOP v2.1 score-tiered SLA)', () => {
  it('returns the standard 48h for a candidate with no score yet', () => {
    expect(tieredStandardHours(null)).toBe(48);
  });

  it('returns the standard 48h below the high-score threshold', () => {
    expect(tieredStandardHours(74)).toBe(48);
    expect(tieredStandardHours(0)).toBe(48);
  });

  it('returns the tiered 24h at and above the high-score threshold (75)', () => {
    expect(tieredStandardHours(75)).toBe(24);
    expect(tieredStandardHours(100)).toBe(24);
  });
});
