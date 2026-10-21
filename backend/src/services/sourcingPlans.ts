// Sourcing plan lifecycle: seed → activate → complete/skip/reopen commitments → resolve exceptions,
// plus the role-change hook. Spec: docs/SourcingModule_PRD_v2.md.
//
// Rules this file enforces:
//   * Every hook that runs from an existing flow (onRoleSaved) is gated on SOURCING_ENABLED, has its own
//     try/catch and tolerates a missing table — it can never fail a role save or an ingest.
//   * Due dates anchor to the plan's ACTIVATION date (working days, IST), never to an old approval date.
//   * A commitment is created only when its evidence path exists; completing `activate_channel` spawns
//     the channel's follow-ons (utils/sourcingTemplates.ts).
//   * roles.recruitment_mode stays consistent: seeded into the draft plan, mirrored plan → role when the
//     plan adds a channel, and reconciled back into the plan if it is edited on the role directly.
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db/index.js';
import { JwtPayload } from '../types/index.js';
import { SMOKE_EMAIL_DOMAIN } from '../middleware/auth.js';
import {
  isSourcingChannel, isSourcingEnabled, isTrackedChannel, OPEN_ROLE_STATUSES, parseQualifiedTarget, parseWeeklyTarget, SOURCING_CHANNELS, SourcingSettings,
} from '../utils/sourcingConfig.js';
import { planTransitionFor, PlanStatus } from '../utils/sourcingPlanTransitions.js';
import {
  activationSpec, CommitmentSpec, dueAtFor, followOnSpecs, nextDueDate,
} from '../utils/sourcingTemplates.js';
import { addCalendarDays, endOfIstDay, istDate, WorkingCalendar } from '../utils/workingDays.js';
import { loadSettings } from './sourcingSettings.js';
import { qualifiedInWindow, QualifiedInput, QUALIFIED_TIMESTAMPS_SQL } from '../utils/sourcingQualified.js';
import { describeException } from '../utils/sourcingDescribe.js';
import { describeChange, TimelineCategory } from '../utils/sourcingTimeline.js';
import {
  completedWindows, currentWindow, DayCount, effectiveAnchor, isTargetMet, partialWindow, sumWindow, summarizeWeeks,
} from '../utils/sourcingWeeks.js';

export class SourcingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const calOf = (_s: SourcingSettings): WorkingCalendar => ({});          // Mon–Fri; public holidays are not modelled
const OPEN_STATUSES = OPEN_ROLE_STATUSES as unknown as string[];

// ─── Draft-plan seeding ─────────────────────────────────────────────────────────────────────────────
/**
 * Create a draft plan (channels seeded from roles.recruitment_mode) for every open role that lacks one.
 * Idempotent; also the backfill and the engine's safety net if a hook ever failed.
 */
export async function ensureDraftPlansForOpenRoles(onlyRoleId?: string): Promise<number> {
  const created = await query<{ id: string }>(
    `INSERT INTO sourcing_plans (role_id)
     SELECT r.id FROM roles r
      WHERE r.status = ANY($1::text[]) AND ($2::text IS NULL OR r.id = $2)
        AND NOT EXISTS (SELECT 1 FROM sourcing_plans p WHERE p.role_id = r.id)
     ON CONFLICT (role_id) DO NOTHING
     RETURNING id::text AS id`,
    [OPEN_STATUSES, onlyRoleId ?? null],
  );
  if (created.length) {
    await query(
      `INSERT INTO sourcing_plan_channels (plan_id, channel, state)
       SELECT p.id, ch, 'planned'
         FROM sourcing_plans p JOIN roles r ON r.id = p.role_id,
              unnest(COALESCE(r.recruitment_mode, '{}'::text[])) AS ch
        WHERE p.id = ANY($1::bigint[]) AND ch = ANY($2::text[])
       ON CONFLICT (plan_id, channel) DO NOTHING`,
      [created.map(c => c.id), SOURCING_CHANNELS as unknown as string[]],
    );
  }
  return created.length;
}

// ─── Reading a plan ─────────────────────────────────────────────────────────────────────────────────
export interface PlanRow {
  id: string; role_id: string; status: string;
  strategy_note: string | null; baseline: unknown; baseline_at: string | null; activated_at: string | null;
  paused_at: string | null; pause_total_days: number; closed_at: string | null;
  /** Per-role target of qualified candidates in the last 7 days. NULL = the default (P0/P1 only). */
  weekly_qualified_target: number | null;
}

export async function getPlanRowByRole(roleId: string): Promise<PlanRow | null> {
  return queryOne<PlanRow>(
    `SELECT p.id::text AS id, p.role_id, p.status,
            p.strategy_note, p.baseline, p.baseline_at, p.activated_at, p.paused_at, p.pause_total_days, p.closed_at, p.weekly_qualified_target
       FROM sourcing_plans p WHERE p.role_id = $1`, [roleId]);
}

export async function getPlanRowById(id: string): Promise<PlanRow | null> {
  return queryOne<PlanRow>(
    `SELECT p.id::text AS id, p.role_id, p.status,
            p.strategy_note, p.baseline, p.baseline_at, p.activated_at, p.paused_at, p.pause_total_days, p.closed_at, p.weekly_qualified_target
       FROM sourcing_plans p WHERE p.id = $1::bigint`, [id]);
}

/** Weekly performance tracker of one channel. Only LinkedIn, Naukri/IIMjobs and Direct Outreach have one (`applicable`). */
export interface ChannelTracker {
  applicable: boolean;
  target: number | null;            // weekly sourcing target: qualified + unqualified applicants tagged with the channel
  anchor: string | null;            // first day of the tracker; null = not tracking (channel not live, closed, or no target yet)
  link: string | null;              // the post / campaign link logged with the first task
  running: { start: string; end: string; actual: number; qualified: number; target: number } | null;
  weeks: Array<{ week_start: string; week_end: string; target: number; actual: number; qualified: number; met: boolean; partial: boolean }>;   // finished weeks, newest first
  totals: { weeks: number; met: number; actual: number; target: number };
  sourced: { applications: number; qualified: number };   // everything tagged with this channel on this role, all time
}

export interface PlanView {
  plan: PlanRow;
  role: { id: string; title: string; priority: string; status: string; num_openings: number | null; hiring_manager_name: string | null; recruitment_mode: string[] | null; approval_date: string | null };
  channels: Array<{
    id: string; channel: string;
    /** planned = not live yet · active = live · excluded = left out · closed = was in the plan and was closed (summary kept; can be reopened). */
    state: 'planned' | 'active' | 'excluded' | 'closed';
    excluded_reason: string | null; closed_at: string | null; closed_reason: string | null;
    config: Record<string, unknown>; targets: Record<string, unknown>;
    tracker: ChannelTracker;
    commitments: Array<{
      id: string; kind: string; title: string; due_at: string; due_date: string; status: string; cadence_days: number | null; last_done_at: string | null;
      meta: Record<string, unknown>; overdue: boolean;
      evidence: { auto: number; self: number };
      recent: Array<{ done_at: string; was_due_at: string; on_time: boolean; note: string | null; evidence: Array<{ kind: string; ref: string | null; source: string }> }>;
    }>;
  }>;
  exceptions: Array<{
    id: string; channel: string; type: string; status: string; severity: number; is_shadow: boolean; detected_at: string; last_seen_at: string;
    evidence: Record<string, unknown>; resolution_path: string | null; reason: string | null; corrective_action: string | null;
    snooze_until: string | null; blocker_due: string | null; blocker_owner_name: string | null; resolved_at: string | null;
    committed: string; happened: string; next_action: string;      // plain-language description of the objective facts
  }>;
  changes: Array<{ id: string; at: string; by_name: string | null; change: unknown; reason: string | null; text: string; category: TimelineCategory }>;
  changes_total: number;
  volume: {
    weekly_qualified: number; shortlisted: number; scored: number; min: number; rule: string; applicable: boolean;
    /** The target in force: this role's own (role), the default for a P0/P1 role (default), or none (P2/P3 until one is set). */
    target_source: 'role' | 'default' | 'none'; role_target: number | null; default_target: number | null;
  };
  output: Array<{ tag: string; applications: number; qualified: number }>;
  attribution_reliable: Record<string, boolean>;
  settings: { go_live_date: string | null; qualified_rule: string; shadow_until: string | null };
}

/** How many plan-history entries a plan view carries. */
export const HISTORY_LIMIT = 200;

/**
 * The "qualified in the last 7 days" target in force for a role: its own (set on the plan), else the default for a P0/P1 role
 * (settings.volume_min_qualified, the SOP's 5), else none — a P2/P3 role has no target until someone sets one.
 */
export function effectiveTarget(roleTarget: number | null, priority: string, settings: Pick<SourcingSettings, 'volume_min_qualified'>): {
  min: number; applicable: boolean; target_source: 'role' | 'default' | 'none'; role_target: number | null; default_target: number | null;
} {
  const defaultTarget = priority === 'P0' || priority === 'P1' ? settings.volume_min_qualified : null;
  const min = roleTarget ?? defaultTarget;
  return {
    min: min ?? 0, applicable: min !== null,
    target_source: roleTarget !== null ? 'role' : defaultTarget !== null ? 'default' : 'none',
    role_target: roleTarget, default_target: defaultTarget,
  };
}

