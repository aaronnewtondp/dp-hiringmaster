// roles.ctc_band is freeform text from the Requisition Form ("18-24 LPA",
// "5-9 ") — extract every number present and take the max as the ceiling.
export function parseCtcBandMax(ctcBand?: string | null): number | null {
  if (!ctcBand) return null;
  const nums = ctcBand.match(/\d+(\.\d+)?/g);
  return nums?.length ? Math.max(...nums.map(Number)) : null;
}

// 15% over the band max still counts as "in budget" for filtering purposes.
export const OVER_BUDGET_TOLERANCE = 1.15;

export function isOverBudget(expectedCtc?: number | null, ctcBand?: string | null): boolean {
  const max = parseCtcBandMax(ctcBand);
  if (max == null || expectedCtc == null) return false; // can't evaluate — don't flag
  return expectedCtc > max;
}

export function isWithinBudgetOrNear(expectedCtc?: number | null, ctcBand?: string | null): boolean {
  const max = parseCtcBandMax(ctcBand);
  if (max == null || expectedCtc == null) return true; // can't evaluate — don't hide
  return expectedCtc <= max * OVER_BUDGET_TOLERANCE;
}

// Stricter than isOverBudget() (which flags any amount over) — this is the
// specific 15%+ threshold past which shortlisting requires an explicit,
// on-record reason (backend/src/utils/budget.ts mirrors this exactly and
// enforces it server-side too).
export function isSeverelyOverBudget(expectedCtc?: number | null, ctcBand?: string | null): boolean {
  const max = parseCtcBandMax(ctcBand);
  if (max == null || expectedCtc == null) return false;
  return expectedCtc >= max * OVER_BUDGET_TOLERANCE;
}
