// Sourcing Execution & Accountability — API. Spec: docs/SourcingModule_PRD_v2.md
//
//   * Everything is gated on SOURCING_ENABLED: reads answer `{ enabled:false }`, writes 503, so the UI can hide itself
//     and the module is inert until switched on.
//   * Writes are HR-tier. The role's own Hiring Manager(s) get a read-only, PARTLY redacted view: no strategy note, baseline,
//     owner, history, URLs, completion notes, exception reasons/evidence or provisional signals — but a channel's
//     excluded_reason and an exception's resolution_path / snooze_until / blocker_due still come through (left that way on
//     purpose). Every persona can already read GET /roles/:id, so a plan payload must not widen what a Hiring Manager sees.
//   * Prospect-level data (P4) is never served from here to anyone but HR-tier.
import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, isHRTier, requireHR } from '../middleware/auth.js';
import { isNamedHiringManager } from '../utils/hiringManagers.js';
import { isSourcingEnabled, OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';
import { loadSettings, saveSettings } from '../services/sourcingSettings.js';
import {
  activatePlan, closeChannel, completeCommitment, effectiveTarget, ensureDraftPlansForOpenRoles, getPlanRowById, getPlanView, listPeople, redactForHiringManager,
  reopenChannel, reopenCommitment, resolveException, setChannelState, skipCommitment, SourcingError, updateChannelSettings, updatePlan,
} from '../services/sourcingPlans.js';
import { getAdvice } from '../services/sourcingAdvisor.js';
import { getWorkspace } from '../services/sourcingWorkspace.js';
import { maybeRunSourcingCheck } from '../jobs/sourcingChecker.js';
import { qualifiedInWindow, QUALIFIED_TIMESTAMPS_SQL, QualifiedInput } from '../utils/sourcingQualified.js';
import { istDate } from '../utils/workingDays.js';
import { ageDays, describeException } from '../utils/sourcingDescribe.js';

const router = Router();
router.use(authenticate);

const OPEN = OPEN_ROLE_STATUSES as unknown as string[];

function disabled(req: Request, res: Response, next: NextFunction) {
  if (isSourcingEnabled()) { next(); return; }
  if (req.method === 'GET') { res.json({ enabled: false }); return; }
  res.status(503).json({ error: 'The sourcing module is not enabled', enabled: false });
}

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof SourcingError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[Sourcing] ${what} failed:`, err);
  res.status(500).json({ error: `${what} failed` });
}

const idParam = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,18}$/.test(v) ? v : null);

/** Is this user a Hiring Manager of the role? Compares users.name (what an admin keeps in roles.hiring_manager_name). */
async function isHiringManagerOf(userId: string, hiringManagerField: string | null): Promise<boolean> {
  if (!hiringManagerField) return false;
  const u = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
  return isNamedHiringManager(u?.name, hiringManagerField);
}

// ── Status & settings ──────────────────────────────────────────────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  if (!isSourcingEnabled()) { res.json({ enabled: false }); return; }
  try {
    const s = await loadSettings();
    res.json({ enabled: true, settings: { go_live_date: s.go_live_date, shadow_until: s.shadow_until, qualified_rule: s.qualified_rule,
      volume_min_qualified: s.volume_min_qualified, referral_audience_email: s.referral_audience_email } });
  } catch (err) { fail(res, err, 'Status'); }
});

router.get('/settings', disabled, requireHR, async (_req: Request, res: Response) => {
  try { res.json({ enabled: true, settings: await loadSettings() }); } catch (err) { fail(res, err, 'Loading settings'); }
});

router.put('/settings', disabled, requireHR, async (req: Request, res: Response) => {
  // Thresholds change what counts as "late" for everyone: Leadership / Super-Admin only.
  if (req.user!.persona === 'hr_recruiter') { res.status(403).json({ error: 'Only Leadership or the Super Admin can change sourcing settings' }); return; }
  try {
    const patch = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    const result = await saveSettings(patch, req.user!.userId);
    if (result.rejected.length && !result.saved.length) { res.status(400).json({ error: `Nothing saved — invalid: ${result.rejected.join(', ')}`, rejected: result.rejected }); return; }
    res.json({ enabled: true, ...result });
  } catch (err) { fail(res, err, 'Saving settings'); }
});

// People who can be named as the owner of a blocker. A plan has no individual owner: sourcing belongs to the HR/Admin persona as a whole.
router.get('/people', disabled, requireHR, async (_req: Request, res: Response) => {
  try { res.json({ people: await listPeople() }); } catch (err) { fail(res, err, 'Loading people'); }
});

// ── Sourcing page: the roles you can switch between ─────────────────────────────────────────────
// HR-tier sees every role with a plan (active and paused ones to switch between, drafts waiting to be activated); a Hiring Manager
// sees only the roles they are named on, never a draft.
router.get('/workspace', disabled, async (req: Request, res: Response) => {
  try {
    const hr = isHRTier(req.user!.persona);
    if (!hr && req.user!.persona !== 'hiring_manager') { res.status(403).json({ error: 'Not available' }); return; }
    if (hr) await ensureDraftPlansForOpenRoles();
    await maybeRunSourcingCheck();
    res.json({ enabled: true, read_only: !hr, ...(await getWorkspace({ userId: req.user!.userId, hr })) });
  } catch (err) { fail(res, err, 'Loading the sourcing workspace'); }
});

// ── A role's plan ──────────────────────────────────────────────────────────────────────────────────
router.get('/plans/:roleId', disabled, async (req: Request, res: Response) => {
  try {
    const roleId = String(req.params.roleId);
    const role = await queryOne<{ id: string; status: string; hiring_manager_name: string | null }>(
      'SELECT id, status, hiring_manager_name FROM roles WHERE id = $1', [roleId]);
    if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

    const hr = isHRTier(req.user!.persona);
    if (!hr && !(req.user!.persona === 'hiring_manager' && await isHiringManagerOf(req.user!.userId, role.hiring_manager_name))) {
      res.status(403).json({ error: 'Not available for this role' }); return;
    }

    // First visit to an open role that has no plan yet (hook missed / role approved before go-live): seed the draft.
    if (hr && OPEN.includes(role.status)) await ensureDraftPlansForOpenRoles(roleId);
    const view = await getPlanView(roleId);
    if (!view) { res.json({ enabled: true, plan: null }); return; }
    res.json({ enabled: true, ...(hr ? view : redactForHiringManager(view)), read_only: !hr });
  } catch (err) { fail(res, err, 'Loading the plan'); }
});

// "What to do next": AI-written, cached steps for the plan (HR-tier only — a Hiring Manager's view carries none). ?refresh=1 asks for a new
// one (at most once a minute). Always answers: if the model is unavailable the steps come from rules and say so.
router.get('/plans/:roleId/advice', disabled, requireHR, async (req: Request, res: Response) => {
  try {
    const result = await getAdvice(String(req.params.roleId), { refresh: req.query.refresh === '1' || req.query.refresh === 'true' });
    res.json({ enabled: true, advice: result });
  } catch (err) { fail(res, err, 'Writing the next steps'); }
});

router.post('/plans/:planId/activate', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  const wq = req.body?.weekly_qualified_target;
  if (wq !== undefined && wq !== null && typeof wq !== 'number') { res.status(400).json({ error: 'The weekly qualified target must be a whole number from 1 to 500' }); return; }
  try {
    await activatePlan(planId, {
      strategy_note: typeof req.body?.strategy_note === 'string' ? req.body.strategy_note : null,
      weekly_qualified_target: typeof wq === 'number' ? wq : null,
      channels: Array.isArray(req.body?.channels) ? req.body.channels : [],
    }, req.user!);
    const plan = await getPlanRowById(planId);
    res.json({ success: true, plan_id: planId, role_id: plan?.role_id });
  } catch (err) { fail(res, err, 'Activating the plan'); }
});

router.patch('/plans/:planId', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  // Sourcing is owned by the HR/Admin persona as a whole; there is no per-person owner to set.
  if ('owner_user_id' in (req.body ?? {})) { res.status(400).json({ error: 'A plan has no individual owner — sourcing belongs to HR/Admin' }); return; }
  try {
    const input: { strategy_note?: string | null; weekly_qualified_target?: number | null } = {};
    if ('strategy_note' in (req.body ?? {})) input.strategy_note = typeof req.body.strategy_note === 'string' ? req.body.strategy_note : null;
    if ('weekly_qualified_target' in (req.body ?? {})) {
      const t = req.body.weekly_qualified_target;
      if (t !== null && typeof t !== 'number') { res.status(400).json({ error: 'The weekly qualified target must be a whole number, or null for the default' }); return; }
      input.weekly_qualified_target = t;
    }
    await updatePlan(planId, input, req.user!);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Updating the plan'); }
});

// The channel travels in the body, not the path: "Naukri/IIMjobs" contains a slash and a percent-encoded %2F in a path
// segment is not reliably preserved by every proxy/rewrite layer.
router.put('/plans/:planId/channel', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  const state = req.body?.state;
  if (state !== 'planned' && state !== 'excluded') { res.status(400).json({ error: 'state must be "planned" or "excluded"' }); return; }
  try {
    await setChannelState(planId, String(req.body?.channel ?? ''), { state, excluded_reason: typeof req.body?.excluded_reason === 'string' ? req.body.excluded_reason : null }, req.user!);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Updating the channel'); }
});

// Close Channel: skips its open tasks, keeps the post link, targets and weekly results as a summary. Reopen brings it back.
router.post('/plans/:planId/channel/close', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  try {
    await closeChannel(planId, String(req.body?.channel ?? ''), typeof req.body?.reason === 'string' ? req.body.reason : '', req.user!);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Closing the channel'); }
});

router.post('/plans/:planId/channel/reopen', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  try { await reopenChannel(planId, String(req.body?.channel ?? ''), req.user!); res.json({ success: true }); }
  catch (err) { fail(res, err, 'Reopening the channel'); }
});

// Edit a live LinkedIn / Naukri/IIMjobs / Direct Outreach channel's weekly sourcing target and post link.
router.patch('/plans/:planId/channel-settings', disabled, requireHR, async (req: Request, res: Response) => {
  const planId = idParam(req.params.planId);
  if (!planId) { res.status(400).json({ error: 'Invalid plan id' }); return; }
  const b = req.body ?? {};
  try {
    const input: { weekly_target?: number | null; posting_url?: string | null } = {};
    if ('weekly_target' in b) input.weekly_target = typeof b.weekly_target === 'number' ? b.weekly_target : null;
    if ('posting_url' in b) input.posting_url = typeof b.posting_url === 'string' ? b.posting_url : null;
    await updateChannelSettings(planId, String(b.channel ?? ''), input, req.user!);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Updating the channel'); }
});

// ── Commitments ────────────────────────────────────────────────────────────────────────────────────
router.post('/commitments/:id/complete', disabled, requireHR, async (req: Request, res: Response) => {
  const id = idParam(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid commitment id' }); return; }
  const b = req.body ?? {};
  try {
    const out = await completeCommitment(id, {
      note: typeof b.note === 'string' ? b.note : null,
      url: typeof b.url === 'string' && b.url.trim() ? b.url : null,
      count: typeof b.count === 'number' ? b.count : null,
      attest: b.attest === true,
      posted_at: typeof b.posted_at === 'string' ? b.posted_at : null,
      weekly_target: typeof b.weekly_target === 'number' ? b.weekly_target : null,
    }, req.user!);
    res.json({ success: true, role_id: out.roleId });
  } catch (err) { fail(res, err, 'Completing the commitment'); }
});

router.post('/commitments/:id/skip', disabled, requireHR, async (req: Request, res: Response) => {
  const id = idParam(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid commitment id' }); return; }
  try { await skipCommitment(id, typeof req.body?.reason === 'string' ? req.body.reason : '', req.user!); res.json({ success: true }); }
  catch (err) { fail(res, err, 'Skipping the commitment'); }
});

router.post('/commitments/:id/reopen', disabled, requireHR, async (req: Request, res: Response) => {
  const id = idParam(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid commitment id' }); return; }
  try { await reopenCommitment(id, req.user!); res.json({ success: true }); }
  catch (err) { fail(res, err, 'Reopening the commitment'); }
});

// ── Exceptions ─────────────────────────────────────────────────────────────────────────────────────
router.post('/exceptions/:id/resolve', disabled, requireHR, async (req: Request, res: Response) => {
  const id = idParam(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid exception id' }); return; }
  const b = req.body ?? {};
  if (b.path !== 'catch_up' && b.path !== 'change_strategy' && b.path !== 'blocker') { res.status(400).json({ error: 'path must be catch_up, change_strategy or blocker' }); return; }
  try {
    await resolveException(id, {
      path: b.path, reason: typeof b.reason === 'string' ? b.reason : '',
      corrective_action: typeof b.corrective_action === 'string' ? b.corrective_action : null,
      snooze_until: typeof b.snooze_until === 'string' ? b.snooze_until : null,
      blocker_owner_user_id: typeof b.blocker_owner_user_id === 'string' ? b.blocker_owner_user_id : null,
      blocker_due: typeof b.blocker_due === 'string' ? b.blocker_due : null,
      exclude_channel: b.exclude_channel === true,
    }, req.user!);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Resolving the exception'); }
});

// ── My Tasks "Sourcing" queue ──────────────────────────────────────────────────────────────────────
// Sourcing is owned by the HR/Admin persona as a whole, so every HR-tier user sees the same queue: there is no "mine" and no per-person scope.
router.get('/queue', disabled, requireHR, async (_req: Request, res: Response) => {
  try {
    await maybeRunSourcingCheck();
    const settings = await loadSettings();
    const today = istDate(new Date());
    const PRI = `CASE r.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;

    const [toActivate, dueRows, exceptionRows, counts, volApps, activePlans] = await Promise.all([
      query<{ plan_id: string; role_id: string; title: string; priority: string; approval_date: string | null }>(
        `SELECT p.id::text AS plan_id, r.id AS role_id, r.title, r.priority, to_char(r.approval_date,'YYYY-MM-DD') AS approval_date
           FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
          WHERE p.status = 'draft' AND r.status = ANY($1::text[])
          ORDER BY ${PRI}, r.approval_date NULLS LAST, r.id`, [OPEN]),
      query<{ id: string; plan_id: string; role_id: string; title: string; priority: string; channel: string; kind: string; ctitle: string; due_at: Date }>(
        `SELECT c.id::text AS id, p.id::text AS plan_id, r.id AS role_id, r.title, r.priority, ch.channel, c.kind, c.title AS ctitle, c.due_at
           FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id
           JOIN roles r ON r.id = p.role_id
          WHERE c.status = 'open' AND p.status = 'active' AND ch.state <> 'excluded'
            AND c.due_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
          ORDER BY c.due_at, ${PRI}`, [today]),
      query<{ id: string; plan_id: string; role_id: string; title: string; priority: string; channel: string; type: string; severity: number; detected_at: Date; evidence: Record<string, unknown> }>(
        `SELECT e.id::text AS id, p.id::text AS plan_id, r.id AS role_id, r.title, r.priority, e.channel, e.type, e.severity, e.detected_at, e.evidence
           FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id = e.plan_id JOIN roles r ON r.id = p.role_id
          WHERE e.status = 'open' AND NOT e.is_shadow AND p.status <> 'paused'   -- a plan on hold is set aside until the role is back
          ORDER BY e.severity DESC, e.detected_at`),
      queryOne<{ snoozed: string; blocked: string; active_plans: string }>(
        `SELECT count(*) FILTER (WHERE e.status = 'snoozed' AND NOT e.is_shadow) AS snoozed,
                count(*) FILTER (WHERE e.status = 'blocked' AND NOT e.is_shadow) AS blocked,
                (SELECT count(*) FROM sourcing_plans p2 WHERE p2.status = 'active') AS active_plans
           FROM sourcing_exceptions e`),
      query<{ role_id: string; shortlisted_at: Date | null; scored_at: Date | null }>(
        `SELECT a.role_id, ${QUALIFIED_TIMESTAMPS_SQL} FROM applications a
          WHERE a.role_id IN (SELECT p.role_id FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
                               WHERE p.status = 'active' AND (r.priority IN ('P0','P1') OR p.weekly_qualified_target IS NOT NULL))
            AND (a.score_computed_at >= $1 OR a.last_updated >= $1 OR a.application_date >= $1)`,
        [new Date(Date.now() - 21 * 86400000)]),
      query<{ role_id: string; title: string; priority: string; target: number | null }>(
        `SELECT r.id AS role_id, r.title, r.priority, p.weekly_qualified_target AS target FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
          WHERE p.status = 'active' AND (r.priority IN ('P0','P1') OR p.weekly_qualified_target IS NOT NULL) ORDER BY ${PRI}, r.id`),
    ]);

    const byRole = new Map<string, QualifiedInput[]>();
    for (const a of volApps) {
      const list = byRole.get(a.role_id) ?? [];
      list.push({ shortlisted_at: a.shortlisted_at ? new Date(a.shortlisted_at) : null, scored_at: a.scored_at ? new Date(a.scored_at) : null });
      byRole.set(a.role_id, list);
    }
    const now = new Date();
    const volume = activePlans.map(p => ({
      role_id: p.role_id, title: p.title, priority: p.priority, min: effectiveTarget(p.target, p.priority, settings).min,
      qualified: qualifiedInWindow(byRole.get(p.role_id) ?? [], now, settings.volume_window_days, settings.qualified_rule).qualified,
    }));

    // Exceptions grouped by role, worst first; the client shows the top 5 and "N more".
    type QueueException = { id: string; plan_id: string; channel: string; type: string; severity: number; age_days: number; committed: string; happened: string; next_action: string };
    const grouped = new Map<string, { role_id: string; title: string; priority: string; severity: number; items: QueueException[] }>();
    for (const e of exceptionRows) {
      const g = grouped.get(e.role_id) ?? { role_id: e.role_id, title: e.title, priority: e.priority, severity: 0, items: [] };
      g.items.push({ id: e.id, plan_id: e.plan_id, channel: e.channel, type: e.type, severity: e.severity, age_days: ageDays(e.detected_at, now), ...describeException(e) });
      g.severity = Math.max(g.severity, e.severity);
      grouped.set(e.role_id, g);
    }

    res.json({
      enabled: true, today,
      plans_to_activate: toActivate,
      due: dueRows.map(d => ({ id: d.id, plan_id: d.plan_id, role_id: d.role_id, role_title: d.title, priority: d.priority, channel: d.channel, kind: d.kind, title: d.ctitle,
        due_date: istDate(new Date(d.due_at)), overdue: new Date(d.due_at).getTime() < now.getTime() })),
      exceptions: [...grouped.values()].sort((a, b) => b.severity - a.severity),
      exception_count: exceptionRows.length,
      snoozed_count: Number(counts?.snoozed ?? 0), blocked_count: Number(counts?.blocked ?? 0), active_plans: Number(counts?.active_plans ?? 0),
      volume,
      volume_ok: volume.filter(v => v.qualified >= v.min).length,
    });
  } catch (err) { fail(res, err, 'Loading the sourcing queue'); }
});

export default router;