export async function getPlanView(roleId: string, now: Date = new Date()): Promise<PlanView | null> {
  const plan = await getPlanRowByRole(roleId);
  if (!plan) return null;
  const settings = await loadSettings();
  // Finish any tracker week that has ended since anyone last looked (idempotent; one cheap query when nothing is pending).
  await syncChannelWeeksSafe(plan.id, now);

  const [role, channels, exceptions, changes, changesTotal, volumeApps, outputRows] = await Promise.all([
    queryOne<PlanView['role']>(
      `SELECT id, title, priority, status, num_openings, hiring_manager_name, recruitment_mode, to_char(approval_date,'YYYY-MM-DD') AS approval_date
         FROM roles WHERE id = $1`, [roleId]),
    query<{ id: string; channel: string; state: string; excluded_reason: string | null; closed_at: Date | null; closed_reason: string | null; tracker_anchor: string | null;
            config: Record<string, unknown>; targets: Record<string, unknown> }>(
      `SELECT id::text AS id, channel, state, excluded_reason, closed_at, closed_reason, to_char(tracker_anchor,'YYYY-MM-DD') AS tracker_anchor, config, targets
         FROM sourcing_plan_channels WHERE plan_id = $1::bigint ORDER BY id`, [plan.id]),
    query<Omit<PlanView['exceptions'][number], 'committed' | 'happened' | 'next_action'>>(
      `SELECT e.id::text AS id, e.channel, e.type, e.status, e.severity, e.is_shadow, e.detected_at, e.last_seen_at, e.evidence,
              e.resolution_path, e.reason, e.corrective_action, to_char(e.snooze_until,'YYYY-MM-DD') AS snooze_until,
              to_char(e.blocker_due,'YYYY-MM-DD') AS blocker_due, bu.name AS blocker_owner_name, e.resolved_at
         FROM sourcing_exceptions e LEFT JOIN users bu ON bu.id = e.blocker_owner_user_id
        WHERE e.plan_id = $1::bigint AND (e.status <> 'resolved' OR e.resolved_at > NOW() - INTERVAL '14 days')
        ORDER BY (e.status = 'resolved'), e.severity DESC, e.detected_at DESC`, [plan.id]),
    query<{ id: string; at: Date; by_name: string | null; change: { type?: string }; reason: string | null }>(
      `SELECT c.id::text AS id, c.at, u.name AS by_name, c.change, c.reason FROM sourcing_plan_changes c LEFT JOIN users u ON u.id = c."by"
        WHERE c.plan_id = $1::bigint ORDER BY c.at DESC, c.id DESC LIMIT ${HISTORY_LIMIT}`, [plan.id]),
    queryOne<{ n: string }>(`SELECT count(*) AS n FROM sourcing_plan_changes WHERE plan_id = $1::bigint`, [plan.id]),
    query<{ shortlisted_at: Date | null; scored_at: Date | null }>(
      `SELECT ${QUALIFIED_TIMESTAMPS_SQL} FROM applications a
        WHERE a.role_id = $1 AND (a.score_computed_at >= $2 OR a.last_updated >= $2 OR a.application_date >= $2)`,
      [roleId, new Date(now.getTime() - 21 * 86400000)]),
    query<{ tag: string; applications: string; qualified: string }>(
      `SELECT COALESCE(NULLIF(a.sub_source,''),'(untagged)') AS tag, count(*) AS applications,
              count(*) FILTER (WHERE a.ai_fit_score > 60 OR a.stage <> 'Applied and Screened') AS qualified
         FROM applications a WHERE a.role_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [roleId]),
  ]);
  if (!role) return null;

  const commitmentRows = channels.length
    ? await query<{ id: string; plan_channel_id: string; kind: string; title: string; due_at: Date; status: string; cadence_days: number | null; last_done_at: Date | null; meta: Record<string, unknown> }>(
        `SELECT id::text AS id, plan_channel_id::text AS plan_channel_id, kind, title, due_at, status, cadence_days, last_done_at, meta
           FROM sourcing_commitments WHERE plan_channel_id = ANY($1::bigint[])
            AND NOT (kind = 'weekly_outbound' AND status = 'skipped')   -- retired by the weekly tracker: its log stays, it is not shown
          ORDER BY id`, [channels.map(c => c.id)])
    : [];
  const commitmentIds = commitmentRows.map(c => c.id);
  const logRows = commitmentIds.length
    ? await query<{ id: string; commitment_id: string; done_at: Date; was_due_at: Date; note: string | null }>(
        `SELECT id::text AS id, commitment_id::text AS commitment_id, done_at, was_due_at, note FROM (
           SELECT l.*, row_number() OVER (PARTITION BY l.commitment_id ORDER BY l.done_at DESC) AS rn
             FROM sourcing_commitment_log l WHERE l.commitment_id = ANY($1::bigint[])) t WHERE rn <= 3 ORDER BY done_at DESC`, [commitmentIds])
    : [];
  const evRows = logRows.length
    ? await query<{ log_id: string; kind: string; ref: string | null; source: string }>(
        `SELECT log_id::text AS log_id, kind, ref, source FROM sourcing_evidence WHERE log_id = ANY($1::bigint[])`, [logRows.map(l => l.id)])
    : [];
  const evCounts = commitmentIds.length
    ? await query<{ commitment_id: string; source: string; n: string }>(
        `SELECT l.commitment_id::text AS commitment_id, e.source, count(*) AS n
           FROM sourcing_commitment_log l JOIN sourcing_evidence e ON e.log_id = l.id
          WHERE l.commitment_id = ANY($1::bigint[]) GROUP BY 1, 2`, [commitmentIds])
    : [];

  const output = outputRows.map(o => ({ tag: o.tag, applications: Number(o.applications), qualified: Number(o.qualified) }));

  // ── weekly trackers (LinkedIn / Naukri/IIMjobs / Direct Outreach) ──
  const today = istDate(now);
  const weekRows = channels.length
    ? await query<{ plan_channel_id: string; week_start: string; week_end: string; target: number; actual: number; qualified: number; partial: boolean }>(
        `SELECT plan_channel_id::text AS plan_channel_id, to_char(week_start,'YYYY-MM-DD') AS week_start, to_char(week_end,'YYYY-MM-DD') AS week_end,
                target, actual, qualified, partial
           FROM sourcing_channel_weeks WHERE plan_channel_id = ANY($1::bigint[]) ORDER BY week_start DESC`, [channels.map(c => c.id)])
    : [];
  const anchored = plan.status === 'active' ? channels.filter(c => c.tracker_anchor && c.state === 'active') : [];
  const dayRows = anchored.length
    ? await query<{ channel: string; d: string; n: string; q: string }>(
        `SELECT a.sub_source AS channel, to_char((a.application_date AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d, count(*) AS n,
                count(*) FILTER (WHERE a.ai_fit_score > 60 OR a.stage <> 'Applied and Screened') AS q
           FROM applications a
          WHERE a.role_id = $1 AND a.sub_source = ANY($2::text[]) AND (a.application_date AT TIME ZONE 'Asia/Kolkata')::date >= $3::date
          GROUP BY 1, 2`,
        [roleId, anchored.map(c => c.channel), anchored.map(c => c.tracker_anchor!).sort()[0]])
    : [];
  const trackerOf = (ch: typeof channels[number]): ChannelTracker => {
    const target = parseWeeklyTarget(ch.targets?.weekly_target) ;
    const rows = weekRows.filter(w => w.plan_channel_id === ch.id).map(w => ({
      week_start: w.week_start, week_end: w.week_end, target: w.target, actual: w.actual, qualified: w.qualified, met: isTargetMet(w.actual, w.target), partial: w.partial,
    }));
    const src = output.find(o => o.tag === ch.channel);
    let running: ChannelTracker['running'] = null;
    const live = ch.state === 'active' && plan.status === 'active';
    const lastEnd = rows.length ? rows[0].week_end : null;                   // newest first
    // The day counting really starts: a tracker restarted on the day a week was cut short begins the next day (that day is already in the cut-short week).
    const startsOn = ch.tracker_anchor && live ? effectiveAnchor(ch.tracker_anchor, lastEnd) : null;
    if (startsOn && target !== null) {
      const w = currentWindow(startsOn, today);
      if (w) {
        const byDay = new Map<string, DayCount>(dayRows.filter(r => r.channel === ch.channel).map(r => [r.d, { n: Number(r.n), q: Number(r.q) }]));
        const t = sumWindow(byDay, w);
        running = { start: w.start, end: w.end, actual: t.actual, qualified: t.qualified, target };
      }
    }
    return {
      applicable: isTrackedChannel(ch.channel), target, anchor: startsOn,
      link: typeof ch.config?.posting_url === 'string' ? ch.config.posting_url as string : null,
      running, weeks: rows, totals: summarizeWeeks(rows),
      sourced: { applications: src?.applications ?? 0, qualified: src?.qualified ?? 0 },
    };
  };

  const nowMs = now.getTime();
  const channelViews: PlanView['channels'] = channels.map(ch => ({
    id: ch.id, channel: ch.channel,
    state: (ch.state === 'excluded' && ch.closed_at ? 'closed' : ch.state) as PlanView['channels'][number]['state'],
    excluded_reason: ch.state === 'excluded' && !ch.closed_at ? ch.excluded_reason : null,
    closed_at: ch.closed_at ? new Date(ch.closed_at).toISOString() : null, closed_reason: ch.closed_reason,
    config: ch.config, targets: ch.targets,
    tracker: trackerOf(ch),
    commitments: commitmentRows.filter(c => c.plan_channel_id === ch.id).map(c => {
      const due = new Date(c.due_at);
      return {
        id: c.id, kind: c.kind, title: c.title, due_at: due.toISOString(), due_date: istDate(due), status: c.status,
        cadence_days: c.cadence_days, last_done_at: c.last_done_at ? new Date(c.last_done_at).toISOString() : null, meta: c.meta ?? {},
        overdue: c.status === 'open' && due.getTime() < nowMs,
        evidence: {
          auto: Number(evCounts.find(e => e.commitment_id === c.id && e.source === 'auto')?.n ?? 0),
          self: Number(evCounts.find(e => e.commitment_id === c.id && e.source === 'self')?.n ?? 0),
        },
        recent: logRows.filter(l => l.commitment_id === c.id).map(l => ({
          done_at: new Date(l.done_at).toISOString(), was_due_at: new Date(l.was_due_at).toISOString(),
          on_time: new Date(l.done_at).getTime() <= new Date(l.was_due_at).getTime(), note: l.note,
          evidence: evRows.filter(e => e.log_id === l.id).map(e => ({ kind: e.kind, ref: e.ref, source: e.source })),
        })),
      };
    }),
  }));

  const apps: QualifiedInput[] = volumeApps.map(a => ({
    shortlisted_at: a.shortlisted_at ? new Date(a.shortlisted_at) : null, scored_at: a.scored_at ? new Date(a.scored_at) : null,
  }));
  const w = qualifiedInWindow(apps, now, settings.volume_window_days, settings.qualified_rule);
  const attribution_reliable: Record<string, boolean> = {};
  for (const ch of SOURCING_CHANNELS) attribution_reliable[ch] = (output.find(o => o.tag === ch)?.applications ?? 0) >= 5;

  return {
    plan, role, channels: channelViews, exceptions: exceptions.map(e => ({ ...e, ...describeException(e) })),
    changes: changes.map(c => ({
      id: c.id, at: new Date(c.at).toISOString(), by_name: c.by_name, change: c.change, reason: c.reason, ...describeChange(c.change),
    })),
    changes_total: Number(changesTotal?.n ?? 0),
    volume: {
      weekly_qualified: w.qualified, shortlisted: w.shortlisted, scored: w.scored, rule: settings.qualified_rule,
      ...effectiveTarget(plan.weekly_qualified_target, role.priority, settings),
    },
    output, attribution_reliable,
    settings: { go_live_date: settings.go_live_date, qualified_rule: settings.qualified_rule, shadow_until: settings.shadow_until },
  };
}

/**
 * A Hiring Manager gets a PARTLY redacted view: no strategy note, baseline, history, URLs, completion notes,
 * exception reasons/evidence or provisional signals. A channel's excluded_reason and an exception's resolution_path,
 * snooze_until and blocker_due still come through — left as is on purpose (see CLAUDE.md, Sourcing → Access).
 */
export function redactForHiringManager(v: PlanView): PlanView {
  return {
    ...v,
    plan: { ...v.plan, strategy_note: null, baseline: null },
    changes: [], changes_total: 0,
    exceptions: v.exceptions.filter(e => !e.is_shadow && e.status !== 'resolved').map(e => ({
      ...e, evidence: {}, reason: null, corrective_action: null, blocker_owner_name: null,
    })),
    channels: v.channels.map(c => ({
      ...c, config: {}, closed_reason: null, tracker: { ...c.tracker, link: null },
      commitments: c.commitments.map(m => ({ ...m, recent: m.recent.map(r => ({ ...r, note: null, evidence: [] })) })),
    })),
  };
}

/** Who can be named as the owner of a BLOCKER (the person expected to unblock it) — any active person except the smoke-test accounts.
    A plan itself has no individual owner: sourcing belongs to the HR/Admin persona as a whole. */
export async function listPeople(): Promise<Array<{ id: string; name: string; persona: string }>> {
  return query(`SELECT id::text AS id, name, persona FROM users WHERE is_active = true AND email NOT LIKE '%@' || $1 ORDER BY name`, [SMOKE_EMAIL_DOMAIN]);
}

// ─── Channel / plan mutations ───────────────────────────────────────────────────────────────────────
/** Write one plan-history entry. EVERY action in the sourcing workspace goes through here (userId null = the system did it), so the
    timeline is complete: tasks done / skipped / reopened, channels added / closed / reopened, targets, exceptions, weekly results. */
export async function logChange(client: PoolClient, planId: string, userId: string | null, change: Record<string, unknown>, reason?: string | null, at?: Date) {
  await client.query(
    `INSERT INTO sourcing_plan_changes (plan_id, "by", change, reason, at) VALUES ($1::bigint, $2, $3::jsonb, $4, COALESCE($5::timestamptz, NOW()))`,
    [planId, userId, JSON.stringify(change), reason ?? null, at ?? null]);
}

/** Same, outside a transaction (the engine and the weekly sync). Never call this while holding a plan row lock: the foreign key waits on it. */
export async function logChangeQ(planId: string, userId: string | null, change: Record<string, unknown>, reason?: string | null, at?: Date) {
  await query(
    `INSERT INTO sourcing_plan_changes (plan_id, "by", change, reason, at) VALUES ($1::bigint, $2, $3::jsonb, $4, COALESCE($5::timestamptz, NOW()))`,
    [planId, userId, JSON.stringify(change), reason ?? null, at ?? null]);
}

/** Add channel(s) to roles.recruitment_mode (plan → role, one way) with the same audit trail the role PATCH writes. */
async function mirrorChannelToRole(client: PoolClient, roleId: string, channel: string, userId: string | null) {
  const cur = await client.query(`SELECT recruitment_mode FROM roles WHERE id = $1 FOR UPDATE`, [roleId]);
  const old: string[] = cur.rows[0]?.recruitment_mode ?? [];
  if (old.includes(channel)) return;
  const next = [...old, channel];
  await client.query(`UPDATE roles SET recruitment_mode = $1::text[] WHERE id = $2`, [next, roleId]);
  await client.query(
    `INSERT INTO role_edit_log (role_id, field_name, old_value, new_value, changed_by) VALUES ($1,'recruitment_mode',$2,$3,$4)`,
    [roleId, old.join(','), next.join(','), userId]);
}

async function upsertCommitment(client: PoolClient, planChannelId: string, spec: CommitmentSpec): Promise<string> {
  const r = await client.query(
    `INSERT INTO sourcing_commitments (plan_channel_id, kind, subject_key, title, cadence_days, due_at, status, meta, last_done_at)
     VALUES ($1::bigint, $2, $3, $4, $5, $6, 'open', $7::jsonb, NULL)
     ON CONFLICT (plan_channel_id, kind, subject_key)
     DO UPDATE SET title = EXCLUDED.title, cadence_days = EXCLUDED.cadence_days, due_at = EXCLUDED.due_at,
                   status = 'open', meta = EXCLUDED.meta, last_done_at = NULL
     RETURNING id::text AS id`,
    [planChannelId, spec.kind, spec.subject_key, spec.title, spec.cadence_days, dueAtFor(spec), JSON.stringify(spec.meta)]);
  return r.rows[0].id as string;
}

/**
 * Every path that changes a plan's commitments, channels or exceptions takes the PLAN's row lock first (setChannelState, closePlan,
 * resumePlan, updatePlan, activatePlan already do). The commitment- and exception-level paths used to lock only their own row, so they
 * could deadlock with those (complete ↔ exclude the channel) or commit against a stale plan / channel state (reopen ↔ close).
 * Plan first, then channel, then commitment, everywhere — and the state is read AFTER the lock.
 */
async function lockPlanOfCommitment(client: PoolClient, commitmentId: string): Promise<void> {
  const r = await client.query(
    `SELECT ch.plan_id::text AS plan_id FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id WHERE c.id = $1::bigint`, [commitmentId]);
  if (r.rows[0]) await client.query(`SELECT id FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [r.rows[0].plan_id]);
}

async function lockPlanOfException(client: PoolClient, exceptionId: string): Promise<void> {
  const r = await client.query(`SELECT plan_id::text AS plan_id FROM sourcing_exceptions WHERE id = $1::bigint`, [exceptionId]);
  if (r.rows[0]) await client.query(`SELECT id FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [r.rows[0].plan_id]);
}

/** The exact reason written when a channel is dropped because it was removed from the role's Recruitment Mode. Matched EXACTLY, never by
    prefix: a recruiter's own free-text reason must never be mistaken for it (and resurrected by a later role edit). */
const REMOVED_ON_ROLE = 'Removed from the role’s Recruitment Mode';

/**
 * A channel just joined (or came back to) a plan that is already being tracked: give it its first commitment, due from today.
 * A draft plan creates these at activation, a closed one never does. A paused plan gets it now too — the engine ignores a
 * paused plan, and resuming moves every open date out by the time spent paused (hence the anchor below).
 */
async function startChannel(
  client: PoolClient, plan: { status: string; paused_at?: Date | string | null }, channelId: string, channel: string, now: Date, settings: SourcingSettings,
) {
  if (plan.status !== 'active' && plan.status !== 'paused') return;
  // On a paused plan resuming shifts EVERY open due date by the whole pause, so anchor to the day the pause began: shifted by the
  // pause it lands 1–2 working days after the role is back on, not a pause-length later.
  const anchor = plan.status === 'paused' && plan.paused_at ? new Date(plan.paused_at) : now;
  await upsertCommitment(client, channelId, activationSpec(channel, istDate(anchor), calOf(settings)));
}

function validUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  if (!t || t.length > 500) return null;
  try { const p = new URL(t); return (p.protocol === 'https:' || p.protocol === 'http:') ? t : null; } catch { return null; }
}

export interface CompletionInput {
  note?: string | null;
  url?: string | null;
  count?: number | null;
  attest?: boolean;
  already_running?: boolean;       // set only by plan activation: the channel was running before HMS (the history says so; an ordinary completion is not "already running")
  posted_at?: string | null;       // portals: the posting's own date
  weekly_target?: number | null;   // LinkedIn / Naukri / Direct Outreach: the weekly sourcing target (qualified + unqualified), required with the link
  auto?: { kind: string; ref?: string | null };   // reserved for P3 (gmail message id etc.)
}

/** Record a completion and roll the commitment forward. Runs inside the caller's transaction. */
async function completeInTx(
  client: PoolClient, commitmentId: string, input: CompletionInput, userId: string | null, settings: SourcingSettings, now: Date,
): Promise<{ planId: string; roleId: string }> {
  await lockPlanOfCommitment(client, commitmentId);
  const r = await client.query(
    `SELECT c.id::text AS id, c.kind, c.title, c.cadence_days, c.due_at, c.status, c.meta, ch.id::text AS channel_id, ch.channel, ch.state AS channel_state, ch.config, ch.targets,
            p.id::text AS plan_id, p.role_id, p.status AS plan_status, p.paused_at
       FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id
      WHERE c.id = $1::bigint FOR UPDATE OF c`, [commitmentId]);
  const c = r.rows[0];
  if (!c) throw new SourcingError(404, 'Commitment not found');
  // Dates that follow a completion are counted from "now" — on a paused plan from the day the pause began, because resuming shifts every open due date by the pause.
  const base: Date = c.plan_status === 'paused' && c.paused_at ? new Date(c.paused_at) : now;
  if (c.plan_status === 'draft') throw new SourcingError(409, 'Activate the plan first');
  if (c.plan_status === 'closed') throw new SourcingError(409, 'The role is closed');
  if (c.channel_state === 'excluded') throw new SourcingError(409, `${c.channel} is not in the plan — add it back first`);
  if (c.status === 'skipped') throw new SourcingError(409, 'This was skipped — undo the skip first');
  if (c.status !== 'open') throw new SourcingError(409, 'This commitment is already complete');

  // LinkedIn, Naukri/IIMjobs and Direct Outreach: logging the post needs its link and the weekly sourcing target — the target is what the
  // automatic weekly tracker measures from now on, so a post cannot be logged without one.
  const tracked = c.kind === 'activate_channel' && isTrackedChannel(c.channel);
  let weeklyTarget: number | null = null;
  if (tracked) {
    if (!input.url || !String(input.url).trim()) throw new SourcingError(400, `Add the link to the ${c.channel} post to complete this task`);
    weeklyTarget = parseWeeklyTarget(input.weekly_target);
    if (weeklyTarget === null) throw new SourcingError(400, 'Add a weekly sourcing target (a whole number of applicants, qualified and unqualified) to complete this task');
  }

  const log = await client.query(
    `INSERT INTO sourcing_commitment_log (commitment_id, done_at, was_due_at, done_by, note) VALUES ($1::bigint, $2, $3, $4, $5) RETURNING id::text AS id`,
    [commitmentId, now, c.due_at, userId, input.note?.toString().slice(0, 1000) || null]);
  const logId = log.rows[0].id as string;
  const addEvidence = (kind: string, ref: string | null, source: 'auto' | 'self') =>
    client.query(`INSERT INTO sourcing_evidence (log_id, kind, ref, source, occurred_at) VALUES ($1::bigint,$2,$3,$4,$5)`, [logId, kind, ref, source, now]);
  const url = validUrl(input.url);
  if (input.url && !url) throw new SourcingError(400, 'Evidence URL must be a valid http(s) link');
  if (url) await addEvidence('url', url, 'self');
  if (typeof input.count === 'number' && Number.isFinite(input.count) && input.count >= 0) await addEvidence('count', String(Math.round(input.count)), 'self');
  if (input.note && input.note.trim()) await addEvidence('note', input.note.trim().slice(0, 1000), 'self');
  if (input.attest) await addEvidence('attestation', null, 'self');
  if (input.auto) await addEvidence(input.auto.kind, input.auto.ref ?? null, 'auto');

  const lead = typeof c.meta?.lead_days === 'number' ? c.meta.lead_days : 0;
  if (c.cadence_days === null) {
    await client.query(`UPDATE sourcing_commitments SET status = 'done', last_done_at = $2 WHERE id = $1::bigint`, [commitmentId, now]);
  } else {
    await client.query(
      `UPDATE sourcing_commitments SET status = 'open', last_done_at = $2, due_at = $3 WHERE id = $1::bigint`,
      [commitmentId, now, endOfIstDay(nextDueDate(base, c.cadence_days, lead))]);
  }

  if (c.kind === 'activate_channel') {
    const config = { ...(c.config ?? {}) } as Record<string, unknown>;
    if (url) config.posting_url = url;
    if (input.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(input.posted_at)) config.posted_at = input.posted_at;
    const targets = { ...(c.targets ?? {}) } as Record<string, unknown>;
    if (weeklyTarget !== null) targets.weekly_target = weeklyTarget;
    // The weekly tracker starts the day the post is logged (not the posting's own, possibly older, date): that is when the target was set.
    await client.query(
      `UPDATE sourcing_plan_channels SET state = 'active', config = $2::jsonb, targets = $3::jsonb,
              tracker_anchor = CASE WHEN $4::boolean THEN $5::date ELSE tracker_anchor END WHERE id = $1::bigint`,
      [c.channel_id, JSON.stringify(config), JSON.stringify(targets), weeklyTarget !== null && c.plan_status === 'active', istDate(now)]);
    for (const spec of followOnSpecs(c.channel, base, settings, calOf(settings), { postedAt: input.posted_at })) {
      // A follow-on that is already running (open) is left alone, so completing an activation again cannot reset it. One that
      // was SKIPPED — because its channel was left out, or the role closed and was reopened — comes back with a fresh due date:
      // completing the activation again means the channel is being run again. (It used to stay skipped for good.)
      await client.query(
        `INSERT INTO sourcing_commitments (plan_channel_id, kind, subject_key, title, cadence_days, due_at, status, meta)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,'open',$7::jsonb)
         ON CONFLICT (plan_channel_id, kind, subject_key)
         DO UPDATE SET title = EXCLUDED.title, cadence_days = EXCLUDED.cadence_days, due_at = EXCLUDED.due_at,
                       status = 'open', meta = EXCLUDED.meta, last_done_at = NULL
         WHERE sourcing_commitments.status = 'skipped'`,
        [c.channel_id, spec.kind, spec.subject_key, spec.title, spec.cadence_days, dueAtFor(spec), JSON.stringify(spec.meta)]);
    }
  } else if (c.kind === 'renew_posting') {
    const config = { ...(c.config ?? {}), posted_at: istDate(now) } as Record<string, unknown>;
    if (url) config.posting_url = url;
    await client.query(`UPDATE sourcing_plan_channels SET config = $2::jsonb WHERE id = $1::bigint`, [c.channel_id, JSON.stringify(config)]);
  }
  await logChange(client, c.plan_id, userId, {
    type: 'commitment_completed', channel: c.channel, kind: c.kind, commitment: c.title,
    on_time: now.getTime() <= new Date(c.due_at).getTime(),
    ...(url ? { url } : {}), ...(weeklyTarget !== null ? { weekly_target: weeklyTarget } : {}),
    ...(input.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(input.posted_at) ? { posted_at: input.posted_at } : {}),
    ...(input.already_running ? { already_running: true } : {}),
    ...(input.attest ? { attested: true } : {}),
  }, input.note?.toString().trim().slice(0, 300) || null);
  return { planId: c.plan_id, roleId: c.role_id };
}

export interface ActivationChannelInput {
  channel: string;
  exclude_reason?: string | null;        // present ⇒ excluded
  already_running?: boolean;
  posted_at?: string | null;
  url?: string | null;
  weekly_target?: number | null;
}
export interface ActivationInput {
  strategy_note?: string | null;
  /** This role's target of qualified candidates in the last 7 days. Omitted/null ⇒ the default (P0/P1 only). */
  weekly_qualified_target?: number | null;
  channels: ActivationChannelInput[];
}

export async function activatePlan(planId: string, input: ActivationInput, user: JwtPayload, now: Date = new Date()): Promise<void> {
  const settings = await loadSettings();
  const cal = calOf(settings);
  const activationDate = istDate(now);

  if (!Array.isArray(input.channels) || input.channels.length === 0) throw new SourcingError(400, 'Choose at least one channel');
  for (const ch of input.channels) {
    if (!isSourcingChannel(ch.channel)) throw new SourcingError(400, `Unknown channel "${ch.channel}"`);
    if (ch.exclude_reason !== undefined && ch.exclude_reason !== null && !String(ch.exclude_reason).trim()) throw new SourcingError(400, `A reason is required to exclude ${ch.channel}`);
  }
  if (!input.channels.some(c => c.exclude_reason == null)) throw new SourcingError(400, 'At least one channel must stay in the plan');
  if (new Set(input.channels.map(c => c.channel)).size !== input.channels.length) throw new SourcingError(400, 'Duplicate channel in request');
  let roleTarget: number | null = null;
  if (input.weekly_qualified_target !== undefined && input.weekly_qualified_target !== null) {
    roleTarget = parseQualifiedTarget(input.weekly_qualified_target);
    if (roleTarget === null) throw new SourcingError(400, 'The weekly qualified target must be a whole number from 1 to 500');
  }

  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, role_id, status FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const plan = pr.rows[0];
    if (!plan) throw new SourcingError(404, 'Plan not found');
    if (plan.status === 'active') throw new SourcingError(409, 'This plan is already active');
    if (plan.status === 'closed') throw new SourcingError(409, 'The role is closed');
    if (plan.status !== 'draft') throw new SourcingError(409, 'The role is on hold — the plan resumes when the role is back on');   // activating a paused plan would re-open finished work

    // Flip the plan to active FIRST: an "already running" channel is completed inside this same transaction, and
    // completion refuses a draft plan. Everything below is one transaction, so a failure still leaves the plan a draft.
    await client.query(
      `UPDATE sourcing_plans SET status = 'active', activated_at = $2, baseline_at = $2, paused_at = NULL, closed_at = NULL WHERE id = $1::bigint`,
      [planId, now]);

    // Channels (add the missing ones, mirroring plan → role).
    const baselineChannels: Array<Record<string, unknown>> = [];
    for (const ch of input.channels) {
      const excluded = ch.exclude_reason != null;
      const up = await client.query(
        `INSERT INTO sourcing_plan_channels (plan_id, channel, state, excluded_reason) VALUES ($1::bigint,$2,$3,$4)
         ON CONFLICT (plan_id, channel) DO UPDATE SET state = EXCLUDED.state, excluded_reason = EXCLUDED.excluded_reason,
                       closed_at = NULL, closed_by = NULL, closed_reason = NULL   -- a channel closed in an earlier run is decided afresh here
         RETURNING id::text AS id`,
        [planId, ch.channel, excluded ? 'excluded' : 'planned', excluded ? String(ch.exclude_reason).trim() : null]);
      const channelId = up.rows[0].id as string;
      baselineChannels.push({ channel: ch.channel, state: excluded ? 'excluded' : 'planned', excluded_reason: excluded ? ch.exclude_reason : null, already_running: !!ch.already_running });
      if (excluded) {
        await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE plan_channel_id = $1::bigint AND status = 'open'`, [channelId]);
        continue;
      }
      await mirrorChannelToRole(client, plan.role_id, ch.channel, user.userId);
      const spec = activationSpec(ch.channel, activationDate, cal);
      const commitmentId = await upsertCommitment(client, channelId, spec);
      if (ch.already_running) {
        await completeInTx(client, commitmentId, {
          attest: true, already_running: true, url: ch.url, posted_at: ch.posted_at, weekly_target: ch.weekly_target, note: 'Already running at plan activation',
        }, user.userId, settings, now);
      }
    }

    await client.query(
      `UPDATE sourcing_plans SET strategy_note = COALESCE($2, strategy_note), baseline = $3::jsonb, weekly_qualified_target = COALESCE($4::int, weekly_qualified_target) WHERE id = $1::bigint`,
      [planId, input.strategy_note?.toString().slice(0, 2000) || null,
       JSON.stringify({ activated_on: activationDate, channels: baselineChannels, weekly_qualified_target: roleTarget }), roleTarget]);
    await logChange(client, planId, user.userId, { type: 'activated', channels: baselineChannels, ...(roleTarget !== null ? { weekly_qualified_target: roleTarget } : {}) }, input.strategy_note ?? null);
  });
}

