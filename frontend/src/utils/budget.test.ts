import { describe, it, expect } from 'vitest';
import { parseCtcBandMax, isOverBudget, isWithinBudgetOrNear, isSeverelyOverBudget, OVER_BUDGET_TOLERANCE } from './budget.js';

describe('parseCtcBandMax', () => {
  it('extracts the max number from a freeform band string', () => {
    expect(parseCtcBandMax('18-24 LPA')).toBe(24);
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseCtcBandMax(null)).toBeNull();
    expect(parseCtcBandMax(undefined)).toBeNull();
    expect(parseCtcBandMax('TBD')).toBeNull();
  });
});

describe('isOverBudget', () => {
  it('flags any amount over the band max (no tolerance)', () => {
    expect(isOverBudget(24.01, '18-24 LPA')).toBe(true);
    expect(isOverBudget(24, '18-24 LPA')).toBe(false);
    expect(isOverBudget(20, '18-24 LPA')).toBe(false);
  });

  it("doesn't flag when it can't evaluate", () => {
    expect(isOverBudget(null, '18-24 LPA')).toBe(false);
    expect(isOverBudget(30, null)).toBe(false);
  });
});

describe('isWithinBudgetOrNear', () => {
  it(`is true up to ${OVER_BUDGET_TOLERANCE}x the band max`, () => {
    expect(isWithinBudgetOrNear(24 * OVER_BUDGET_TOLERANCE, '18-24 LPA')).toBe(true);
    expect(isWithinBudgetOrNear(24 * OVER_BUDGET_TOLERANCE + 0.01, '18-24 LPA')).toBe(false);
  });

  it("defaults to true (don't hide) when it can't evaluate", () => {
    expect(isWithinBudgetOrNear(null, '18-24 LPA')).toBe(true);
    expect(isWithinBudgetOrNear(30, null)).toBe(true);
  });
});

describe('isSeverelyOverBudget', () => {
  it('mirrors the backend’s stricter 15%-over threshold used for the mandatory-reason gate', () => {
    expect(isSeverelyOverBudget(24 * OVER_BUDGET_TOLERANCE, '18-24 LPA')).toBe(true);
    expect(isSeverelyOverBudget(25, '18-24 LPA')).toBe(false);
  });
});
