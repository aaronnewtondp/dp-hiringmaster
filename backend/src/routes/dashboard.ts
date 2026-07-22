import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { AGING_THRESHOLDS, Priority } from '../types/index.js';
import { runSlaCheck } from '../jobs/slaChecker.js';

// ─── Compute-on-read SLA trigger ──────────────────────────────────────────────
// Vercel Hobby tier only supports daily cron, not the 15-min interval the SLA
// checker needs. Instead of an always-on scheduler, run the same check
// opportunistically on dashboard load — the moment SLA data actually needs to
// be fresh. Throttled to avoid re-running on every request if polled often.
let lastSlaCheckAt = 0;
const SLA_CHECK_THROTTLE_MS = 3 * 60 * 1000; // 3 minutes

async function maybeRunSlaCheck(): Promise<void> {
  const now = Date.now();
  if (now - lastSlaCheckAt < SLA_CHECK_THROTTLE_MS) return;
  lastSlaCheckAt = now;
  try {
    await runSlaCheck();
  } catch (err) {
    console.error('[SLA] compute-on-read check failed:', err);
  }
}

const router = Router();
router.use(authenticate);

// ─── GET /api/dashboard — all Phase 1 metrics in one call ────────────────────
router.get('/', async (req: Request, res: Response) => {
  maybeRunSlaCheck(); // fire-and-forget — don't block the response

  const persona = req.user!.persona;
  const userId  = req.user!.userId;

  // Run all aggregate queries in parallel
  const [
    roleStats, candidateStats, slaBreaches,
    pendingActions, agingRoles, pipeline, joiningRisk,
    sourceQualityRows, timeToFillRows, agencyPerfRows,
  ] = await Promise.all([
    // Role counts by priority and status
    query<{ priority: string; status: string; count: string }>(`
      SELECT priority, status, COUNT(*) as count
      FROM roles
      WHERE status NOT IN ('Closed – Filled','Closed – Cancelled')
      GROUP BY priority, status
    `),

    // Candidate stats
    query<{ bucket: string; count: string }>(`
      SELECT
        CASE
          WHEN ai_fit_score >= 75 THEN 'strong_fit'
          WHEN ai_fit_score >= 50 THEN 'review'
          WHEN ai_fit_score IS NULL THEN 'unscored'
          ELSE 'low'
        END AS bucket,
        COUNT(*) as count
      FROM applications
      WHERE status = 'Active'
      GROUP BY bucket
    `),

    // SLA breach count
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM applications WHERE sla_breach=true AND status='Active'`
    ),

    // Pending actions by owner (unresolved only)
    query<{ owner_type: string; priority_level: string; action_type: string;
             description: string; id: number; application_id: string;
             candidate_name: string; role_title: string; hours_overdue: number }>(`
      SELECT * FROM pending_actions
      WHERE resolved=false
      ORDER BY priority_level DESC, created_at ASC
    `),

    // Roles with aging alerts (open roles past thresholds)
    query<{ id: string; title: string; priority: string; hiring_manager_name: string;
             start_date: string; target_closure_date: string; status: string;
             active_count: string }>(`
      SELECT r.id, r.title, r.priority, r.hiring_manager_name,
             r.start_date, r.target_closure_date, r.status,
             COUNT(a.id) FILTER (WHERE a.status='Active') AS active_count
      FROM roles r
      LEFT JOIN applications a ON a.role_id = r.id
      WHERE r.status NOT IN ('Closed – Filled','Closed – Cancelled','On Hold','Draft')
      GROUP BY r.id
      ORDER BY r.priority, r.start_date
    `),

    // Hiring funnel — counts by stage across all active applications
    query<{ stage: string; count: string }>(`
      SELECT stage, COUNT(*) as count
      FROM applications
      WHERE status = 'Active'
      GROUP BY stage
      ORDER BY COUNT(*) DESC
    `),

    // Joining risk — Offer Accepted with auto flag or no contact > 5 days
    query<{ id: string; candidate_name: string; role_title: string;
             joining_confidence: string; last_hr_contact: string; offer_joining_date: string }>(`
      SELECT a.id, c.full_name AS candidate_name, r.title AS role_title,
             a.joining_confidence, a.last_hr_contact, a.offer_joining_date
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN roles r ON r.id = a.role_id
      WHERE a.stage = 'Offer Accepted'
        AND (a.joining_risk_auto_flag = true
             OR a.joining_confidence = 'Low'
             OR (a.last_hr_contact IS NOT NULL AND a.last_hr_contact < NOW() - INTERVAL '5 days'))
    `),

    // Source Quality (Phase 2, PRD §18) — pass rate = advanced past raw
    // intake (stage <> 'Applied'), hire rate = stage = 'Joined', matching
    // agencies.ts's existing hire-rate precedent (stage, not status).
    // Computed over full history, not status='Active' only — a lagging
    // quality measure, not a live-state snapshot.
    query<{ source_channel: string; n: string; engaged: string; hired: string }>(`
      SELECT source_channel,
             COUNT(*) AS n,
             COUNT(*) FILTER (WHERE stage <> 'Applied') AS engaged,
             COUNT(*) FILTER (WHERE stage = 'Joined')  AS hired
      FROM applications
      WHERE source_channel IS NOT NULL
      GROUP BY source_channel ORDER BY n DESC
    `),

    // Time to Fill (Phase 2, PRD §18) — literally AVG(offer_accepted_date -
    // start_date), per priority. start_date is role Open Date (same field
    // aging_roles' days_open already uses), so this is "time from req-open
    // to offer-accepted." No status filter — an accepted offer is a real
    // historical fact regardless of what happened after.
    query<{ priority: string; n: string; avg_days: string | null }>(`
      SELECT r.priority, COUNT(*) AS n,
             AVG(a.offer_accepted_date - r.start_date) AS avg_days
      FROM applications a JOIN roles r ON r.id = a.role_id
      WHERE a.offer_accepted_date IS NOT NULL AND r.start_date IS NOT NULL
      GROUP BY r.priority
    `),

    // Agency Performance (Phase 2, PRD §18) — submissions/hire-rate
    // definitions match agencies.ts's total_submitted/total_hired exactly
    // (status NOT IN Rejected/Withdrawn; stage = 'Joined'), so this card's
    // numbers agree with each agency's own detail page.
    query<{ agency_id: string; agency_name: string; n: string; hired: string }>(`
      SELECT ag.id AS agency_id, ag.name AS agency_name,
             COUNT(*) FILTER (WHERE a.status NOT IN ('Rejected','Withdrawn')) AS n,
             COUNT(*) FILTER (WHERE a.stage = 'Joined') AS hired
      FROM applications a JOIN agencies ag ON ag.id = a.agency_id
      GROUP BY ag.id, ag.name ORDER BY n DESC
    `),
  ]);

  // ── Build metrics ───────────────────────────────────────────────────────────
  const openRolesByPriority: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let openRolesCount = 0;
  for (const row of roleStats) {
    if (['Live – Sourcing','Approved','Under Review'].includes(row.status)) {
      openRolesByPriority[row.priority] = (openRolesByPriority[row.priority] || 0) + parseInt(row.count);
      openRolesCount += parseInt(row.count);
    }
  }

  const candBuckets: Record<string, number> = { strong_fit: 0, review: 0, low: 0, unscored: 0 };
  let activeCandidates = 0;
  for (const row of candidateStats) {
    candBuckets[row.bucket] = parseInt(row.count);
    activeCandidates += parseInt(row.count);
  }

  // ── Compute aging for each role ─────────────────────────────────────────────
  const now = Date.now();
  const rolesWithAging = agingRoles.map(r => {
    const days = r.start_date
      ? Math.floor((now - new Date(r.start_date).getTime()) / 86400000)
      : 0;
    const thresh = AGING_THRESHOLDS[r.priority as Priority] || AGING_THRESHOLDS.P1;
    const aging_alert = days >= thresh.red ? 'red' : days >= thresh.yellow ? 'yellow' : 'ok';
    return { ...r, days_open: days, aging_alert, active_count: parseInt(r.active_count || '0') };
  });

  const redAlertRoles   = rolesWithAging.filter(r => r.aging_alert === 'red').length;
  const lowPipelineRoles = rolesWithAging.filter(r => r.active_count < 3 && r.aging_alert !== 'ok');

  // ── Group pending actions by owner ──────────────────────────────────────────
  const pendingByOwner: Record<string, typeof pendingActions> = {};
  for (const pa of pendingActions) {
    if (!pendingByOwner[pa.owner_type]) pendingByOwner[pa.owner_type] = [];
    pendingByOwner[pa.owner_type].push(pa);
  }

  // For HMs — filter to their own pending actions only
  const pendingForUser = persona === 'hiring_manager'
    ? pendingActions.filter(pa => pa.owner_type === 'Hiring Manager')
    : pendingActions;

  // ── Source Quality — pass_rate/hire_rate as 0-100, 1 decimal ────────────────
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const sourceQuality = sourceQualityRows.map(r => {
    const n = parseInt(r.n);
    return {
      source_channel: r.source_channel,
      n,
      pass_rate: n > 0 ? round1((parseInt(r.engaged) / n) * 100) : 0,
      hire_rate: n > 0 ? round1((parseInt(r.hired) / n) * 100) : 0,
    };
  });

  // ── Time to Fill — per-priority avg days, overall = weighted mean ──────────
  const byPriority: Record<string, number | null> = { P0: null, P1: null, P2: null, P3: null };
  let weightedSum = 0;
  let totalFilled = 0;
  for (const row of timeToFillRows) {
    const n = parseInt(row.n);
    const avgDays = row.avg_days != null ? Number(row.avg_days) : null;
    if (avgDays != null) {
      byPriority[row.priority] = round1(avgDays);
      weightedSum += avgDays * n;
      totalFilled += n;
    }
  }
  const timeToFill = {
    overall_days: totalFilled > 0 ? round1(weightedSum / totalFilled) : null,
    by_priority: byPriority,
  };

  // ── Agency Performance — hire_rate as 0-100, 1 decimal ──────────────────────
  const agencyPerformance = agencyPerfRows.map(r => {
    const n = parseInt(r.n);
    return {
      agency_id:   r.agency_id,
      agency_name: r.agency_name,
      n,
      hire_rate: n > 0 ? round1((parseInt(r.hired) / n) * 100) : 0,
    };
  });

  res.json({
    metrics: {
      open_roles_count:       openRolesCount,
      open_roles_by_priority: openRolesByPriority,
      active_candidates:      activeCandidates,
      strong_fit_candidates:  candBuckets.strong_fit,
      sla_breaches:           parseInt(slaBreaches?.count || '0'),
      total_pending_actions:  pendingForUser.length,
      red_aging_roles:        redAlertRoles,
      founder_review_pending: pendingActions.filter(pa => pa.action_type === 'Founder Review').length,
      joining_risk_count:     joiningRisk.length,
    },
    pending_actions_by_owner: pendingByOwner,
    aging_roles:   rolesWithAging.filter(r => r.aging_alert !== 'ok'),
    low_pipeline:  lowPipelineRoles,
    source_quality:     sourceQuality,
    time_to_fill:       timeToFill,
    agency_performance: agencyPerformance,
    hiring_funnel: pipeline,
    joining_risk:  joiningRisk,
  });
});

// ─── GET /api/dashboard/pending — just the pending actions queue ──────────────
router.get('/pending', async (req: Request, res: Response) => {
  const persona = req.user!.persona;
  let ownerFilter = '';

  // Each persona only sees their own queue by default
  if (persona === 'hiring_manager') ownerFilter = `AND owner_type='Hiring Manager'`;
  if (persona === 'interviewer')    ownerFilter = `AND owner_type='Interviewer'`;
  if (persona === 'leadership')     ownerFilter = `AND owner_type='Leadership / Founders'`;

  const actions = await query(
    `SELECT * FROM pending_actions WHERE resolved=false ${ownerFilter}
     ORDER BY priority_level DESC, created_at ASC LIMIT 100`
  );
  res.json({ actions });
});

export default router;