export async function completeCommitment(commitmentId: string, input: CompletionInput, user: JwtPayload, now: Date = new Date()): Promise<{ planId: string; roleId: string }> {
  const settings = await loadSettings();
  return transaction(client => completeInTx(client, commitmentId, input, user.userId, settings, now));
}

export async function skipCommitment(commitmentId: string, reason: string, user: JwtPayload): Promise<void> {
  if (!reason || reason.trim().length < 3) throw new SourcingError(400, 'A reason is required to skip a commitment');
  await transaction(async (client) => {
    await lockPlanOfCommitment(client, commitmentId);
    const r = await client.query(
      `SELECT c.id::text AS id, c.title, c.status, ch.channel, p.id::text AS plan_id FROM sourcing_commitments c
         JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id WHERE c.id = $1::bigint FOR UPDATE OF c`, [commitmentId]);
    const c = r.rows[0];
    if (!c) throw new SourcingError(404, 'Commitment not found');
    if (c.status !== 'open') throw new SourcingError(409, 'Only an open commitment can be skipped');
    await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE id = $1::bigint`, [commitmentId]);
    await logChange(client, c.plan_id, user.userId, { type: 'commitment_skipped', channel: c.channel, commitment: c.title }, reason.trim().slice(0, 500));
  });
}

export async function reopenCommitment(commitmentId: string, user: JwtPayload, now: Date = new Date()): Promise<void> {
  const settings = await loadSettings();
  await transaction(async (client) => {
    await lockPlanOfCommitment(client, commitmentId);
    const r = await client.query(
      `SELECT c.id::text AS id, c.kind, c.status, c.cadence_days, ch.id::text AS channel_id, ch.channel, ch.state AS channel_state, p.id::text AS plan_id, p.role_id, p.status AS plan_status
         FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id
        WHERE c.id = $1::bigint FOR UPDATE OF c`, [commitmentId]);
    const c = r.rows[0];
    if (!c) throw new SourcingError(404, 'Commitment not found');
    if (c.plan_status !== 'active') throw new SourcingError(409, 'The plan is not active');
    if (c.status === 'open') throw new SourcingError(409, 'Already open');
    if (c.channel_state === 'excluded') throw new SourcingError(409, `${c.channel} is not in the plan — add it back first`);
    const spec = c.kind === 'activate_channel' ? activationSpec(c.channel, istDate(now), calOf(settings)) : null;
    const due = spec ? dueAtFor(spec) : endOfIstDay(addCalendarDays(istDate(now), 1));
    await client.query(`UPDATE sourcing_commitments SET status = 'open', due_at = $2 WHERE id = $1::bigint`, [commitmentId, due]);
    if (c.kind === 'activate_channel') {
      // The channel is not live again until its first task is done: stop measuring it (the week in progress is kept as cut short).
      await stopTrackersInTx(client, { id: c.plan_id, role_id: c.role_id }, [c.channel_id], istDate(now));
      await client.query(`UPDATE sourcing_plan_channels SET state = 'planned' WHERE id = $1::bigint`, [c.channel_id]);
    }
    await logChange(client, c.plan_id, user.userId, { type: 'commitment_reopened', channel: c.channel, kind: c.kind });
  });
}

export async function setChannelState(
  planId: string, channel: string, input: { state: 'planned' | 'excluded'; excluded_reason?: string | null }, user: JwtPayload, now: Date = new Date(),
): Promise<void> {
  if (!isSourcingChannel(channel)) throw new SourcingError(400, `Unknown channel "${channel}"`);
  if (input.state === 'excluded' && !(input.excluded_reason && input.excluded_reason.trim().length >= 3)) throw new SourcingError(400, 'A reason is required to exclude a channel');
  const settings = await loadSettings();
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, role_id, status, paused_at FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const plan = pr.rows[0];
    if (!plan) throw new SourcingError(404, 'Plan not found');
    if (plan.status === 'closed') throw new SourcingError(409, 'The role is closed');
    const cur = await client.query(`SELECT state, closed_at FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR NO KEY UPDATE`, [planId, channel]);
    if (cur.rows[0]?.closed_at) throw new SourcingError(409, `${channel} was closed — reopen it instead`);
    // Adding a channel that is already in the plan must change nothing: it used to re-open a finished activation and chase it again.
    if (input.state === 'planned' && cur.rows[0] && cur.rows[0].state !== 'excluded') throw new SourcingError(409, `${channel} is already in this plan`);
    const up = await client.query(
      `INSERT INTO sourcing_plan_channels (plan_id, channel, state, excluded_reason) VALUES ($1::bigint,$2,$3,$4)
       ON CONFLICT (plan_id, channel) DO UPDATE SET state = EXCLUDED.state, excluded_reason = EXCLUDED.excluded_reason
       RETURNING id::text AS id`,
      [planId, channel, input.state, input.state === 'excluded' ? input.excluded_reason!.trim() : null]);
    const channelId = up.rows[0].id as string;
    if (input.state === 'excluded') {
      await stopTrackersInTx(client, { id: planId, role_id: plan.role_id }, [channelId], istDate(now));
      await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE plan_channel_id = $1::bigint AND status = 'open'`, [channelId]);
      await logChange(client, planId, user.userId, { type: 'channel_excluded', channel }, input.excluded_reason);
    } else {
      await mirrorChannelToRole(client, plan.role_id, channel, user.userId);
      await startChannel(client, plan, channelId, channel, now, settings);
      await logChange(client, planId, user.userId, { type: 'channel_added', channel });
    }
  });
}

