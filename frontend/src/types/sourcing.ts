// Sourcing Execution & Accountability module — API shapes. Mirrors backend/src/services/sourcingPlans.ts (PlanView) and
// backend/src/routes/sourcing.ts. All ids are STRINGS: the tables use BIGSERIAL and node-pg returns int8 as text.
import { Priority } from './index.ts';

/** Today's channel vocabulary (identical to roles.recruitment_mode). A separate list on purpose — RECRUITMENT_CHANNELS also
    feeds the role multiselect and the candidate source dropdown, and must not grow. Campus is deferred. */
export const SOURCING_CHANNELS = ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'] as const;
export type SourcingChannel = typeof SOURCING_CHANNELS[number];
export const PORTAL_CHANNELS: readonly string[] = ['LinkedIn', 'Naukri/IIMjobs'];
/** Channels run as "log the post (link + weekly target) → automatic weekly tracker". Agency and Internal Referral keep their own follow-ups. */
export const TRACKED_CHANNELS: readonly string[] = ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach'];

export type PlanStatus = 'draft' | 'active' | 'paused' | 'closed';
/** planned = not live yet · active = live · excluded = left out of the plan · closed = was used, then closed (summary kept; can be reopened) */
export type ChannelState = 'planned' | 'active' | 'excluded' | 'closed';
export type CommitmentStatus = 'open' | 'done' | 'skipped' | 'blocked';
export type ExceptionStatus = 'open' | 'snoozed' | 'blocked' | 'resolved';
export type ExceptionType =
  | 'PLAN_NOT_ACTIVATED' | 'CHANNEL_NOT_ACTIVATED' | 'COMMITMENT_OVERDUE' | 'FOLLOWUP_OVERDUE' | 'VOLUME_GAP' | 'BLOCKER_OVERDUE'
  // Added by the plan-detailing layer (backend/src/utils/sourcingDetail.ts)
  | 'CHECKIN_OVERDUE' | 'WORK_BELOW_TARGET' | 'CHANNEL_QUIET' | 'SCREENING_BACKLOG' | 'NO_RESULTS' | 'WRONG_CANDIDATES' | 'HM_REJECTS_MOST'
  | 'SOURCE_MISSING' | 'BACKUP_PLAN_DUE' | 'COMPANY_LIST_NOT_WORKED' | 'TOO_FEW_PEOPLE_FOUND' | 'FOUND_NOT_CONTACTED' | 'FEW_REPLIES'
  | 'REPLIES_NOT_SUITABLE' | 'AGENCY_WEAK';
export type ResolutionPath = 'catch_up' | 'change_strategy' | 'blocker';

export interface SourcingPlan {
  id: string; role_id: string; status: PlanStatus;
  strategy_note: string | null; baseline: unknown; baseline_at: string | null; activated_at: string | null;
  paused_at: string | null; pause_total_days: number; closed_at: string | null;
  /** This role's own weekly qualified target; null = the default (5 for P0/P1, none for P2/P3). */
  weekly_qualified_target: number | null;
}

export interface CommitmentLogEntry {
  done_at: string; was_due_at: string; on_time: boolean; note: string | null;
  evidence: Array<{ kind: string; ref: string | null; source: 'auto' | 'self' }>;
}

export interface SourcingCommitment {
  id: string; kind: string; title: string; due_at: string; due_date: string; status: CommitmentStatus; cadence_days: number | null;
  last_done_at: string | null; meta: Record<string, unknown>; overdue: boolean; evidence: { auto: number; self: number }; recent: CommitmentLogEntry[];
}

export interface TrackerWeek { week_start: string; week_end: string; target: number; actual: number; qualified: number; met: boolean; partial: boolean }
/** Weekly performance tracker of one channel (LinkedIn / Naukri/IIMjobs / Direct Outreach): finished weeks vs the weekly sourcing target. */
export interface ChannelTracker {
  applicable: boolean;
  target: number | null;
  anchor: string | null;
  link: string | null;
  running: { start: string; end: string; actual: number; qualified: number; target: number } | null;
  weeks: TrackerWeek[];                                   // finished weeks, newest first
  totals: { weeks: number; met: number; actual: number; target: number };
  sourced: { applications: number; qualified: number };   // everything tagged with this channel on this role, all time
}

export interface SourcingPlanChannel {
  id: string; channel: string; state: ChannelState; excluded_reason: string | null; closed_at: string | null; closed_reason: string | null;
  config: Record<string, unknown>; targets: Record<string, unknown>; tracker: ChannelTracker; commitments: SourcingCommitment[];
}

export interface SourcingException {
  id: string; channel: string; type: ExceptionType; status: ExceptionStatus; severity: number; is_shadow: boolean;
  detected_at: string; last_seen_at: string; evidence: Record<string, unknown>; resolution_path: string | null;
  reason: string | null; corrective_action: string | null; snooze_until: string | null; blocker_due: string | null;
  blocker_owner_name: string | null; resolved_at: string | null;
  committed: string; happened: string; next_action: string;
}

