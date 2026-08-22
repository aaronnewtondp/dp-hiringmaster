// Mirrors frontend/src/utils/budget.ts's parsing exactly. Kept as two
// independent copies (frontend needs it for badges/filtering, backend needs
// it to enforce the mandatory over-budget-reason gate) rather than a shared
// package, since this repo has no shared-code mechanism between the two apps.

// roles.ctc_band is freeform text from the Requisition Form ("18-24 LPA",
// "5-9 ") — extract every number present and take the max as the ceiling.
export function parseCtcBandMax(ctcBand?: string | null): number | null {
  if (!ctcBand) return null;
  const nums = ctcBand.match(/\d+(\.\d+)?/g);
  return nums?.length ? Math.max(...nums.map(Number)) : null;
}

// 15% over the band max is the threshold past which shortlisting requires
// an explicit reason (frontend's OverBudgetBadge flags any amount over,
// this is a stricter, separate check).
export const OVER_BUDGET_TOLERANCE = 1.15;

export function isSeverelyOverBudget(expectedCtc?: number | null, ctcBand?: string | null): boolean {
  const max = parseCtcBandMax(ctcBand);
  if (max == null || expectedCtc == null) return false; // can't evaluate — don't gate
  return expectedCtc >= max * OVER_BUDGET_TOLERANCE;
}