// ─── Weekly performance tracker ─────────────────────────────────────────────────────────────────────
/** Applications to the role tagged with the channel on the application form, qualified or not, counted per IST day from `fromDate`. */
async function dayCounts(roleId: string, channel: string, fromDate: string, toDate: string, run: (sql: string, params: unknown[]) => Promise<Array<{ d: string; n: string; q: string }>>): Promise<Map<string, DayCount>> {
  const rows = await run(
    `SELECT to_char((a.application_date AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d, count(*) AS n,
            count(*) FILTER (WHERE a.ai_fit_score > 60 OR a.stage <> 'Applied and Screened') AS q
       FROM applications a
      WHERE a.role_id = $1 AND a.sub_source = $2
        AND (a.application_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3::date AND $4::date
      GROUP BY 1`, [roleId, channel, fromDate, toDate]);
  return new Map(rows.map(r => [r.d, { n: Number(r.n), q: Number(r.q) }]));
}

/**
 * Finish every tracker week that has ended: one immutable row per week (target vs applicants tagged with the channel) and one plan-history
 * entry stamped with the day the week ended. Idempotent and race-safe (UNIQUE + ON CONFLICT DO NOTHING; only the writer that inserted a row logs it).
 * Only a LIVE channel on an ACTIVE plan is measured: a channel that is closed, left out, planned again or on a role that is on hold has its
 * tracker stopped (the week in progress recorded as cut short, the start cleared) and starts again from the day it is live again.
 * Call it with no row locks held.
 * `planId` null = every active plan (the engine / daily cron).
 */