export type TimelineCategory = 'plan' | 'task' | 'channel' | 'target' | 'exception' | 'weekly';
export interface PlanChange {
  id: string; at: string; by_name: string | null; change: { type?: string; [k: string]: unknown }; reason: string | null; text: string; category: TimelineCategory;
}
export interface SourcingVolume {
  weekly_qualified: number; shortlisted: number; scored: number; min: number; rule: string; applicable: boolean;
  /** The target in force: this role's own, the default for a P0/P1 role, or none. */
  target_source: 'role' | 'default' | 'none'; role_target: number | null; default_target: number | null;
}

export interface SourcingPlanView {
  enabled: true;
  plan: SourcingPlan | null;
  read_only?: boolean;
  role?: { id: string; title: string; priority: Priority; status: string; num_openings: number | null; hiring_manager_name: string | null; recruitment_mode: string[] | null; approval_date: string | null };
  channels?: SourcingPlanChannel[];
  exceptions?: SourcingException[];
  changes?: PlanChange[];
  changes_total?: number;
  volume?: SourcingVolume;
  output?: Array<{ tag: string; applications: number; qualified: number }>;
  attribution_reliable?: Record<string, boolean>;
  settings?: { go_live_date: string | null; qualified_rule: string; shadow_until: string | null };
}
/** `{ enabled:false }` — the module is switched off; render nothing. */
export type SourcingPlanResponse = SourcingPlanView | { enabled: false };

/** Someone who can be named as the owner of a BLOCKER. A plan itself has no individual owner: sourcing belongs to the HR/Admin persona. */
export interface SourcingPerson { id: string; name: string; persona: string }

/** The Sourcing page's role switcher. */
export interface WorkspaceRole {
  role_id: string; title: string; priority: Priority; plan_id: string; plan_status: 'draft' | 'active' | 'paused';
  open_exceptions: number; channels_live: number; qualified: number; target: number | null; behind: boolean;
}
export interface SourcingWorkspace { enabled: true; read_only: boolean; roles: WorkspaceRole[]; drafts: WorkspaceRole[]; drafts_total?: number }
export type SourcingWorkspaceResponse = SourcingWorkspace | { enabled: false };

/** AI-written (or rule-based) next steps for a plan — see backend/src/services/sourcingAdvisor.ts. */
export interface AdviceStep {
  id: string; title: string; detail: string; channel: string | null; exception_id: string | null; impact: 'high' | 'medium' | 'low'; owner: 'HR' | 'Hiring Manager';
}
export interface SourcingAdvice {
  advice: { headline: string; steps: AdviceStep[]; watch: string[] };
  source: 'ai' | 'rules'; model: string | null; generated_at: string; facts_hash: string; stale: boolean;
}

export interface ActivationChannelInput {
  channel: string;
  exclude_reason?: string | null;
  already_running?: boolean;
  posted_at?: string | null;
  url?: string | null;
  weekly_target?: number | null;
}

export interface CompleteCommitmentInput {
  note?: string | null; url?: string | null; count?: number | null; attest?: boolean; posted_at?: string | null; weekly_target?: number | null;
}

/** The weekly sourcing target is a whole number of applicants (1 up); the role's qualified target is 1–500. */
export const MAX_WEEKLY_TARGET = 10000;

export interface ResolveExceptionInput {
  path: ResolutionPath; reason: string; corrective_action?: string | null; snooze_until?: string | null;
  blocker_owner_user_id?: string | null; blocker_due?: string | null; exclude_channel?: boolean;
}

// ── My Tasks queue ─────────────────────────────────────────────────────────────
export interface QueueException {
  id: string; plan_id: string; channel: string; type: ExceptionType; severity: number; age_days: number;
  committed: string; happened: string; next_action: string;
}
export interface SourcingQueue {
  enabled: true; today: string;
  plans_to_activate: Array<{ plan_id: string; role_id: string; title: string; priority: Priority; approval_date: string | null }>;
  due: Array<{ id: string; plan_id: string; role_id: string; role_title: string; priority: Priority; channel: string; kind: string; title: string; due_date: string; overdue: boolean }>;
  exceptions: Array<{ role_id: string; title: string; priority: Priority; severity: number; items: QueueException[] }>;
  exception_count: number; snoozed_count: number; blocked_count: number; active_plans: number;
  volume: Array<{ role_id: string; title: string; priority: Priority; min: number; qualified: number }>;
  volume_ok: number;
}

/** What needs doing now: plans waiting to be activated + commitments due today (overdue ones are already inside an exception) + open exceptions. */
export function sourcingQueueCount(q: SourcingQueue | undefined): number {
  if (!q) return 0;
  return q.plans_to_activate.length + q.due.filter(d => !d.overdue).length + q.exception_count;
}

