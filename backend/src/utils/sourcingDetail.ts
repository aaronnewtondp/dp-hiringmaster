// Sourcing plan detailing — constants, vocabulary mapping and thresholds. Spec: docs/SourcingPlanDetailing_Spec.md
//
// This layer is ADDITIVE. It never changes the five channels (SOURCING_CHANNELS), the form attribution (normalizeSourceTag →
// applications.sub_source) or the weekly tracker: a plan's own wording ("Outbound", "Job portal", "Talent pool"…) is mapped
// ONTO the five channels here, and anything that has no channel is a supporting activity with no automatic performance tracking.
import { SOURCING_CHANNELS } from './sourcingConfig.js';

export type RowStatus = 'live' | 'backup' | 'not_used';
export type TrackedAs = 'count' | 'yes_no';

/** The plan's own channel wording → the existing channel(s) that carry it. Anything not listed (Network, Community, Talent pool,
    Database search, Campus …) maps to NOTHING: it is a supporting activity, shown on the plan but never measured by form tag. */
const LABEL_TO_CHANNELS: Record<string, string[]> = {
  'outbound': ['Direct Outreach'],
  'direct outreach': ['Direct Outreach'],
  'referrals': ['Internal Referral'],
  'referral': ['Internal Referral'],
  'internal referral': ['Internal Referral'],
  'agency': ['Agency'],
  'search firm': ['Agency'],
  'linkedin': ['LinkedIn'],
  'naukri/iimjobs': ['Naukri/IIMjobs'],
};

/** "Job portal" rows say which portals in their platform text ("Naukri + LinkedIn Jobs", "LinkedIn Jobs (Naukri backup)", "Naukri (primary) + LinkedIn"). */
export function portalsFromPlatform(platform: string | null | undefined): string[] {
  const p = (platform ?? '').toLowerCase();
  const out: string[] = [];
  if (/linkedin/.test(p)) out.push('LinkedIn');
  if (/naukri|iimjobs|iim jobs/.test(p)) out.push('Naukri/IIMjobs');
  // "LinkedIn Jobs (Naukri backup)": the primary portal is the one named first, so the parenthesised backup is not a live channel.
  if (out.length === 2 && /\(\s*naukri[^)]*backup/.test(p)) return ['LinkedIn'];
  return out.length ? out : ['LinkedIn', 'Naukri/IIMjobs'];
}

/** Which of the five channels carries this plan line? [] = a supporting activity (no automatic tracking). */
export function mapWorkbookChannel(label: string, platform?: string | null): string[] {
  const key = label.trim().toLowerCase().replace(/\s+/g, ' ');
  if (key === 'job portal' || key === 'job portals' || key === 'portal') return portalsFromPlatform(platform);
  return (LABEL_TO_CHANNELS[key] ?? []).filter(c => (SOURCING_CHANNELS as readonly string[]).includes(c));
}

export function parseRowStatus(v: unknown): RowStatus | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, '_') : '';
  return s === 'live' || s === 'backup' || s === 'not_used' ? s : null;
}
export function parseTrackedAs(v: unknown): TrackedAs | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s/]+/g, '_') : '';
  if (s === 'count') return 'count';
  if (s === 'yes_no' || s === 'yesno') return 'yes_no';
  return null;
}

/** The short list a recruiter picks from when resolving an alert (the plan's "reason" list). Sent as the existing free-text `reason`. */
export const RESOLUTION_REASONS = [
  'Wrong companies or titles', 'Too busy with other roles', 'Salary too low', 'Job description issue',
  'Hiring manager delay', 'Market too thin', 'Other',
] as const;

/** Reasons a company can be excluded from the directory. Free text is still accepted. */
export const COMPANY_EXCLUDE_HINTS = ['Client', 'Partner', 'Competitor – do not approach', 'Closed down'] as const;

