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
  isSourcingChannel, isSourcingEnabled, OPEN_ROLE_STATUSES, SOURCING_CHANNELS, SourcingSettings,
} from '../utils/sourcingConfig.js';
import { planTransitionFor, PlanStatus } from '../utils/sourcingPlanTransitions.js';
import {
  activationSpec, CommitmentSpec, dueAtFor, followOnSpecs, nextDueDate,
} from '../utils/sourcingTemplates.js';
import { addCalendarDays, endOfIstDay, istDate, WorkingCalendar } from '../utils/workingDays.js';
import { loadSettings } from './sourcingSettings.js';
import { qualifiedInWindow, QualifiedInput, QUALIFIED_TIMESTAMPS_SQL } from '../utils/sourcingQualified.js';
import { describeException } from '../utils/sourcingDescribe.js';

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
}

export async function getPlanRowByRole(roleId: string): Promise<PlanRow | null> {
  return queryOne<PlanRow>(
    `SELECT p.id::text AS id, p.role_id, p.status,
            p.strategy_note, p.baseline, p.baseline_at, p.activated_at, p.paused_at, p.pause_total_days, p.closed_at
       FROM sourcing_plans p WHERE p.role_id = $1`, [roleId]);
}

export async function getPlanRowById(id: string): Promise<PlanRow | null> {
  return queryOne<PlanRow>(
    `SELECT p.id::text AS id, p.role_id, p.status,
            p.strategy_note, p.baseline, p.baseline_at, p.activated_at, p.paused_at, p.pause_total_days, p.closed_at
       FROM sourcing_plans p WHERE p.id = $1::bigint`, [id]);
}

