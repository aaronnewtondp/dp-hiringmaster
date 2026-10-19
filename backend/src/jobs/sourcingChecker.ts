// Sourcing exception engine — compute-on-read, idempotent, isolated.
// Spec: docs/SourcingModule_PRD_v2.md §8. Deliberately NOT part of runSlaCheck(): it owns its own
// tables (sourcing_*), its own throttle, and never reads or writes pending_actions.
//
// Shape: pure detectors (rows + a clock in, DetectedException[] out — unit-tested) and
// runSourcingCheck(), which loads rows with a handful of set-based queries (≤2 concurrent — the DB
// pool is max 5 on Vercel and runSlaCheck already fans out 9), then reconciles the desired set
// against sourcing_exceptions with INSERT … ON CONFLICT and two set-based UPDATEs. Correctness
// comes from the partial unique index, never from the throttle.
import { query } from '../db/index.js';
import { isLowPipeline } from '../utils/lowPipeline.js';
import {
  addWorkingDays, addCalendarDays, endOfIstDay, istDate, lastWorkingDays, WorkingCalendar,
} from '../utils/workingDays.js';
import {
  isSourcingEnabled, OPEN_ROLE_STATUSES, PRIORITY_SEVERITY, QualifiedRule, SourcingSettings,
} from '../utils/sourcingConfig.js';
import { ensureDraftPlansForOpenRoles } from '../services/sourcingPlans.js';
import { loadSettings, stampGoLiveDefaults } from '../services/sourcingSettings.js';
import { qualifiedAt, QualifiedInput, QUALIFIED_TIMESTAMPS_SQL } from '../utils/sourcingQualified.js';

export { qualifiedAt };
export type { QualifiedInput };

export type ExceptionType =
  | 'PLAN_NOT_ACTIVATED' | 'CHANNEL_NOT_ACTIVATED' | 'COMMITMENT_OVERDUE'
  | 'FOLLOWUP_OVERDUE' | 'VOLUME_GAP' | 'BLOCKER_OVERDUE';

export interface DetectedException {
  plan_id: string;
  channel: string;          // '*' = plan-level
  type: ExceptionType;
  subject_key: string;
  severity: number;
  is_shadow: boolean;
  evidence: Record<string, unknown>;
}

export const SHADOW_TYPES: readonly ExceptionType[] = ['VOLUME_GAP'];

/** Working days are Monday–Friday (IST). Public holidays are deliberately not modelled — see docs/SourcingModule_Runbook.md. */
export function calendarOf(_s?: SourcingSettings): WorkingCalendar {
  return {};
}