// ─── Alert types this layer adds (plain TEXT values in sourcing_exceptions.type) ─────────────────────
export const DETAIL_EXCEPTION_TYPES = [
  'CHECKIN_OVERDUE', 'WORK_BELOW_TARGET', 'CHANNEL_QUIET', 'SCREENING_BACKLOG', 'NO_RESULTS', 'WRONG_CANDIDATES',
  'HM_REJECTS_MOST', 'SOURCE_MISSING', 'BACKUP_PLAN_DUE', 'COMPANY_LIST_NOT_WORKED', 'TOO_FEW_PEOPLE_FOUND',
  'FOUND_NOT_CONTACTED', 'FEW_REPLIES', 'REPLIES_NOT_SUITABLE', 'AGENCY_WEAK',
] as const;
export type DetailExceptionType = typeof DETAIL_EXCEPTION_TYPES[number];
export function isDetailExceptionType(t: string): t is DetailExceptionType {
  return (DETAIL_EXCEPTION_TYPES as readonly string[]).includes(t);
}

/** Starting values from the proposal; every one can be overridden by the `detail_thresholds` row of sourcing_settings. */
export interface DetailThresholds {
  checkin_overdue_working_days: number;
  work_done_min_share: number;
  channel_quiet_days: number;
  screening_backlog_hours: number;
  no_results_weeks: number;
  no_results_share: number;
  wrong_candidates_share: number;
  wrong_candidates_min: number;
  hm_reject_share: number;
  hm_reject_min: number;
  hm_decision_days: number;
  source_missing_share: number;
  source_missing_min: number;
  company_list_touched_share: number;
  company_list_weeks: number;
  people_per_company_min: number;
  found_not_contacted_days: number;
  reply_min_share: number;
  reply_min_messages: number;
  replies_unsuitable_share: number;
  replies_unsuitable_min: number;
  agency_weak_share: number;
  agency_weak_min: number;
  /** A channel / box with fewer candidates than this shows "too few to judge" instead of a percentage. */
  too_few_to_judge: number;
  health_enough_amber: number;      // share of target
  health_right_green: number;       // share qualified
  health_right_amber: number;
  health_right_min: number;         // candidates needed before "Right candidates?" is judged
  health_worked_amber: number;
  /** When false (the default) every alert this layer raises is provisional: HR-tier dashboard only, no My Tasks item, no e-mail. */
  alerts_live: boolean;
}

export const DEFAULT_DETAIL_THRESHOLDS: DetailThresholds = {
  checkin_overdue_working_days: 2,
  work_done_min_share: 0.7,
  channel_quiet_days: 7,
  screening_backlog_hours: 48,
  no_results_weeks: 2,
  no_results_share: 0.5,
  wrong_candidates_share: 0.15,
  wrong_candidates_min: 20,
  hm_reject_share: 0.5,
  hm_reject_min: 5,
  hm_decision_days: 7,
  source_missing_share: 0.25,
  source_missing_min: 8,
  company_list_touched_share: 0.3,
  company_list_weeks: 2,
  people_per_company_min: 3,
  found_not_contacted_days: 5,
  reply_min_share: 0.05,
  reply_min_messages: 50,
  replies_unsuitable_share: 0.2,
  replies_unsuitable_min: 10,
  agency_weak_share: 0.2,
  agency_weak_min: 5,
  too_few_to_judge: 5,
  health_enough_amber: 0.5,
  health_right_green: 0.2,
  health_right_amber: 0.15,
  health_right_min: 20,
  health_worked_amber: 0.7,
  alerts_live: false,
};

/** Merge a stored override object over the defaults, ignoring unknown keys and wrongly-typed values. */
export function mergeDetailThresholds(stored: unknown): DetailThresholds {
  const out: DetailThresholds = { ...DEFAULT_DETAIL_THRESHOLDS };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_DETAIL_THRESHOLDS, k)) continue;
    if (k === 'alerts_live') { if (typeof v === 'boolean') out.alerts_live = v; continue; }
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000) (out as unknown as Record<string, number>)[k] = v;
  }
  return out;
}

/** A weekly target from the plan may be fractional (2.5); the plan's own per-role target is a whole number 1–500. */
export function roundTarget(v: number | string | null | undefined): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(500, Math.max(1, Math.round(n)));
}