export interface PlanView {
  plan: PlanRow;
  role: { id: string; title: string; priority: string; status: string; num_openings: number | null; hiring_manager_name: string | null; recruitment_mode: string[] | null; approval_date: string | null };
  channels: Array<{
    id: string; channel: string; state: string; excluded_reason: string | null; config: Record<string, unknown>; targets: Record<string, unknown>;
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
  changes: Array<{ at: string; by_name: string | null; change: unknown; reason: string | null }>;
  volume: { weekly_qualified: number; shortlisted: number; scored: number; min: number; rule: string; applicable: boolean };
  output: Array<{ tag: string; applications: number; qualified: number }>;
  attribution_reliable: Record<string, boolean>;
  settings: { go_live_date: string | null; qualified_rule: string; shadow_until: string | null };
}

export async function getPlanView(roleId: string, now: Date = new Date()): Promise<PlanView | null> {
  const plan = await getPlanRowByRole(roleId);
  if (!plan) return null;
  const settings = await loadSettings();

  const [role, channels, exceptions, changes, volumeApps, outputRows] = await Promise.all([
    queryOne<PlanView['role']>(
      `SELECT id, title, priority, status, num_openings, hiring_manager_name, recruitment_mode, to_char(approval_date,'YYYY-MM-DD') AS approval_date
         FROM roles WHERE id = $1`, [roleId]),
    query<{ id: string; channel: string; state: string; excluded_reason: string | null; config: Record<string, unknown>; targets: Record<string, unknown> }>(
      `SELECT id::text AS id, channel, state, excluded_reason, config, targets FROM sourcing_plan_channels WHERE plan_id = $1::bigint ORDER BY id`, [plan.id]),
    query<Omit<PlanView['exceptions'][number], 'committed' | 'happened' | 'next_action'>>(
      `SELECT e.id::text AS id, e.channel, e.type, e.status, e.severity, e.is_shadow, e.detected_at, e.last_seen_at, e.evidence,
              e.resolution_path, e.reason, e.corrective_action, to_char(e.snooze_until,'YYYY-MM-DD') AS snooze_until,
              to_char(e.blocker_due,'YYYY-MM-DD') AS blocker_due, bu.name AS blocker_owner_name, e.resolved_at
         FROM sourcing_exceptions e LEFT JOIN users bu ON bu.id = e.blocker_owner_user_id
        WHERE e.plan_id = $1::bigint AND (e.status <> 'resolved' OR e.resolved_at > NOW() - INTERVAL '14 days')
        ORDER BY (e.status = 'resolved'), e.severity DESC, e.detected_at DESC`, [plan.id]),
    query<PlanView['changes'][number]>(
      `SELECT c.at, u.name AS by_name, c.change, c.reason FROM sourcing_plan_changes c LEFT JOIN users u ON u.id = c."by"
        WHERE c.plan_id = $1::bigint ORDER BY c.at DESC LIMIT 25`, [plan.id]),
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
           FROM sourcing_commitments WHERE plan_channel_id = ANY($1::bigint[]) ORDER BY id`, [channels.map(c => c.id)])
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

  const nowMs = now.getTime();
  const channelViews: PlanView['channels'] = channels.map(ch => ({
    ...ch,
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
  const output = outputRows.map(o => ({ tag: o.tag, applications: Number(o.applications), qualified: Number(o.qualified) }));
  const attribution_reliable: Record<string, boolean> = {};
  for (const ch of SOURCING_CHANNELS) attribution_reliable[ch] = (output.find(o => o.tag === ch)?.applications ?? 0) >= 5;

  return {
    plan, role, channels: channelViews, exceptions: exceptions.map(e => ({ ...e, ...describeException(e) })), changes,
    volume: { weekly_qualified: w.qualified, shortlisted: w.shortlisted, scored: w.scored, min: settings.volume_min_qualified, rule: settings.qualified_rule,
              applicable: role.priority === 'P0' || role.priority === 'P1' },
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
    changes: [],
    exceptions: v.exceptions.filter(e => !e.is_shadow && e.status !== 'resolved').map(e => ({
      ...e, evidence: {}, reason: null, corrective_action: null, blocker_owner_name: null,
    })),
    channels: v.channels.map(c => ({
      ...c, config: {},
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
async function logChange(client: PoolClient, planId: string, userId: string | null, change: Record<string, unknown>, reason?: string | null) {
  await client.query(
    `INSERT INTO sourcing_plan_changes (plan_id, "by", change, reason) VALUES ($1::bigint, $2, $3::jsonb, $4)`,
    [planId, userId, JSON.stringify(change), reason ?? null]);
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
  posted_at?: string | null;       // portals: the posting's own date
  weekly_target?: number | null;   // outbound: set/update the weekly unique-contact target
  auto?: { kind: string; ref?: string | null };   // reserved for P3 (gmail message id etc.)
}

/** Record a completion and roll the commitment forward. Runs inside the caller's transaction. */
async function completeInTx(
  client: PoolClient, commitmentId: string, input: CompletionInput, userId: string | null, settings: SourcingSettings, now: Date,
): Promise<{ planId: string; roleId: string }> {
  await lockPlanOfCommitment(client, commitmentId);
  const r = await client.query(
    `SELECT c.id::text AS id, c.kind, c.cadence_days, c.due_at, c.status, c.meta, ch.id::text AS channel_id, ch.channel, ch.state AS channel_state, ch.config, ch.targets,
            p.id::text AS plan_id, p.role_id, p.status AS plan_status
       FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id
      WHERE c.id = $1::bigint FOR UPDATE OF c`, [commitmentId]);
  const c = r.rows[0];
  if (!c) throw new SourcingError(404, 'Commitment not found');
  if (c.plan_status === 'draft') throw new SourcingError(409, 'Activate the plan first');
  if (c.plan_status === 'closed') throw new SourcingError(409, 'The role is closed');
  if (c.channel_state === 'excluded') throw new SourcingError(409, `${c.channel} is not in the plan — add it back first`);
  if (c.status === 'skipped') throw new SourcingError(409, 'This was skipped — undo the skip first');
  if (c.status !== 'open') throw new SourcingError(409, 'This commitment is already complete');

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
      [commitmentId, now, endOfIstDay(nextDueDate(now, c.cadence_days, lead))]);
  }

  if (c.kind === 'activate_channel') {
    const config = { ...(c.config ?? {}) } as Record<string, unknown>;
    if (url) config.posting_url = url;
    if (input.posted_at && /^\d{4}-\d{2}-\d{2}$/.test(input.posted_at)) config.posted_at = input.posted_at;
    const targets = { ...(c.targets ?? {}) } as Record<string, unknown>;
    if (c.channel === 'Direct Outreach' && typeof input.weekly_target === 'number' && input.weekly_target > 0) targets.weekly_contacts = Math.round(input.weekly_target);
    await client.query(`UPDATE sourcing_plan_channels SET state = 'active', config = $2::jsonb, targets = $3::jsonb WHERE id = $1::bigint`,
      [c.channel_id, JSON.stringify(config), JSON.stringify(targets)]);
    for (const spec of followOnSpecs(c.channel, now, settings, calOf(settings), { postedAt: input.posted_at })) {
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
  } else if (c.kind === 'weekly_outbound' && typeof input.weekly_target === 'number' && input.weekly_target > 0) {
    const targets = { ...(c.targets ?? {}), weekly_contacts: Math.round(input.weekly_target) };
    await client.query(`UPDATE sourcing_plan_channels SET targets = $2::jsonb WHERE id = $1::bigint`, [c.channel_id, JSON.stringify(targets)]);
  }
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
         ON CONFLICT (plan_id, channel) DO UPDATE SET state = EXCLUDED.state, excluded_reason = EXCLUDED.excluded_reason
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
      if (ch.channel === 'Direct Outreach' && typeof ch.weekly_target === 'number' && ch.weekly_target > 0) {
        await client.query(`UPDATE sourcing_plan_channels SET targets = jsonb_set(targets, '{weekly_contacts}', to_jsonb($2::int)) WHERE id = $1::bigint`, [channelId, Math.round(ch.weekly_target)]);
      }
      if (ch.already_running) {
        await completeInTx(client, commitmentId, {
          attest: true, url: ch.url, posted_at: ch.posted_at, weekly_target: ch.weekly_target, note: 'Already running at plan activation',
        }, user.userId, settings, now);
      }
    }

    await client.query(
      `UPDATE sourcing_plans SET strategy_note = COALESCE($2, strategy_note), baseline = $3::jsonb WHERE id = $1::bigint`,
      [planId, input.strategy_note?.toString().slice(0, 2000) || null,
       JSON.stringify({ activated_on: activationDate, channels: baselineChannels })]);
    await logChange(client, planId, user.userId, { type: 'activated', channels: baselineChannels }, input.strategy_note ?? null);
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
    await logChange(client, c.plan_id, user.userId, { type: 'commitment_skipped', channel: c.channel, commitment: c.title }, reason.trim());
  });
}

export async function reopenCommitment(commitmentId: string, user: JwtPayload, now: Date = new Date()): Promise<void> {
  const settings = await loadSettings();
  await transaction(async (client) => {
    await lockPlanOfCommitment(client, commitmentId);
    const r = await client.query(
      `SELECT c.id::text AS id, c.kind, c.status, c.cadence_days, ch.id::text AS channel_id, ch.channel, ch.state AS channel_state, p.id::text AS plan_id, p.status AS plan_status
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
    if (c.kind === 'activate_channel') await client.query(`UPDATE sourcing_plan_channels SET state = 'planned' WHERE id = $1::bigint`, [c.channel_id]);
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
    const cur = await client.query(`SELECT state FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2 FOR UPDATE`, [planId, channel]);
    // Adding a channel that is already in the plan must change nothing: it used to re-open a finished activation and chase it again.
    if (input.state === 'planned' && cur.rows[0] && cur.rows[0].state !== 'excluded') throw new SourcingError(409, `${channel} is already in this plan`);
    const up = await client.query(
      `INSERT INTO sourcing_plan_channels (plan_id, channel, state, excluded_reason) VALUES ($1::bigint,$2,$3,$4)
       ON CONFLICT (plan_id, channel) DO UPDATE SET state = EXCLUDED.state, excluded_reason = EXCLUDED.excluded_reason
       RETURNING id::text AS id`,
      [planId, channel, input.state, input.state === 'excluded' ? input.excluded_reason!.trim() : null]);
    const channelId = up.rows[0].id as string;
    if (input.state === 'excluded') {
      await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE plan_channel_id = $1::bigint AND status = 'open'`, [channelId]);
      await logChange(client, planId, user.userId, { type: 'channel_excluded', channel }, input.excluded_reason);
    } else {
      await mirrorChannelToRole(client, plan.role_id, channel, user.userId);
      await startChannel(client, plan, channelId, channel, now, settings);
      await logChange(client, planId, user.userId, { type: 'channel_added', channel });
    }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Change the strategy note. A plan has no individual owner — sourcing belongs to the HR/Admin persona as a whole — so there is nothing
    else to edit here. A real change is written to the plan's history. */
export async function updatePlan(planId: string, input: { strategy_note?: string | null }, user: JwtPayload): Promise<void> {
  await transaction(async (client) => {
    const pr = await client.query(`SELECT id::text AS id, strategy_note FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE`, [planId]);
    const cur = pr.rows[0];
    if (!cur) throw new SourcingError(404, 'Plan not found');
    if (input.strategy_note !== undefined) {
      const note = input.strategy_note?.toString().trim().slice(0, 2000) || null;
      if (note !== (cur.strategy_note ?? null)) {
        await client.query(`UPDATE sourcing_plans SET strategy_note = $2 WHERE id = $1::bigint`, [planId, note]);
        await logChange(client, planId, user.userId, { type: 'strategy_note_changed' });
      }
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
        [exceptionId, input.reason.trim(), input.corrective_action ?? null, s, user.userId]);
    } else if (input.path === 'blocker') {
      const due = input.blocker_due;
      if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due) || due < today || due > addCalendarDays(today, 60)) throw new SourcingError(400, 'A blocker needs a deadline within the next 60 days');
      const ownerId = input.blocker_owner_user_id ?? user.userId;
      const o = await client.query(`SELECT id FROM users WHERE id = $1::uuid AND is_active = true`, [ownerId]);
      if (!o.rows[0]) throw new SourcingError(400, 'The blocker owner must be an active user');
      await client.query(
        `UPDATE sourcing_exceptions SET status = 'blocked', resolution_path = 'blocker', reason = $2, corrective_action = $3, blocker_due = $4::date, blocker_owner_user_id = $5::uuid, resolved_by = $6::uuid WHERE id = $1::bigint`,
        [exceptionId, input.reason.trim(), input.corrective_action ?? null, due, ownerId, user.userId]);
    } else if (input.path === 'change_strategy') {
      if (input.exclude_channel) {
        if (e.channel === '*') throw new SourcingError(400, 'This exception is not tied to a channel');
        await client.query(`UPDATE sourcing_plan_channels SET state = 'excluded', excluded_reason = $3 WHERE plan_id = $1::bigint AND channel = $2`, [e.plan_id, e.channel, input.reason.trim()]);
        await client.query(
          `UPDATE sourcing_commitments SET status = 'skipped' WHERE status = 'open' AND plan_channel_id IN (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = $2)`, [e.plan_id, e.channel]);
      }
      await client.query(
        `UPDATE sourcing_exceptions SET status = 'resolved', resolution_path = 'change_strategy', reason = $2, corrective_action = $3, resolved_at = NOW(), resolved_by = $4::uuid WHERE id = $1::bigint`,
        [exceptionId, input.reason.trim(), input.corrective_action ?? null, user.userId]);
      await logChange(client, e.plan_id, user.userId, { type: 'strategy_changed', exception: e.type, channel: e.channel, excluded: !!input.exclude_channel }, input.reason.trim());
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

async function pausePlan(roleId: string) {
  await query(`UPDATE sourcing_plans SET status = 'paused', paused_at = NOW() WHERE role_id = $1 AND status = 'active'`, [roleId]);
}

async function resumePlan(roleId: string) {
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, paused_at FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p) { await ensureDraftPlansForOpenRoles(roleId); return; }
    const pausedMs = p.paused_at ? Math.max(0, Date.now() - new Date(p.paused_at).getTime()) : 0;
    // The clocks stopped while the role was on hold: shift every open commitment by the time spent paused.
    await client.query(
      `UPDATE sourcing_commitments SET due_at = due_at + ($2::bigint * INTERVAL '1 millisecond')
        WHERE status = 'open' AND plan_channel_id IN (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint)`, [p.id, Math.round(pausedMs)]);
    await client.query(`UPDATE sourcing_plans SET status = 'active', paused_at = NULL, pause_total_days = pause_total_days + $2 WHERE id = $1::bigint`, [p.id, Math.ceil(pausedMs / 86400000)]);
    await logChange(client, p.id, null, { type: 'resumed', paused_days: Math.ceil(pausedMs / 86400000) });
  });
}

async function closePlan(roleId: string, userId: string | null) {
  await transaction(async (client) => {
    const r = await client.query(`SELECT id::text AS id, status FROM sourcing_plans WHERE role_id = $1 FOR UPDATE`, [roleId]);
    const p = r.rows[0];
    if (!p || p.status === 'closed') return;
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
      await client.query(`UPDATE sourcing_commitments SET status = 'skipped' WHERE status = 'open' AND plan_channel_id = ANY($1::bigint[])`, [removed.rows.map(x => x.id)]);
      await logChange(client, p.id, userId, { type: 'channels_removed_on_role', channels: removed.rows.map(x => x.channel) });
    }
  });
}
