import { AGING_THRESHOLDS, Priority } from '../types/index.js';

export interface AgingResult {
  days_open: number;
  days_overdue: number;
  aging_alert: 'ok' | 'yellow' | 'red';
}

// The red/yellow alert is deliberately anchored to target_closure_date (the
// HR-set "Close Target"), not to how long the role has simply been open —
// a role can legitimately stay open a long time on a realistic timeline
// without that being a problem, so days_open alone was flagging roles as
// overdue the moment they crossed a fixed per-priority day count, with no
// way to reflect a genuinely revised plan. Pushing Close Target out now
// actually clears the alert, per product decision; days_open is still
// returned and shown alongside days_overdue as a separate, always-visible
// stat, just no longer the thing that drives red/yellow on its own.
export function computeAging(
  startDate: string | null,
  targetClosureDate: string | null,
  priority: Priority
): AgingResult {
  const now = Date.now();
  const days_open = startDate ? Math.floor((now - new Date(startDate).getTime()) / 86400000) : 0;
  const thresh = AGING_THRESHOLDS[priority] || AGING_THRESHOLDS.P1;

  // No Close Target set yet — fall back to the pre-existing days-open
  // thresholds so a role isn't silently stripped of aging visibility just
  // for not having a target date entered.
  if (!targetClosureDate) {
    const aging_alert = days_open >= thresh.red ? 'red' : days_open >= thresh.yellow ? 'yellow' : 'ok';
    return { days_open, days_overdue: 0, aging_alert };
  }

  const daysPastTarget = Math.floor((now - new Date(targetClosureDate).getTime()) / 86400000);
  if (daysPastTarget <= 0) {
    return { days_open, days_overdue: 0, aging_alert: 'ok' };
  }
  const aging_alert = daysPastTarget >= thresh.red ? 'red' : daysPastTarget >= thresh.yellow ? 'yellow' : 'ok';
  return { days_open, days_overdue: daysPastTarget, aging_alert };
}