// ── Dashboard section ──────────────────────────────────────────────────────────
export interface SourcingDashboardRow {
  id: string; plan_id: string; role_id: string; role_title: string; priority: Priority; channel: string; type: ExceptionType;
  status: ExceptionStatus; provisional: boolean; severity: number; age_days: number; blocker_due: string | null;
  committed: string; happened: string; next_action: string;
}
export interface SourcingDashboard {
  enabled: true; read_only: boolean; provisional_until: string | null;
  summary: {
    open_roles: number; plans_active: number; plans_draft: number; plans_paused: number;
    commitments_done_14d: number; on_time_pct_14d: number | null; overdue_commitments: number;
    exceptions_open: number; exceptions_blocked: number; exceptions_snoozed: number; provisional_signals: number;
    by_priority: Record<string, number>;
  };
  exceptions: SourcingDashboardRow[];
}

// ─── Plan detailing (backend/src/services/sourcingDetail.ts) ─────────────────────────────────────────
export type HealthColour = 'green' | 'amber' | 'red' | 'grey';
export type PlanRowStatus = 'live' | 'backup' | 'not_used';
export interface PlanLine {
  id?: string; workbook_channel: string; mapped_channels?: string[]; platform: string | null; status: PlanRowStatus; owner_label: string | null;
  tracked_as: 'count' | 'yes_no' | null; weekly_work: number | null; work_unit: string | null; expected_applicants: number | null; expected_qualified: number | null;
  start_condition: string | null; first_task: string | null; repeats: string | null; reason: string | null;
}
export interface HealthBox { colour: HealthColour; text: string }
export interface WorkItem { label: string; kind: 'count' | 'yes_no'; done: number | null; target: number | null; ok: boolean }
export interface PlanHealth {
  enough: HealthBox & { qualified: number; target: number | null; awaiting_screening: number };
  right: HealthBox & { candidates: number; qualified: number; share: number | null };
  worked: HealthBox & { items: WorkItem[]; share: number | null };
  source: { untagged: number; total: number; share: number; untrusted: boolean };
}
export interface ChannelResult { channel: string; candidates: number; qualified: number; share: number | null; too_few: boolean; last_activity: string | null }
export interface CheckinState { week_of: string; due: string; done: boolean; answers: Record<string, string>; blocker_text: string | null; questions: string[] }
export interface PlanDetail {
  plan_id: string; plan_status: PlanStatus; template: { key: string; name: string } | null; job_titles: string[]; target_date: string | null;
  company_lists: Array<{ id: string; name: string; companies: number }>; rows: PlanLine[];
  suggested_channels: Array<{ channel: string; weekly_target: number | null }>; suggested_target: number | null;
  health: PlanHealth; channel_results: ChannelResult[]; untagged_warning: boolean;
  outreach: {
    companies_listed: number; companies_worked: number; worked_share: number | null; people_found: number; people_contacted: number; followups: number; replied: number;
    last_upload: string | null; by_title: Array<{ job_title: string; found: number; contacted: number; replied: number }>;
  };
  checkin: CheckinState | null; reasons: string[];
}
export interface PlanDetailResponse { enabled: boolean; detail: PlanDetail | null }
export interface TemplateSummary { id: string; key: string; name: string; description: string | null; job_titles: string[]; company_lists: string[]; weekly_qualified_target: number | null; channel_rows: PlanLine[]; is_active: boolean }
export interface UploadSummary { ok: boolean; rows_total: number; people_new: number; followups: number; merged: number; rejected: Array<{ row: number; reason: string }>; rejected_total: number; unlisted_companies: number }
export interface Reminder { kind: 'checkin' | 'outreach_upload' | 'untagged' | 'plan'; role_id: string; title: string; due: string | null; overdue: boolean; detail: string }
export interface OverviewRow {
  role_id: string; title: string; priority: string; plan_status: PlanStatus; hiring_manager: string | null;
  enough: (HealthBox & { qualified: number; target: number | null; awaiting_screening: number }) | null; right: HealthBox | null; worked: HealthBox | null;
  open_alerts: number; provisional_alerts: number; hm_alerts: number; headline: string | null;
}
export interface OverviewResponse {
  enabled: boolean;
  summary: { roles_with_active_plan: number; roles_total: number; checkins_on_time: number; checkins_due: number; open_alerts: number; hm_alerts: number };
  rows: OverviewRow[];
}
export interface CompanyRow {
  id: string; name: string; segment: string | null; size: string | null; cities: string[]; what_they_do: string | null; source_url: string | null; notes: string | null;
  excluded: boolean; excluded_reason: string | null; last_checked_at: string; needs_recheck: boolean; legacy_contacted: boolean; lists: string[]; roles_targeting: string[];
  people_contacted: number; people_found: number; candidates: number; last_contacted: string | null;
}
export interface CompanyDetail extends CompanyRow {
  outreach_by_role: Array<{ role_id: string; people: number; contacted: number; replied: number }>; hires: number;
  recent_people: Array<{ job_title: string | null; role_id: string; status: string | null; outcome: string | null; last_contacted: string | null }>;
}