export async function syncChannelWeeks(planId: string | null, now: Date = new Date()): Promise<number> {
  const today = istDate(now);
  const rows = await query<{ channel_id: string; plan_id: string; role_id: string; channel: string; anchor: string; target_raw: string | null; last_end: string | null }>(
    `SELECT ch.id::text AS channel_id, p.id::text AS plan_id, p.role_id, ch.channel, to_char(ch.tracker_anchor,'YYYY-MM-DD') AS anchor,
            ch.targets->>'weekly_target' AS target_raw,
            (SELECT to_char(MAX(w.week_end),'YYYY-MM-DD') FROM sourcing_channel_weeks w WHERE w.plan_channel_id = ch.id) AS last_end
       FROM sourcing_plan_channels ch JOIN sourcing_plans p ON p.id = ch.plan_id
      WHERE p.status = 'active' AND ch.state = 'active' AND ch.tracker_anchor IS NOT NULL AND ($1::bigint IS NULL OR p.id = $1::bigint)`, [planId]);
  let inserted = 0;
  for (const row of rows) {
    // Parsed here, not cast in SQL: one malformed value ("abc", 5.5, 99999999999) must not stop every other plan's weeks being written.
    const target = row.target_raw !== null && /^\d{1,5}$/.test(row.target_raw) ? parseWeeklyTarget(Number(row.target_raw)) : null;
    if (target === null) continue;
    const r = { ...row, target };
    const windows = completedWindows(effectiveAnchor(r.anchor, r.last_end), today);
    if (!windows.length) continue;
    const byDay = await dayCounts(r.role_id, r.channel, windows[0].start, windows[windows.length - 1].end, (sql, params) => query(sql, params as unknown[]));
    for (const w of windows) {
      const t = sumWindow(byDay, w);
      const ins = await query<{ id: string }>(
        `INSERT INTO sourcing_channel_weeks (plan_channel_id, week_start, week_end, target, actual, qualified, partial)
         VALUES ($1::bigint, $2::date, $3::date, $4, $5, $6, false) ON CONFLICT (plan_channel_id, week_start) DO NOTHING RETURNING id::text AS id`,
        [r.channel_id, w.start, w.end, r.target, t.actual, t.qualified]);
      if (!ins[0]) continue;
      inserted++;
      await logChangeQ(r.plan_id, null, {
        type: 'weekly_result', channel: r.channel, week_start: w.start, week_end: w.end, target: r.target, actual: t.actual, qualified: t.qualified,
        met: isTargetMet(t.actual, r.target), partial: false,
      }, null, endOfIstDay(w.end));
    }
  }
  return inserted;
}

/** `syncChannelWeeks` that never throws: a data fault in the weekly tracker must not take down the engine, a plan read or a role save. */
export async function syncChannelWeeksSafe(planId: string | null, now: Date = new Date()): Promise<number> {
  try { return await syncChannelWeeks(planId, now); } catch (err) { console.error('[Sourcing] weekly tracker sync failed (ignored):', err); return 0; }
}

/**
 * A channel stops being measured (closed, left out, role on hold or closed…): record what it produced up to `stopDate`. The weeks that had already
 * ended but not yet been written (nobody looked at the plan since) are finished first, with the target that applies now, then the week in
 * progress is recorded as a cut-short week — neither met nor missed; the UI shows it as "cut short". Doing both here, inside the caller's
 * transaction (which already holds the plan lock), means no stop path can lose a week that was already over.
 */
