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
  priority: Priority,
  status: string
): AgingResult {
  const now = Date.now();
  const days_open = startDate ? Math.floor((now - new Date(startDate).getTime()) / 86400000) : 0;
  const thresh = AGING_THRESHOLDS[priority] || AGING_THRESHOLDS.P1;

  // Aging SLA only ever applies to a role that's actually being actively
  // sourced — Approved (about to post) or Live – Sourcing. A Draft/Under
  // Review role hasn't started its clock yet; an On Hold or Closed role has
  // stopped it — flagging any of those red/yellow doesn't mean anything
  // actionable, so they always come back 'ok' regardless of start_date.
  // days_open itself stays a neutral, always-computed stat (still shown in
  // the UI as "Xd open") — only the alert/overdue-count is gated here.
  // status is a required param (not defaulted) specifically so every call
  // site is forced to think about it at compile time, not left to silently
  // fall through un-gated.
  if (status !== 'Approved' && status !== 'Live – Sourcing') {
    return { days_open, days_overdue: 0, aging_alert: 'ok' };
  }

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
