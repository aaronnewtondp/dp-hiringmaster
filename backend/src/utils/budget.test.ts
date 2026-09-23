import { describe, it, expect } from 'vitest';
import { parseCtcBandMax, isSeverelyOverBudget, OVER_BUDGET_TOLERANCE } from './budget.js';

describe('parseCtcBandMax', () => {
  it('returns the max number found in freeform band text', () => {
    expect(parseCtcBandMax('18-24 LPA')).toBe(24);
    expect(parseCtcBandMax('5-9 ')).toBe(9);
  });

  it('returns null for empty/null/undefined input', () => {
    expect(parseCtcBandMax(null)).toBeNull();
    expect(parseCtcBandMax(undefined)).toBeNull();
    expect(parseCtcBandMax('')).toBeNull();
  });

  it('returns null when the text has no numbers at all', () => {
    expect(parseCtcBandMax('Negotiable')).toBeNull();
  });

  it('handles a single number with no range', () => {
    expect(parseCtcBandMax('20 LPA')).toBe(20);
  });
});

describe('isSeverelyOverBudget', () => {
  it('is false when either value is unavailable to evaluate ("can\'t evaluate — don\'t gate")', () => {
    expect(isSeverelyOverBudget(null, '18-24 LPA')).toBe(false);
    expect(isSeverelyOverBudget(30, null)).toBe(false);
    expect(isSeverelyOverBudget(30, 'Negotiable')).toBe(false);
  });

  it(`is false for an expected CTC below the ${OVER_BUDGET_TOLERANCE}x band max`, () => {
    expect(isSeverelyOverBudget(25, '18-24 LPA')).toBe(false); // 25 < 24 * 1.15 = 27.6
  });

  it(`is true at exactly the ${OVER_BUDGET_TOLERANCE}x threshold and above`, () => {
    expect(isSeverelyOverBudget(24 * OVER_BUDGET_TOLERANCE, '18-24 LPA')).toBe(true);
    expect(isSeverelyOverBudget(40, '18-24 LPA')).toBe(true);
  });
});