async function finalizeWeeksInTx(
  client: PoolClient, plan: { id: string; role_id: string },
  ch: { id: string; channel: string; tracker_anchor: string | null; targets: Record<string, unknown> | null }, stopDate: string,
): Promise<void> {
  const target = parseWeeklyTarget(ch.targets?.weekly_target);
  if (!ch.tracker_anchor || target === null) return;
  const last = await client.query(`SELECT to_char(MAX(week_end),'YYYY-MM-DD') AS e FROM sourcing_channel_weeks WHERE plan_channel_id = $1::bigint`, [ch.id]);
  const from = effectiveAnchor(ch.tracker_anchor, last.rows[0]?.e ?? null);
  const ended = completedWindows(from, stopDate);
  const pw = partialWindow(ended.length ? addCalendarDays(ended[ended.length - 1].end, 1) : from, stopDate);
  const span = [...ended, ...(pw ? [pw.window] : [])];
  if (!span.length) return;
  const byDay = await dayCounts(plan.role_id, ch.channel, span[0].start, span[span.length - 1].end, async (sql, params) => (await client.query(sql, params)).rows);
  const write = async (w: { start: string; end: string }, partial: boolean) => {
    const t = sumWindow(byDay, w);
    // Stopped on the very day it started, before anything arrived: that says nothing, so no row — and the tracker can start again the same day.
    if (partial && t.actual === 0 && w.start === w.end) return;
    const ins = await client.query(
      `INSERT INTO sourcing_channel_weeks (plan_channel_id, week_start, week_end, target, actual, qualified, partial)
       VALUES ($1::bigint, $2::date, $3::date, $4, $5, $6, $7) ON CONFLICT (plan_channel_id, week_start) DO NOTHING RETURNING id`,
      [ch.id, w.start, w.end, target, t.actual, t.qualified, partial]);
    if (!ins.rows[0]) return;
    await logChange(client, plan.id, null, {
      type: 'weekly_result', channel: ch.channel, week_start: w.start, week_end: w.end, target, actual: t.actual, qualified: t.qualified,
      met: isTargetMet(t.actual, target), partial,
    }, null, partial ? undefined : endOfIstDay(w.end));
  };
  for (const w of ended) await write(w, false);
  if (pw) await write(pw.window, true);
}

/**
 * A channel stops being measured — it was closed, left out, removed from the role, its first task was re-opened, or the role went on hold:
 * the week in progress is recorded as a cut-short week and the tracker's start is cleared, so nothing is counted (or "missed") while the
 * channel is not running. Starting again (completing the first task, Reopen, or the role coming back) begins a fresh tracker from that day.
 * `channelIds` null = every channel of the plan. Runs inside the caller's transaction, which already holds the plan lock.
 */
async function stopTrackersInTx(client: PoolClient, plan: { id: string; role_id: string }, channelIds: string[] | null, date: string): Promise<void> {
  const rows = await client.query(
    `SELECT id::text AS id, channel, targets, to_char(tracker_anchor,'YYYY-MM-DD') AS tracker_anchor FROM sourcing_plan_channels
      WHERE plan_id = $1::bigint AND tracker_anchor IS NOT NULL AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`, [plan.id, channelIds]);
  for (const ch of rows.rows) await finalizeWeeksInTx(client, plan, ch, date);
  if (rows.rows.length) await client.query(`UPDATE sourcing_plan_channels SET tracker_anchor = NULL WHERE id = ANY($1::bigint[])`, [rows.rows.map(r => r.id)]);
}

/** What a closed channel leaves in the plan history: weeks tracked, weeks on target (cut-short weeks are neither) and applicants. */
async function logChannelClosedInTx(client: PoolClient, planId: string, userId: string | null, channel: string, channelId: string, reason: string): Promise<void> {
  const sum = await client.query(
    `SELECT count(*) FILTER (WHERE NOT partial) AS weeks, count(*) FILTER (WHERE NOT partial AND actual >= target) AS met, COALESCE(sum(actual) FILTER (WHERE NOT partial),0) AS applicants
       FROM sourcing_channel_weeks WHERE plan_channel_id = $1::bigint`, [channelId]);
  await logChange(client, planId, userId, {
    type: 'channel_closed', channel, weeks: Number(sum.rows[0].weeks), weeks_met: Number(sum.rows[0].met), applicants: Number(sum.rows[0].applicants),
  }, reason);
}

/** Nothing is chased on a closed channel, so what was open on it is cleared now rather than at the next sweep — and said so in the history
    (provisional signals were never shown, so they are not logged). `exceptId` is left alone (the caller is resolving it). */
async function clearChannelExceptionsInTx(client: PoolClient, planId: string, channel: string, exceptId: string | null): Promise<void> {
  const r = await client.query(
    `UPDATE sourcing_exceptions SET status = 'resolved', resolution_path = 'auto_cleared', reason = 'Channel closed', resolved_at = NOW()
      WHERE plan_id = $1::bigint AND channel = $2 AND status IN ('open','snoozed','blocked') AND ($3::bigint IS NULL OR id <> $3::bigint)
      RETURNING type, is_shadow`, [planId, channel, exceptId]);
  for (const x of r.rows) if (!x.is_shadow) await logChange(client, planId, null, { type: 'exception_cleared', exception_type: x.type, channel });
}

// ─── Close / reopen a channel, edit its target and link ─────────────────────────────────────────────
/**
 * Close Channel. The channel leaves the plan's day-to-day (its open tasks are skipped, nothing is chased) but everything it produced stays:
 * the post link, the weekly target and every tracked week. A closed channel is stored as state 'excluded' with closed_at set — the engine, queue
 * and guards already treat 'excluded' as "not in the plan" — and is reported to the API as state 'closed'. Reopen restores it.
 */
export async function closeChannel(planId: string, channel: string, reason: string, user: JwtPayload, now: Date = new Date()): Promise<void> {
  if (!isSourcingChannel(channel)) throw new SourcingError(400, `Unknown channel "${channel}"`);
  if (!reason || reason.trim().length < 3) throw new SourcingError(400, 'A short reason is required to close a channel');
  await syncChannelWeeksSafe(planId, now);                   // before the lock: finish the weeks that already ended with the target that applied then
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, role_id, status FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const plan = pr.rows[0];
    if (!plan) throw new SourcingError(404, 'Plan not found');
    if (plan.status === 'closed') throw new SourcingError(409, 'The role is closed');
    if (plan.status === 'draft') throw new SourcingError(409, 'Activate the plan first — until then a channel can simply be left out');
    const cr = await client.query(
      `SELECT id::text AS id, channel, state, closed_at, targets, to_char(tracker_anchor,'YYYY-MM-DD') AS tracker_anchor FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR NO KEY UPDATE`, [planId, channel]);
    const ch = cr.rows[0];
    if (!ch) throw new SourcingError(404, `${channel} is not in this plan`);
    if (ch.state === 'excluded') throw new SourcingError(409, ch.closed_at ? `${channel} is already closed` : `${channel} is not in the plan`);

    await finalizeWeeksInTx(client, plan, ch, istDate(now));
    await client.query(
      `UPDATE sourcing_plan_channels SET state = 'excluded', excluded_reason = NULL, closed_at = $2, closed_by = $3::uuid, closed_reason = $4, tracker_anchor = NULL WHERE id = $1::bigint`,
      [ch.id, now, user.userId, reason.trim().slice(0, 500)]);
    // Remember which open tasks the close skipped, so reopening brings back exactly those (and not ones a person skipped by hand).
    await client.query(
      `UPDATE sourcing_commitments SET status = 'skipped', meta = meta || '{"closed_with_channel": true}'::jsonb WHERE plan_channel_id = $1::bigint AND status = 'open'`, [ch.id]);
    await clearChannelExceptionsInTx(client, planId, channel, null);
    await logChannelClosedInTx(client, planId, user.userId, channel, ch.id, reason.trim());
  });
}

/** Reopen a closed channel and carry on using it: its follow-up tasks come back, and the weekly tracker restarts today with the same target. */
export async function reopenChannel(planId: string, channel: string, user: JwtPayload, now: Date = new Date()): Promise<void> {
  if (!isSourcingChannel(channel)) throw new SourcingError(400, `Unknown channel "${channel}"`);
  const settings = await loadSettings();
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, status, paused_at FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const plan = pr.rows[0];
    if (!plan) throw new SourcingError(404, 'Plan not found');
    if (plan.status === 'closed') throw new SourcingError(409, 'The role is closed');
    if (plan.status === 'draft') throw new SourcingError(409, 'Activate the plan first');
    const cr = await client.query(
      `SELECT id::text AS id, state, closed_at, targets FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR NO KEY UPDATE`, [planId, channel]);
    const ch = cr.rows[0];
    if (!ch) throw new SourcingError(404, `${channel} is not in this plan`);
    if (ch.state !== 'excluded' || !ch.closed_at) throw new SourcingError(409, `${channel} is not closed`);

    const act = await client.query(`SELECT status FROM sourcing_commitments WHERE plan_channel_id = $1::bigint AND kind = 'activate_channel'`, [ch.id]);
    const wasLive = act.rows[0]?.status === 'done';
    // On a paused plan resuming shifts every open date by the whole pause, so anchor to the day the pause began (as startChannel does).
    const anchorDate = plan.status === 'paused' && plan.paused_at ? istDate(new Date(plan.paused_at)) : istDate(now);
    // On a paused plan the tracker stays stopped: resuming the plan starts it (resumePlan), from the day the role is back on.
    const hasTarget = parseWeeklyTarget(ch.targets?.weekly_target) !== null && plan.status === 'active';
    await client.query(
      `UPDATE sourcing_plan_channels SET state = $2, excluded_reason = NULL, closed_at = NULL, closed_by = NULL, closed_reason = NULL,
              tracker_anchor = CASE WHEN $3::boolean THEN $4::date ELSE NULL END WHERE id = $1::bigint`,
      [ch.id, wasLive ? 'active' : 'planned', wasLive && hasTarget, anchorDate]);
    // Bring back what the close skipped. A recurring task that fell due while the channel was closed is due tomorrow, not instantly overdue.
    await client.query(
      `UPDATE sourcing_commitments SET status = 'open', due_at = GREATEST(due_at, $2::timestamptz), meta = meta - 'closed_with_channel'
        WHERE plan_channel_id = $1::bigint AND status = 'skipped' AND meta->>'closed_with_channel' = 'true' AND kind <> 'activate_channel'`,
      [ch.id, endOfIstDay(addCalendarDays(anchorDate, 1))]);
    // Closed before it ever went live: the activation task starts again from today.
    if (!wasLive) await upsertCommitment(client, ch.id, activationSpec(channel, anchorDate, calOf(settings)));
    await mirrorChannelToRole(client, (await client.query(`SELECT role_id FROM sourcing_plans WHERE id = $1::bigint`, [planId])).rows[0].role_id, channel, user.userId);
    await logChange(client, planId, user.userId, { type: 'channel_reopened', channel });
  });
}