/** Provisional (dashboard-only) until `shadow_until` has passed. */
export function inShadowPeriod(settings: SourcingSettings, today: string): boolean {
  return settings.shadow_until !== null && today <= settings.shadow_until;
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = new Date(`${fromDate}T12:00:00Z`).getTime();
  const b = new Date(`${toDate}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function severityFor(priority: string, daysOver: number, lowPipeline: boolean): number {
  return (PRIORITY_SEVERITY[priority] ?? 0) + Math.min(Math.max(daysOver, 0), 20) + (lowPipeline ? 15 : 0);
}

// ─── 1. Overdue commitments → CHANNEL_NOT_ACTIVATED / FOLLOWUP_OVERDUE / COMMITMENT_OVERDUE ─────────
export interface OpenCommitment {
  plan_id: string;
  plan_status: string;           // only an active plan raises anything
  role_id: string;
  priority: string;
  channel: string;
  channel_state: string;
  kind: string;
  title: string;
  due_at: Date | string;
  meta: Record<string, unknown> | null;
}

const TYPE_RANK: Partial<Record<ExceptionType, number>> = {
  CHANNEL_NOT_ACTIVATED: 3, FOLLOWUP_OVERDUE: 2, COMMITMENT_OVERDUE: 1,
};

export function typeForKind(kind: string): ExceptionType {
  if (kind === 'activate_channel') return 'CHANNEL_NOT_ACTIVATED';
  if (kind === 'followup_agency') return 'FOLLOWUP_OVERDUE';
  return 'COMMITMENT_OVERDUE';
}

/** One exception per (plan, channel) at its worst state (PRD §6 / spec §3), evidence = counts and titles only. */
export function detectCommitmentExceptions(
  rows: OpenCommitment[], now: Date, lowPipelineRoles: ReadonlySet<string> = new Set(),
): DetectedException[] {
  const today = istDate(now);
  const groups = new Map<string, { rows: Array<OpenCommitment & { days: number }>; first: OpenCommitment }>();

  for (const r of rows) {
    if (r.channel_state === 'excluded') continue;
    if (r.plan_status !== 'active') continue;
    const due = r.due_at instanceof Date ? r.due_at : new Date(r.due_at);
    if (!(due.getTime() < now.getTime())) continue;
    // Baseline mode: a weekly outbound commitment shows actuals but raises nothing for its first weeks.
    const baselineUntil = r.meta && typeof r.meta.baseline_until === 'string' ? r.meta.baseline_until : null;
    if (r.kind === 'weekly_outbound' && baselineUntil && today <= baselineUntil) continue;

    const key = `${r.plan_id}|${r.channel}`;
    const g = groups.get(key) ?? { rows: [], first: r };
    g.rows.push({ ...r, days: Math.max(0, daysBetween(istDate(due), today)) });
    groups.set(key, g);
  }

  const out: DetectedException[] = [];
  for (const g of groups.values()) {
    const type = g.rows
      .map(r => typeForKind(r.kind))
      .sort((a, b) => (TYPE_RANK[b] ?? 0) - (TYPE_RANK[a] ?? 0))[0];
    const maxDays = Math.max(...g.rows.map(r => r.days));
    out.push({
      plan_id: g.first.plan_id, channel: g.first.channel, type, subject_key: '',
      severity: severityFor(g.first.priority, maxDays, lowPipelineRoles.has(g.first.role_id)),
      is_shadow: false,
      evidence: {
        count: g.rows.length,
        overdue: g.rows.map(r => ({ kind: r.kind, title: r.title, due: istDate(r.due_at), days_overdue: r.days })),
      },
    });
  }
  return out;
}

// ─── 2. PLAN_NOT_ACTIVATED ─────────────────────────────────────────────────────────────────────────
export interface RoleForPlanCheck {
  plan_id: string;
  role_id: string;
  priority: string;
  approval_date: string | null;   // IST 'YYYY-MM-DD'
  plan_status: string;
}

/**
 * Only for roles approved on/after go-live (the pre-existing roles appear as an "Activate plans" checklist
 * instead — rolled out in waves). Raised once a role has been approved for more than 1 working day.
 */
export function detectPlanNotActivated(
  roles: RoleForPlanCheck[], now: Date, settings: SourcingSettings, lowPipelineRoles: ReadonlySet<string> = new Set(),
): DetectedException[] {
  if (!settings.go_live_date) return [];
  const today = istDate(now);
  const cal = calendarOf(settings);
  const out: DetectedException[] = [];
  for (const r of roles) {
    if (r.plan_status === 'active' || r.plan_status === 'paused' || r.plan_status === 'closed') continue;
    if (!r.approval_date || r.approval_date < settings.go_live_date) continue;
    const due = addWorkingDays(r.approval_date, 1, cal);
    if (today <= due) continue;
    const daysOver = daysBetween(due, today);
    out.push({
      plan_id: r.plan_id, channel: '*', type: 'PLAN_NOT_ACTIVATED', subject_key: '',
      severity: severityFor(r.priority, daysOver, lowPipelineRoles.has(r.role_id)),
      is_shadow: false,
      evidence: { approved_on: r.approval_date, due_on: due, days_overdue: daysOver },
    });
  }
  return out;
}

// ─── 3. VOLUME_GAP — the SOP's "≥5 qualified per week for open P0/P1 roles" ──────────────────────────
export interface RoleForVolumeCheck {
  plan_id: string;
  role_id: string;
  priority: string;
  apps: QualifiedInput[];
}

/**
 * Breach when the rolling-7-day qualified count is below the minimum on EACH of the last N working days.
 * Computed from immutable timestamps (never snapshots), so a window can be rebuilt for any past day.
 * Only P0/P1 (the SOP sets no volume target for P2/P3). Threshold-based ⇒ shadow until `shadow_until`.
 */
export function detectVolumeGap(
  roles: RoleForVolumeCheck[], now: Date, settings: SourcingSettings, lowPipelineRoles: ReadonlySet<string> = new Set(),
): DetectedException[] {
  const today = istDate(now);
  const cal = calendarOf(settings);
  const days = lastWorkingDays(today, settings.volume_gap_working_days, cal);
  const shadow = inShadowPeriod(settings, today);
  const out: DetectedException[] = [];

  for (const r of roles) {
    if (r.priority !== 'P0' && r.priority !== 'P1') continue;
    const qual = r.apps
      .map(a => qualifiedAt(a, settings.qualified_rule))
      .filter((d): d is Date => d !== null);

    const perDay = days.map(d => {
      const end = endOfIstDay(d).getTime();
      const start = endOfIstDay(addCalendarDays(d, -settings.volume_window_days)).getTime();
      return { date: d, count: qual.filter(q => q.getTime() > start && q.getTime() <= end).length };
    });
    if (perDay.length === 0 || !perDay.every(p => p.count < settings.volume_min_qualified)) continue;

    const latest = perDay[perDay.length - 1];
    const endLatest = endOfIstDay(latest.date).getTime();
    const startLatest = endOfIstDay(addCalendarDays(latest.date, -settings.volume_window_days)).getTime();
    const inWindow = (d: Date | null) => !!d && d.getTime() > startLatest && d.getTime() <= endLatest;
    out.push({
      plan_id: r.plan_id, channel: '*', type: 'VOLUME_GAP', subject_key: '',
      severity: severityFor(r.priority, settings.volume_gap_working_days, lowPipelineRoles.has(r.role_id)),
      is_shadow: shadow,
      evidence: {
        rule: settings.qualified_rule, min: settings.volume_min_qualified, window_days: settings.volume_window_days,
        weekly_qualified: latest.count,
        shortlisted: r.apps.filter(a => inWindow(a.shortlisted_at)).length,
        scored: r.apps.filter(a => inWindow(a.scored_at)).length,
        per_day: perDay,
      },
    });
  }
  return out;
}

// ─── 4. BLOCKER_OVERDUE ────────────────────────────────────────────────────────────────────────────────
export interface BlockedException {
  id: string;
  plan_id: string;
  channel: string;
  priority: string;
  blocker_due: string;               // IST 'YYYY-MM-DD'
  blocker_owner_user_id: string | null;
  original_type: string;
}

export function detectBlockerOverdue(blocked: BlockedException[], today: string): DetectedException[] {
  return blocked
    .filter(b => b.blocker_due < today)
    .map(b => {
      const days = daysBetween(b.blocker_due, today);
      return {
        plan_id: b.plan_id, channel: b.channel, type: 'BLOCKER_OVERDUE' as const, subject_key: b.id,
        severity: severityFor(b.priority, days, false), is_shadow: false,
        evidence: { blocker_due: b.blocker_due, days_overdue: days, original_type: b.original_type, original_exception_id: b.id },
      };
    });
}

// ─── The runner ────────────────────────────────────────────────────────────────────────────────────────
let lastRunAt = 0;
const THROTTLE_MS = 3 * 60 * 1000;

/** Throttled opportunistic run (same pattern as dashboard.ts maybeRunSlaCheck: stamp BEFORE running). */
export async function maybeRunSourcingCheck(): Promise<void> {
  if (!isSourcingEnabled()) return;
  const now = Date.now();
  if (now - lastRunAt < THROTTLE_MS) return;
  lastRunAt = now;
  try {
    await runSourcingCheck();
  } catch (err) {
    console.error('[Sourcing] compute-on-read check failed:', err);
  }
}

export interface SourcingCheckSummary { desired: number; opened: number; reopened: number; cleared: number }

export async function runSourcingCheck(now: Date = new Date()): Promise<SourcingCheckSummary> {
  const today = istDate(now);
  await stampGoLiveDefaults(today);   // first enabled run: go-live = today, threshold detectors shadow for 6 weeks
  const settings = await loadSettings();

  // A role that reached Approved without a draft plan (hook failed, or pre-existing) gets one here — idempotent.
  await ensureDraftPlansForOpenRoles();

  // Wave 1 — commitments + roles awaiting a plan (2 concurrent).
  const [commitments, planRoles] = await Promise.all([
    query<OpenCommitment & { plan_id: string }>(
      `SELECT p.id::text AS plan_id, p.status AS plan_status, p.role_id, r.priority,
              ch.channel, ch.state AS channel_state, c.kind, c.title, c.due_at, c.meta
         FROM sourcing_commitments c
         JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id
         JOIN sourcing_plans p ON p.id = ch.plan_id
         JOIN roles r ON r.id = p.role_id
        WHERE c.status = 'open' AND p.status = 'active'`),
    query<RoleForPlanCheck>(
      `SELECT p.id::text AS plan_id, p.role_id, r.priority, to_char(r.approval_date,'YYYY-MM-DD') AS approval_date,
              p.status AS plan_status
         FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
        WHERE r.status = ANY($1::text[]) AND p.status = 'draft'`, [OPEN_ROLE_STATUSES as unknown as string[]]),
  ]);

  // Wave 2 — volume inputs + blocked exceptions (2 concurrent).
  const [volumeRoles, blockedRows] = await Promise.all([
    query<{ plan_id: string; plan_status: string; role_id: string; priority: string }>(
      `SELECT p.id::text AS plan_id, p.status AS plan_status, p.role_id, r.priority
         FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
        WHERE r.status = ANY($1::text[]) AND p.status IN ('draft','active') AND r.priority IN ('P0','P1')`,
      [OPEN_ROLE_STATUSES as unknown as string[]]),
    query<BlockedException & { original_type: string }>(
      `SELECT e.id::text AS id, e.plan_id::text AS plan_id, e.channel, r.priority, to_char(e.blocker_due,'YYYY-MM-DD') AS blocker_due,
              e.blocker_owner_user_id::text AS blocker_owner_user_id, e.type AS original_type
         FROM sourcing_exceptions e
         JOIN sourcing_plans p ON p.id = e.plan_id JOIN roles r ON r.id = p.role_id
        WHERE e.status = 'blocked' AND e.blocker_due IS NOT NULL AND p.status IN ('active','draft')`),
  ]);

  // Wave 3 — application timestamps for the volume rule + low-pipeline flags (sequential).
  const volumeRoleIds = volumeRoles.map(v => v.role_id);
  const appRows = volumeRoleIds.length
    ? await query<{ role_id: string; shortlisted_at: Date | null; scored_at: Date | null }>(
        `SELECT a.role_id, ${QUALIFIED_TIMESTAMPS_SQL}
           FROM applications a
          WHERE a.role_id = ANY($1::text[])
            AND (a.score_computed_at >= $2 OR a.last_updated >= $2 OR a.application_date >= $2)`,
        [volumeRoleIds, new Date(now.getTime() - 21 * 86400000)])
    : [];

  const allRoleIds = [...new Set([...commitments.map(c => c.role_id), ...planRoles.map(r => r.role_id), ...volumeRoleIds])];
  const lowPipelineRoles = new Set<string>();
  if (allRoleIds.length) {
    const lp = await query<{ role_id: string; active_count: string; shortlisted_count: string }>(
      `SELECT a.role_id,
              count(*) FILTER (WHERE a.status = 'Active') AS active_count,
              count(*) FILTER (WHERE a.status = 'Active' AND a.stage <> 'Applied and Screened') AS shortlisted_count
         FROM applications a WHERE a.role_id = ANY($1::text[]) GROUP BY a.role_id`, [allRoleIds]);
    const seen = new Set(lp.map(x => x.role_id));
    for (const x of lp) {
      if (isLowPipeline({ active_count: Number(x.active_count), shortlisted_count: Number(x.shortlisted_count) })) lowPipelineRoles.add(x.role_id);
    }
    for (const id of allRoleIds) if (!seen.has(id)) lowPipelineRoles.add(id); // no applications at all ⇒ low pipeline
  }

  const byRole = new Map<string, QualifiedInput[]>();
  for (const a of appRows) {
    const list = byRole.get(a.role_id) ?? [];
    list.push({ shortlisted_at: a.shortlisted_at ? new Date(a.shortlisted_at) : null, scored_at: a.scored_at ? new Date(a.scored_at) : null });
    byRole.set(a.role_id, list);
  }

  const draftPlanIds = new Set(volumeRoles.filter(v => v.plan_status === 'draft').map(v => v.plan_id));
  const desired: DetectedException[] = [
    ...detectCommitmentExceptions(commitments, now, lowPipelineRoles),
    ...detectPlanNotActivated(planRoles, now, settings, lowPipelineRoles),
    // A draft plan has not been committed to yet: its volume signal stays provisional until the plan is activated, whatever the
    // shadow period says (a draft can still raise PLAN_NOT_ACTIVATED — that is not a threshold signal).
    ...detectVolumeGap(volumeRoles.map(v => ({ ...v, apps: byRole.get(v.role_id) ?? [] })), now, settings, lowPipelineRoles)
      .map(d => draftPlanIds.has(d.plan_id) ? { ...d, is_shadow: true } : d),
    ...detectBlockerOverdue(blockedRows, today),
  ];

  return reconcileExceptions(desired, today);
}

/** Upsert the desired set, reopen snoozes that have lapsed, auto-clear what is no longer true. */
export async function reconcileExceptions(desired: DetectedException[], today: string): Promise<SourcingCheckSummary> {
  const cols = {
    plan: desired.map(d => d.plan_id),
    channel: desired.map(d => d.channel),
    type: desired.map(d => d.type),
    subject: desired.map(d => d.subject_key),
    severity: desired.map(d => d.severity),
    shadow: desired.map(d => d.is_shadow),
    evidence: desired.map(d => JSON.stringify(d.evidence)),
  };

  const inserted = await query<{ id: string }>(
    `INSERT INTO sourcing_exceptions (plan_id, channel, type, subject_key, severity, is_shadow, evidence, status)
     SELECT d.plan_id, d.channel, d.type, d.subject_key, d.severity, d.is_shadow, d.evidence::jsonb, 'open'
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::bool[], $7::text[])
            AS d(plan_id, channel, type, subject_key, severity, is_shadow, evidence)
     ON CONFLICT (plan_id, channel, type, subject_key) WHERE status IN ('open','snoozed','blocked')
     DO UPDATE SET last_seen_at = NOW(), severity = EXCLUDED.severity, is_shadow = EXCLUDED.is_shadow,
                   evidence = EXCLUDED.evidence
        WHERE sourcing_exceptions.status = 'open'
     RETURNING id::text AS id, (xmax = 0) AS inserted`,
    [cols.plan, cols.channel, cols.type, cols.subject, cols.severity, cols.shadow, cols.evidence],
  );

  const reopened = await query<{ id: string }>(
    `UPDATE sourcing_exceptions e
        SET status = 'open', reopen_count = e.reopen_count + 1, last_seen_at = NOW(), snooze_until = NULL
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) AS d(plan_id, channel, type, subject_key)
      WHERE e.status = 'snoozed' AND e.snooze_until < $5::date
        AND e.plan_id = d.plan_id AND e.channel = d.channel AND e.type = d.type AND e.subject_key = d.subject_key
      RETURNING e.id::text AS id`,
    [cols.plan, cols.channel, cols.type, cols.subject, today],
  );

  const cleared = await query<{ id: string }>(
    `UPDATE sourcing_exceptions e
        SET status = 'resolved', resolution_path = COALESCE(e.resolution_path, 'auto_cleared'), resolved_at = NOW()
      WHERE e.status IN ('open','snoozed','blocked')
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) AS d(plan_id, channel, type, subject_key)
           WHERE e.plan_id = d.plan_id AND e.channel = d.channel AND e.type = d.type AND e.subject_key = d.subject_key)
      RETURNING e.id::text AS id`,
    [cols.plan, cols.channel, cols.type, cols.subject],
  );

  const opened = (inserted as unknown as Array<{ inserted: boolean }>).filter(r => r.inserted).length;
  return { desired: desired.length, opened, reopened: reopened.length, cleared: cleared.length };
}