/** Change a live tracked channel's weekly sourcing target and/or post link. The weeks that already ended are finished first with the OLD target. */
export async function updateChannelSettings(
  planId: string, channel: string, input: { weekly_target?: number | null; posting_url?: string | null }, user: JwtPayload, now: Date = new Date(),
): Promise<void> {
  if (!isSourcingChannel(channel)) throw new SourcingError(400, `Unknown channel "${channel}"`);
  if (!isTrackedChannel(channel)) throw new SourcingError(409, `${channel} has no weekly target or post link`);
  let target: number | undefined;
  if (input.weekly_target !== undefined) {
    const t = parseWeeklyTarget(input.weekly_target);
    if (t === null) throw new SourcingError(400, 'The weekly sourcing target must be a whole number of applicants (1 or more)');
    target = t;
  }
  let url: string | undefined;
  if (input.posting_url !== undefined) {
    const u = validUrl(input.posting_url);
    if (!u) throw new SourcingError(400, 'The post link must be a valid http(s) link');
    url = u;
  }
  if (target === undefined && url === undefined) throw new SourcingError(400, 'Nothing to change');
  await syncChannelWeeksSafe(planId, now);
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, status, paused_at FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const plan = pr.rows[0];
    if (!plan) throw new SourcingError(404, 'Plan not found');
    if (plan.status !== 'active' && plan.status !== 'paused') throw new SourcingError(409, plan.status === 'closed' ? 'The role is closed' : 'Activate the plan first');
    const cr = await client.query(
      `SELECT id::text AS id, state, targets, config, tracker_anchor FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR NO KEY UPDATE`, [planId, channel]);
    const ch = cr.rows[0];
    if (!ch) throw new SourcingError(404, `${channel} is not in this plan`);
    if (ch.state !== 'active') throw new SourcingError(409, ch.state === 'excluded' ? `${channel} is closed or left out` : `Log the ${channel} post first (mark its first task done)`);

    const targets = { ...(ch.targets ?? {}) } as Record<string, unknown>;
    const config = { ...(ch.config ?? {}) } as Record<string, unknown>;
    // The tracker starts today — on a paused plan not at all: resuming the plan starts it, from the day the role is back on.
    const anchorDate = plan.status === 'active' ? istDate(now) : null;
    if (target !== undefined && target !== (parseWeeklyTarget(targets.weekly_target) ?? null)) {
      const from = parseWeeklyTarget(targets.weekly_target);
      targets.weekly_target = target;
      await client.query(
        `UPDATE sourcing_plan_channels SET targets = $2::jsonb, tracker_anchor = COALESCE(tracker_anchor, $3::date) WHERE id = $1::bigint`,
        [ch.id, JSON.stringify(targets), anchorDate]);
      await logChange(client, planId, user.userId, { type: 'channel_target_changed', channel, from, to: target });
    }
    if (url !== undefined && url !== (typeof config.posting_url === 'string' ? config.posting_url : null)) {
      config.posting_url = url;
      await client.query(`UPDATE sourcing_plan_channels SET config = $2::jsonb WHERE id = $1::bigint`, [ch.id, JSON.stringify(config)]);
      await logChange(client, planId, user.userId, { type: 'channel_link_changed', channel });
    }

    // A live channel whose first task ("log the post: link and weekly target") was still waiting — one that went live before the weekly tracker
    // existed — is done once it has both. Left open it would go on to raise "channel not live" for work that has been done.
    const finalTarget = parseWeeklyTarget(targets.weekly_target);
    const finalUrl = typeof config.posting_url === 'string' ? config.posting_url : null;
    if (finalTarget !== null && finalUrl) {
      const open = await client.query(
        `SELECT id::text AS id, title, due_at FROM sourcing_commitments WHERE plan_channel_id = $1::bigint AND kind = 'activate_channel' AND status = 'open' FOR UPDATE`, [ch.id]);
      const act = open.rows[0];
      if (act) {
        const log = await client.query(
          `INSERT INTO sourcing_commitment_log (commitment_id, done_at, was_due_at, done_by, note) VALUES ($1::bigint,$2,$3,$4,$5) RETURNING id::text AS id`,
          [act.id, now, act.due_at, user.userId, 'Link and weekly target added from the channel settings']);
        await client.query(`INSERT INTO sourcing_evidence (log_id, kind, ref, source, occurred_at) VALUES ($1::bigint,'url',$2,'self',$3)`, [log.rows[0].id, finalUrl, now]);
        await client.query(`UPDATE sourcing_commitments SET status = 'done', last_done_at = $2 WHERE id = $1::bigint`, [act.id, now]);
        await logChange(client, planId, user.userId, {
          type: 'commitment_completed', channel, kind: 'activate_channel', commitment: act.title,
          on_time: now.getTime() <= new Date(act.due_at).getTime(), url: finalUrl, weekly_target: finalTarget,
        });
      }
    }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edit a plan: the strategy note and this role's weekly qualified target (`null` returns it to the default — 5 for P0/P1, none for P2/P3).
    A plan has no individual owner — sourcing belongs to the HR/Admin persona as a whole — so there is nothing else to edit here.
    A real change is written to the plan's history. */
export async function updatePlan(planId: string, input: { strategy_note?: string | null; weekly_qualified_target?: number | null }, user: JwtPayload): Promise<void> {
  let target: number | null | undefined;
  if (input.weekly_qualified_target !== undefined) {
    if (input.weekly_qualified_target === null) target = null;
    else {
      target = parseQualifiedTarget(input.weekly_qualified_target);
      if (target === null) throw new SourcingError(400, 'The weekly qualified target must be a whole number from 1 to 500');
    }
  }
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, strategy_note, weekly_qualified_target FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const cur = pr.rows[0];
    if (!cur) throw new SourcingError(404, 'Plan not found');
    if (input.strategy_note !== undefined) {
      const note = input.strategy_note?.toString().trim().slice(0, 2000) || null;
      if (note !== (cur.strategy_note ?? null)) {
        await client.query(`UPDATE sourcing_plans SET strategy_note = $2 WHERE id = $1::bigint`, [planId, note]);
        await logChange(client, planId, user.userId, { type: 'strategy_note_changed' });
      }
    }
    if (target !== undefined && target !== (cur.weekly_qualified_target ?? null)) {
      await client.query(`UPDATE sourcing_plans SET weekly_qualified_target = $2::int WHERE id = $1::bigint`, [planId, target]);
      await logChange(client, planId, user.userId, { type: 'qualified_target_changed', from: cur.weekly_qualified_target ?? null, to: target });
    }
  });
}

// ─── Exception resolution (PRD §6: catch up / change strategy / blocker) ────────────────────────────
export interface ResolveInput {
  path: 'catch_up' | 'change_strategy' | 'blocker';
  reason: string;
  corrective_action?: string | null;
  snooze_until?: string | null;          // catch_up: required, 1–14 days out
  blocker_owner_user_id?: string | null; // blocker
  blocker_due?: string | null;           // blocker: required, within 60 days
  exclude_channel?: boolean;             // change_strategy
}

export async function resolveException(exceptionId: string, input: ResolveInput, user: JwtPayload, now: Date = new Date()): Promise<void> {
  const today = istDate(now);
  if (!input.reason || input.reason.trim().length < 3) throw new SourcingError(400, 'A short reason is required');
  const reason = input.reason.trim().slice(0, 500);
  if (typeof input.blocker_owner_user_id === 'string' && !UUID_RE.test(input.blocker_owner_user_id)) throw new SourcingError(400, 'Invalid blocker owner');
  await transaction(async (client) => {
    await lockPlanOfException(client, exceptionId);
    const r = await client.query(
      `SELECT e.id::text AS id, e.plan_id::text AS plan_id, e.channel, e.type, e.status, e.is_shadow FROM sourcing_exceptions e WHERE e.id = $1::bigint FOR UPDATE`, [exceptionId]);
    const e = r.rows[0];
    if (!e) throw new SourcingError(404, 'Exception not found');
    if (e.status === 'resolved') throw new SourcingError(409, 'Already resolved');
    if (e.is_shadow) throw new SourcingError(409, 'This is a provisional signal — nothing to resolve yet');

    if (input.path === 'catch_up') {
      const s = input.snooze_until;
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s <= today || s > addCalendarDays(today, 14)) throw new SourcingError(400, 'Pick a catch-up date within the next 14 days');
      await client.query(
        `UPDATE sourcing_exceptions SET status = 'snoozed', resolution_path = 'catch_up', reason = $2, corrective_action = $3, snooze_until = $4::date, resolved_by = $5::uuid WHERE id = $1::bigint`,
        [exceptionId, reason, input.corrective_action ?? null, s, user.userId]);
      await logChange(client, e.plan_id, user.userId, { type: 'exception_snoozed', exception_type: e.type, channel: e.channel, until: s }, reason);
    } else if (input.path === 'blocker') {
      const due = input.blocker_due;
      if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due) || due < today || due > addCalendarDays(today, 60)) throw new SourcingError(400, 'A blocker needs a deadline within the next 60 days');
      const ownerId = input.blocker_owner_user_id ?? user.userId;
      const o = await client.query(`SELECT id, name FROM users WHERE id = $1::uuid AND is_active = true`, [ownerId]);
      if (!o.rows[0]) throw new SourcingError(400, 'The blocker owner must be an active user');
      await client.query(
        `UPDATE sourcing_exceptions SET status = 'blocked', resolution_path = 'blocker', reason = $2, corrective_action = $3, blocker_due = $4::date, blocker_owner_user_id = $5::uuid, resolved_by = $6::uuid WHERE id = $1::bigint`,
        [exceptionId, reason, input.corrective_action ?? null, due, ownerId, user.userId]);
      await logChange(client, e.plan_id, user.userId, { type: 'exception_blocked', exception_type: e.type, channel: e.channel, owner: o.rows[0].name, due }, reason);
    } else if (input.path === 'change_strategy') {
      if (input.exclude_channel) {
        if (e.channel === '*') throw new SourcingError(400, 'This exception is not tied to a channel');
        const chr = await client.query(`SELECT id::text AS id, state, closed_at FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR NO KEY UPDATE`, [e.plan_id, e.channel]);
        const chn = chr.rows[0];
        if (chn && chn.state !== 'excluded') {               // a channel already closed (or left out) stays as it is, with its own reason
          const pl = await client.query(`SELECT role_id FROM sourcing_plans WHERE id = $1::bigint`, [e.plan_id]);
          await stopTrackersInTx(client, { id: e.plan_id, role_id: pl.rows[0].role_id }, [chn.id], today);
          // "Stop using the channel" is closing it: the post, targets and weeks stay as a summary and it can be reopened.
          await client.query(
            `UPDATE sourcing_plan_channels SET state = 'excluded', excluded_reason = NULL, closed_at = NOW(), closed_by = $3::uuid, closed_reason = $2 WHERE id = $1::bigint`,
            [chn.id, reason, user.userId]);
          await client.query(
            `UPDATE sourcing_commitments SET status = 'skipped', meta = meta || '{"closed_with_channel": true}'::jsonb WHERE status = 'open' AND plan_channel_id = $1::bigint`, [chn.id]);
          await clearChannelExceptionsInTx(client, e.plan_id, e.channel, exceptionId);
          await logChannelClosedInTx(client, e.plan_id, user.userId, e.channel, chn.id, reason);
        }
      }
      await client.query(
        `UPDATE sourcing_exceptions SET status = 'resolved', resolution_path = 'change_strategy', reason = $2, corrective_action = $3, resolved_at = NOW(), resolved_by = $4::uuid WHERE id = $1::bigint`,
        [exceptionId, reason, input.corrective_action ?? null, user.userId]);
      await logChange(client, e.plan_id, user.userId, { type: 'strategy_changed', exception: e.type, channel: e.channel, excluded: !!input.exclude_channel }, reason);
    } else {
      throw new SourcingError(400, 'Unknown resolution path');
    }
  });
}

// ─── Hook from the role PATCH (runs AFTER commit, BEFORE JD generation) ─────────────────────────────
export interface RoleSnapshot { id: string; status: string; recruitment_mode: string[] | null }

/**
 * Keeps plans in step with role changes. Never throws: a sourcing problem must not fail a role save.
 * Gated on SOURCING_ENABLED and tolerant of missing tables (Supabase is migrated before the code ships).
 *
 * The plan is reconciled with the role's NEW status and the plan's CURRENT status (utils/sourcingPlanTransitions.ts) —
 * not with the hop `prev` → `next`, which stranded a plan on a two-hop path (Closed → On Hold → Approved left it closed on
 * an open role; On Hold → Under Review → Approved left it paused). `prev` is only used for the Recruitment Mode diff.
 * That also makes it self-healing and cheap: it runs on every real save, and when nothing needs doing it costs one read.
 */
export async function onRoleSaved(prev: RoleSnapshot, next: RoleSnapshot, userId: string | null): Promise<void> {
  if (!isSourcingEnabled()) return;
  try {
    const current = await queryOne<{ status: PlanStatus }>(`SELECT status FROM sourcing_plans WHERE role_id = $1`, [next.id]);
    switch (planTransitionFor(current?.status ?? null, next.status)) {
      case 'seed': await ensureDraftPlansForOpenRoles(next.id); break;
      case 'resume': await resumePlan(next.id); break;
      case 'reopen_draft': await reopenPlanAsDraft(next.id, userId); break;
      case 'pause': await pausePlan(next.id); break;
      case 'close': await closePlan(next.id, userId); break;
      case 'none': break;
    }

    const before = [...(prev.recruitment_mode ?? [])].sort().join('|');
    const after = [...(next.recruitment_mode ?? [])].sort().join('|');
    if (before !== after) await reconcileChannelsFromRole(next.id, next.recruitment_mode ?? [], userId);
  } catch (err) {
    console.error('[Sourcing] onRoleSaved hook failed (ignored):', err);
  }
}

/**
 * The role went On Hold. The clocks stop, and so do the weekly trackers: the week in progress is recorded as cut short and each tracker's
 * start is cleared (nothing is measured, or "missed", while the role is on hold). resumePlan starts them again from the day the role is back.
 */
async function pausePlan(roleId: string) {
  const cur = await queryOne<{ id: string }>(`SELECT id::text AS id FROM sourcing_plans WHERE role_id = $1 AND status = 'active'`, [roleId]);
  if (!cur) return;
  await syncChannelWeeksSafe(cur.id);        // before the lock: finish the weeks that had already ended, with the target that applied then
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, status FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [cur.id]);
    if (!r.rows[0] || r.rows[0].status !== 'active') return;
    // The hook runs after the role save committed, and a second save may have put the role back on already: pause only if it is still on hold.
    const role = await client.query(`SELECT status FROM roles WHERE id = $1`, [roleId]);
    if (role.rows[0]?.status !== 'On Hold') return;
    await client.query(`UPDATE sourcing_plans SET status = 'paused', paused_at = NOW() WHERE id = $1::bigint`, [cur.id]);
    await stopTrackersInTx(client, { id: cur.id, role_id: roleId }, null, istDate(new Date()));
    await logChange(client, cur.id, null, { type: 'paused' });
  });
}

async function resumePlan(roleId: string) {
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, paused_at FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p) { await ensureDraftPlansForOpenRoles(roleId); return; }
    const role = await client.query(`SELECT status FROM roles WHERE id = $1`, [roleId]);
    if (role.rows[0]?.status === 'On Hold') return;          // put on hold again since this save: stay paused
    const pausedMs = p.paused_at ? Math.max(0, Date.now() - new Date(p.paused_at).getTime()) : 0;
    const pausedDays = Math.round(pausedMs / 86400000);
    // The clocks stopped while the role was on hold: shift every open commitment by the whole days spent paused (a hold of seconds moves nothing).
    await client.query(
      `UPDATE sourcing_commitments SET due_at = due_at + ($2::int * INTERVAL '1 day')
        WHERE status = 'open' AND plan_channel_id IN (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint)`, [p.id, pausedDays]);
    await client.query(`UPDATE sourcing_plans SET status = 'active', paused_at = NULL, pause_total_days = pause_total_days + $2 WHERE id = $1::bigint`, [p.id, pausedDays]);
    // The weekly trackers were stopped when the role went on hold: every live channel that has a target starts a fresh tracker today
    // (a channel whose post was logged during the hold included — its tracker starts when the role is back, not before).
    await client.query(
      `UPDATE sourcing_plan_channels SET tracker_anchor = $2::date
        WHERE plan_id = $1::bigint AND state = 'active' AND (targets->>'weekly_target') ~ '^[0-9]{1,5}$'`, [p.id, istDate(new Date())]);
    await logChange(client, p.id, null, { type: 'resumed', paused_days: pausedDays });
  });
}

async function closePlan(roleId: string, userId: string | null) {
  const existing = await queryOne<{ id: string }>(`SELECT id::text AS id FROM sourcing_plans WHERE role_id = $1`, [roleId]);
  if (existing) await syncChannelWeeksSafe(existing.id);    // finish the weeks that already ended, with the targets that applied then
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, status FROM sourcing_plans WHERE role_id = $1 FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p || p.status === 'closed') return;
    // The week in progress is cut short and recorded, then the trackers stop.
    await stopTrackersInTx(client, { id: p.id, role_id: roleId }, null, istDate(new Date()));
    await client.query(`UPDATE sourcing_plans SET status = 'closed', closed_at = NOW(), paused_at = NULL WHERE id = $1::bigint`, [p.id]);
    await client.query(
      `UPDATE sourcing_commitments SET status = 'skipped' WHERE status = 'open' AND plan_channel_id IN (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint)`, [p.id]);
    await client.query(
      `UPDATE sourcing_exceptions SET status = 'resolved', resolution_path = 'role_closed', reason = 'Role closed', resolved_at = NOW()
        WHERE plan_id = $1::bigint AND status IN ('open','snoozed','blocked')`, [p.id]);
    await logChange(client, p.id, userId, { type: 'role_closed' });
  });
}

async function reopenPlanAsDraft(roleId: string, userId: string | null) {
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, status FROM sourcing_plans WHERE role_id = $1 FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p) { await ensureDraftPlansForOpenRoles(roleId); return; }
    if (p.status !== 'closed') return;
    // History is kept (log + changes); activation upserts fresh commitments over the skipped ones.
    await client.query(`UPDATE sourcing_plans SET status = 'draft', closed_at = NULL WHERE id = $1::bigint`, [p.id]);
    await client.query(`UPDATE sourcing_plan_channels SET state = CASE WHEN state = 'excluded' THEN state ELSE 'planned' END WHERE plan_id = $1::bigint`, [p.id]);
    await logChange(client, p.id, userId, { type: 'role_reopened' }, 'Plan returned to draft — re-activate to start the clocks');
  });
}

/**
 * roles.recruitment_mode edited directly (API, or a tab that still shows the field editable): add channels the plan lacks,
 * bring back channels that were only left out because they had been removed here, exclude channels that were removed.
 * A channel that joins a plan that is already being tracked gets its first commitment, exactly as when it is added from the card.
 */
async function reconcileChannelsFromRole(roleId: string, mode: string[], userId: string | null, now: Date = new Date()) {
  const wanted = mode.filter(isSourcingChannel);
  const settings = await loadSettings();
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, status, paused_at FROM sourcing_plans WHERE role_id = $1 FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p || p.status === 'closed') return;
    const have = await client.query(`SELECT channel, state, excluded_reason FROM sourcing_plan_channels WHERE plan_id = $1::bigint`, [p.id]);
    const byName = new Map<string, { state: string; excluded_reason: string | null }>(have.rows.map(x => [x.channel as string, x]));
    const added: string[] = [];
    for (const ch of wanted) {
      const row = byName.get(ch);
      // Already in the plan, or left out by the recruiter on purpose (a reason of their own, not the exact marker): leave it as it is.
      if (row && !(row.state === 'excluded' && row.excluded_reason === REMOVED_ON_ROLE)) continue;
      const up = await client.query(
        `INSERT INTO sourcing_plan_channels (plan_id, channel, state) VALUES ($1::bigint,$2,'planned')
         ON CONFLICT (plan_id, channel) DO UPDATE SET state = 'planned', excluded_reason = NULL
         RETURNING id::text AS id`, [p.id, ch]);
      await startChannel(client, p, up.rows[0].id as string, ch, now, settings);
      added.push(ch);
    }
    if (added.length) await logChange(client, p.id, userId, { type: 'channels_added_on_role', channels: added });
    const removed = await client.query(
      `UPDATE sourcing_plan_channels SET state = 'excluded', excluded_reason = $3
        WHERE plan_id = $1::bigint AND state <> 'excluded' AND NOT (channel = ANY($2::text[])) RETURNING id::text AS id, channel`, [p.id, wanted, REMOVED_ON_ROLE]);
    if (removed.rows.length) {
      await stopTrackersInTx(client, { id: p.id, role_id: roleId }, removed.rows.map(x => x.id as string), istDate(now));
      await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE status = 'open' AND plan_channel_id = ANY($1::bigint[])`, [removed.rows.map(x => x.id)]);
      await logChange(client, p.id, userId, { type: 'channels_removed_on_role', channels: removed.rows.map(x => x.channel) });
    }
  });
}
