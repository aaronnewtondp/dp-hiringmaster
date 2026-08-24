import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { AGING_THRESHOLDS, Priority } from '../types/index.js';
import { runSlaCheck } from '../jobs/slaChecker.js';
import { parseRoleFilters, buildRoleFilterSql, roleIdsSubquery } from '../utils/roleFilters.js';

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

// Mirrors frontend/src/types/index.ts's STAGES exactly — backend has no
// shared copy of this list, so it's duplicated here for the Operational
// Velocity metrics' "reached interview"/"reached offer" threshold checks.
const STAGE_ORDER = [
  'Applied', 'Resume Review', 'Shortlisted',
  'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round',
  'Reference Check', 'Pre-Joining Documents', 'Offer Discussion',
  'Offer Released', 'Offer Accepted', 'Joined',
];
const FIRST_INTERVIEW_IDX = STAGE_ORDER.indexOf('Interview Round 1');
const FIRST_OFFER_IDX     = STAGE_ORDER.indexOf('Offer Released');

// ─── GET /api/dashboard — all Phase 1 metrics in one call ────────────────────
router.get('/', async (req: Request, res: Response) => {
  // Awaited, not fire-and-forget — same rule as JD generation/ResumeIQ (see
  // CLAUDE.md): Vercel can freeze/tear down the function the instant this
  // response is sent, so a detached call here could get cut off mid-loop.
  // That's exactly what was happening: checkApplicationSLAs() sets
  // sla_breach=true as its first statement per application, then does several
  // more awaited queries (candidate/role lookups, the pending_actions
  // insert) — a mid-loop teardown left applications with sla_breach=true and
  // no pending_actions row at all, a gap that grew every time the throttle
  // let this run again. maybeRunSlaCheck() already swallows and logs its own
  // errors, so awaiting it here just guarantees it runs to completion before
  // the response (and before this) goes out — it doesn't change what happens
  // on failure.
  await maybeRunSlaCheck();

  const persona = req.user!.persona;
  const userId  = req.user!.userId;

  // Master filters (Department/Location/Recruitment Mode/Priority/Status) —
  // same shape and SQL semantics as the Roles summary view's own filters.
  // Every query below is scoped to the matching role set: queries that
  // already join `roles` apply the fragment directly; queries that only
  // touch applications/pending_actions filter via a `role_id IN (subquery)`
  // built from the exact same fragment, so the two can never disagree on
  // what "Department = X" means. roleIdsSubquery() returns null when no
  // filters are active, so the unfiltered (common) path skips the subquery
  // entirely rather than paying for it on every dashboard load.
  const filters = parseRoleFilters(req.query as Record<string, unknown>);

  // Run all aggregate queries in parallel
  const [
    roleStats, candidateStats, slaBreaches,
    pendingActions, agingRoles, funnelRows, joiningRisk,
    sourceQualityRows, timeToFillRows,
    allStageRows, tatByStageRows,
  ] = await Promise.all([
    // Role counts by priority and status
    (() => {
      const f = buildRoleFilterSql(filters, 1);
      return query<{ priority: string; status: string; count: string }>(`
        SELECT r.priority, r.status, COUNT(*) as count
        FROM roles r
        WHERE r.status NOT IN ('Closed – Filled','Closed – Cancelled')
        ${f.sql}
        GROUP BY r.priority, r.status
      `, f.params);
    })(),

    // Candidate stats
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ bucket: string; count: string }>(`
        SELECT
          CASE
            WHEN ai_fit_score >= 70 THEN 'strong_fit'
            WHEN ai_fit_score >= 50 THEN 'review'
            WHEN ai_fit_score IS NULL THEN 'unscored'
            ELSE 'low'
          END AS bucket,
          COUNT(*) as count
        FROM applications
        WHERE status = 'Active'
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY bucket
      `, scoped?.params || []);
    })(),

    // SLA breach count
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM applications WHERE sla_breach=true AND status='Active'
         ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}`,
        scoped?.params || []
      );
    })(),

    // Pending actions by owner (unresolved only) — joined to the linked
    // application for its live current stage (so the HR/Recruiter card can
    // show where a breached candidate actually sits) and sla_breach flag
    // (so the top-line counter can exclude SLA-breach-driven entries without
    // hardcoding action_type strings — same underlying signal as the
    // sla_breaches metric below, so the two numbers always reconcile).
    // 'Role aging alert' is excluded outright: PRD-wise it belongs to the
    // dedicated Aging Roles box, not Pending Actions — see aging_roles below.
    // When master filters are active, entries with no linked application
    // (currently just the CTC-change-trigger's 'Compensation change flag',
    // which only carries a denormalized role_title snapshot, no role_id) are
    // excluded too — there's no safe way to know which role they belong to.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ owner_type: string; priority_level: string; action_type: string;
               description: string; id: number; application_id: string;
               candidate_name: string; role_title: string; hours_overdue: number;
               current_stage: string | null; sla_breach: boolean | null;
               candidate_id: string | null; role_id: string | null; responsible_person: string | null;
               ai_fit_score: number | null }>(`
        SELECT pa.*, a.stage AS current_stage, a.sla_breach AS sla_breach,
               a.candidate_id AS candidate_id, a.ai_fit_score AS ai_fit_score
        FROM pending_actions pa
        LEFT JOIN applications a ON a.id = pa.application_id
        WHERE pa.resolved=false
          AND pa.action_type <> 'Role aging alert'
          ${scoped ? ` AND COALESCE(a.role_id, pa.role_id) IN ${scoped.sql}` : ''}
        ORDER BY pa.priority_level DESC, pa.created_at ASC
      `, scoped?.params || []);
    })(),

    // Roles with aging alerts (open roles past thresholds)
    (() => {
      const f = buildRoleFilterSql(filters, 1);
      return query<{ id: string; title: string; priority: string; hiring_manager_name: string;
               start_date: string; target_closure_date: string; status: string;
               active_count: string }>(`
        SELECT r.id, r.title, r.priority, r.hiring_manager_name,
               r.start_date, r.target_closure_date, r.status,
               COUNT(a.id) FILTER (WHERE a.status='Active') AS active_count
        FROM roles r
        LEFT JOIN applications a ON a.role_id = r.id
        WHERE r.status NOT IN ('Closed – Filled','Closed – Cancelled','On Hold','Draft')
        ${f.sql}
        GROUP BY r.id
        ORDER BY r.priority, r.start_date
      `, f.params);
    })(),

    // Hiring funnel — every candidate who ever reached each stage, broken
    // down by what became of them (Active/Rejected/Withdrawn/Hold for
    // Future), not just those still actively sitting there. Grouped by
    // (stage, status) in one query; JS below fills in every canonical stage
    // (even ones with zero rows here) so a role/filter where every
    // candidate at a stage has since been rejected doesn't make that stage
    // vanish from the funnel entirely — it used to, when this only counted
    // status='Active'.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ stage: string; status: string; count: string }>(`
        SELECT stage, status, COUNT(*) as count
        FROM applications
        WHERE status IN ('Active','Rejected','Withdrawn','Hold for Future')
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY stage, status
      `, scoped?.params || []);
    })(),

    // Joining risk — Offer Accepted with auto flag or no contact > 5 days
    (() => {
      const f = buildRoleFilterSql(filters, 1);
      return query<{ id: string; candidate_name: string; role_title: string;
               joining_confidence: string; last_hr_contact: string; offer_joining_date: string }>(`
        SELECT a.id, c.full_name AS candidate_name, r.title AS role_title,
               a.joining_confidence, a.last_hr_contact, a.offer_joining_date
        FROM applications a
        JOIN candidates c ON c.id = a.candidate_id
        JOIN roles r ON r.id = a.role_id
        WHERE a.stage = 'Offer Accepted'
          AND a.status = 'Active'
          AND (a.joining_risk_auto_flag = true
               OR a.joining_confidence = 'Low'
               OR (a.last_hr_contact IS NOT NULL AND a.last_hr_contact < NOW() - INTERVAL '5 days'))
        ${f.sql}
      `, f.params);
    })(),

    // Source Quality (Phase 2, PRD §18) — pass rate = advanced past raw
    // intake (stage <> 'Applied'), hire rate = stage = 'Joined', matching
    // agencies.ts's existing hire-rate precedent (stage, not status).
    // Computed over full history, not status='Active' only — a lagging
    // quality measure, not a live-state snapshot.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ source_channel: string; n: string; engaged: string; hired: string }>(`
        SELECT source_channel,
               COUNT(*) AS n,
               COUNT(*) FILTER (WHERE stage <> 'Applied') AS engaged,
               COUNT(*) FILTER (WHERE stage = 'Joined')  AS hired
        FROM applications
        WHERE source_channel IS NOT NULL AND source_channel <> ''
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY source_channel ORDER BY n DESC
      `, scoped?.params || []);
    })(),

    // Time to Fill (Phase 2, PRD §18) — literally AVG(offer_accepted_date -
    // start_date), per priority. start_date is role Open Date (same field
    // aging_roles' days_open already uses), so this is "time from req-open
    // to offer-accepted." No status filter — an accepted offer is a real
    // historical fact regardless of what happened after.
    (() => {
      const f = buildRoleFilterSql(filters, 1);
      return query<{ priority: string; n: string; avg_days: string | null }>(`
        SELECT r.priority, COUNT(*) AS n,
               AVG(a.offer_accepted_date - r.start_date) AS avg_days
        FROM applications a JOIN roles r ON r.id = a.role_id
        WHERE a.offer_accepted_date IS NOT NULL AND r.start_date IS NOT NULL
        ${f.sql}
        GROUP BY r.priority
      `, f.params);
    })(),

    // Operational Velocity (items #10/#29) — every application's current
    // (frozen-on-rejection) stage, regardless of status, for the
    // interview-to-offer ratio: unlike the Hiring Funnel/rejected-by-stage
    // queries above, this deliberately does NOT filter by status, since a
    // candidate who interviewed and was later rejected still "reached
    // interview" for this ratio's purpose.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ stage: string; count: string }>(`
        SELECT stage, COUNT(*) as count
        FROM applications
        WHERE 1=1
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY stage
      `, scoped?.params || []);
    })(),

    // Turnaround time per stage, in hours — derived entirely from existing
    // 'Stage Changed' activity_log rows (applications.ts's logActivity),
    // no new schema needed. Each Stage-Changed event's new_value is the
    // stage being entered at created_at; LEAD gives the timestamp of the
    // NEXT stage change for the same application, i.e. when that stage was
    // left. The 'Applied' segment (entered at application_date, left at the
    // application's first-ever Stage Changed event) is unioned in
    // separately since nothing ever logs "entering Applied" as an event.
    // Rows with no left_at yet (still sitting in that stage) are excluded —
    // an open-ended stay isn't a turnaround time yet.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      const roleJoin = scoped ? `JOIN applications ra ON ra.id = al.application_id AND ra.role_id IN ${scoped.sql}` : '';
      const appliedRoleJoin = scoped ? `AND a.role_id IN ${scoped.sql}` : '';
      return query<{ stage: string; avg_hours: string; n: string }>(`
        WITH events AS (
          SELECT al.application_id, al.new_value AS stage, al.created_at AS entered_at,
                 LEAD(al.created_at) OVER (PARTITION BY al.application_id ORDER BY al.created_at) AS left_at
          FROM activity_log al
          ${roleJoin}
          WHERE al.event_type = 'Stage Changed' AND al.application_id IS NOT NULL
        ),
        applied_segment AS (
          SELECT a.id AS application_id, 'Applied' AS stage, a.application_date AS entered_at,
                 MIN(al.created_at) AS left_at
          FROM applications a
          JOIN activity_log al ON al.application_id = a.id AND al.event_type = 'Stage Changed'
          WHERE 1=1 ${appliedRoleJoin}
          GROUP BY a.id, a.application_date
        ),
        segments AS (
          SELECT stage, entered_at, left_at FROM events WHERE left_at IS NOT NULL
          UNION ALL
          SELECT stage, entered_at, left_at FROM applied_segment WHERE left_at IS NOT NULL
        )
        SELECT stage, AVG(EXTRACT(EPOCH FROM (left_at - entered_at)) / 3600) AS avg_hours, COUNT(*) AS n
        FROM segments
        GROUP BY stage
      `, scoped?.params || []);
    })(),
  ]);

  // ── Build metrics ───────────────────────────────────────────────────────────
  const openRolesByPriority: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let openRolesCount = 0;
  // Roles by status — every status roleStats saw, not just the "open" subset
  // above (which only counts Live – Sourcing/Approved/Under Review). Replaces
  // the dashboard's old free-form role-Status filter with a direct count.
  const rolesByStatus: Record<string, number> = {};
  for (const row of roleStats) {
    rolesByStatus[row.status] = (rolesByStatus[row.status] || 0) + parseInt(row.count);
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
  // Hiring Manager column specifically: highest fit score first, so the HM
  // sees their best candidates at the top of an overdue list rather than
  // whatever order SLA breaches happened to fire in. Rows with no score
  // (e.g. the Compensation change flag, which isn't tied to an application)
  // sort last, not first.
  if (pendingByOwner['Hiring Manager']) {
    pendingByOwner['Hiring Manager'] = [...pendingByOwner['Hiring Manager']].sort(
      (a, b) => (b.ai_fit_score ?? -1) - (a.ai_fit_score ?? -1)
    );
  }

  // For HMs — filter to their own pending actions only. Was previously just
  // owner_type === 'Hiring Manager', which pools EVERY hiring manager's
  // actions together — any HM with open items saw every other HM's too,
  // since owner_type only distinguishes the queue (HR/HM/Interviewer/
  // Leadership), not which specific person within it. responsible_person is
  // the same name field roles.ts already compares req.user!.name against
  // for its own HM-identity checks.
  const userNameLower = req.user!.name.trim().toLowerCase();
  const pendingForUser = persona === 'hiring_manager'
    ? pendingActions.filter(pa =>
        pa.owner_type === 'Hiring Manager' &&
        !!pa.responsible_person &&
        pa.responsible_person.trim().toLowerCase() === userNameLower
      )
    : pendingActions;

  // Pending Actions counter excludes SLA-breach-driven HR/Recruiter entries
  // specifically — that's the box the SLA Breaches metric is "directly
  // linked to" (nearly every HR/Recruiter action — Idle candidate, Resume to
  // triage — exists *because* an SLA breached, so counting both would double
  // up the same event). Hiring Manager/Interviewer/Leadership entries always
  // count even when SLA-breach-driven (e.g. "Interview feedback due" is a
  // distinct action a different persona owns, not a restatement of the SLA
  // Breaches KPI) — excluding by sla_breach flag alone, regardless of owner,
  // previously wiped out nearly every real pending action. Role aging alerts
  // are already excluded upstream (query above).
  const totalPendingActions = pendingForUser.filter(
    pa => !(pa.owner_type === 'HR / Recruiter' && pa.sla_breach)
  ).length;

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

  // ── Hiring funnel — every canonical stage, every status ─────────────────────
  // Always includes all 13 stages (even ones with zero rows in funnelRows),
  // so a filtered view where every candidate at a stage has since moved off
  // 'Active' doesn't make that stage disappear from the funnel.
  type FunnelCounts = { active: number; rejected: number; withdrawn: number; hold_for_future: number };
  const funnelByStage: Record<string, FunnelCounts> = {};
  for (const stage of STAGE_ORDER) funnelByStage[stage] = { active: 0, rejected: 0, withdrawn: 0, hold_for_future: 0 };
  for (const row of funnelRows) {
    const bucket = funnelByStage[row.stage];
    if (!bucket) continue; // a retired stage name from old data — nothing current can be sitting there
    const n = parseInt(row.count);
    if (row.status === 'Active') bucket.active = n;
    else if (row.status === 'Rejected') bucket.rejected = n;
    else if (row.status === 'Withdrawn') bucket.withdrawn = n;
    else if (row.status === 'Hold for Future') bucket.hold_for_future = n;
  }
  const hiringFunnel = STAGE_ORDER.map(stage => ({ stage, ...funnelByStage[stage] }));

  // rejected_by_stage kept as its own top-level field (same shape as before)
  // since biggest_drop_off below reads it directly — now just derived from
  // the funnel query above instead of its own separate query.
  const rejectedByStage: Record<string, number> = {};
  for (const stage of STAGE_ORDER) rejectedByStage[stage] = funnelByStage[stage].rejected;

  // Response contract for rejected_by_stage is sparse — only stages with an
  // actual rejection appear as keys (pre-existing shape, unchanged by the
  // funnel rework above). rejectedByStage itself stays dense internally
  // since biggestDropOff below needs the zero-filtered view either way.
  const rejectedByStageSparse: Record<string, number> = Object.fromEntries(
    Object.entries(rejectedByStage).filter(([, c]) => c > 0)
  );

  // ── Operational Velocity (items #10/#29) ────────────────────────────────────
  // Interview-to-offer ratio: of everyone who ever reached an interview
  // round (regardless of what happened after — rejected, withdrawn, hired),
  // what fraction reached Offer Released or beyond. stage never resets on
  // rejection (see rejected-by-stage above), so a stage index comparison on
  // the current, possibly-frozen stage correctly captures "furthest reached."
  let interviewedCount = 0;
  let offeredCount = 0;
  for (const row of allStageRows) {
    const idx = STAGE_ORDER.indexOf(row.stage);
    if (idx < 0) continue;
    const count = parseInt(row.count);
    if (idx >= FIRST_INTERVIEW_IDX) interviewedCount += count;
    if (idx >= FIRST_OFFER_IDX) offeredCount += count;
  }
  const interviewToOfferRatio = interviewedCount > 0 ? round1((offeredCount / interviewedCount) * 100) : null;

  // Turnaround time per stage, sorted slowest-first — "where is time being
  // wasted" is directly the top of this list. Filtered to the current
  // canonical stage list — activity_log can carry 'Stage Changed' rows
  // naming stages retired in an earlier rework (e.g. 'Screening Call'),
  // which would otherwise show up as a stage nobody can currently be in.
  const tatByStage = tatByStageRows
    .filter(r => STAGE_ORDER.includes(r.stage))
    .map(r => ({ stage: r.stage, avg_hours: round1(Number(r.avg_hours)), n: parseInt(r.n) }))
    .sort((a, b) => b.avg_hours - a.avg_hours);

  // Biggest drop-off — the single stage with the most rejections, already
  // computed above for the funnel subtext; surfaced here as one clear
  // callout rather than making the caller scan the whole map.
  // rejectedByStage is now dense (every stage present, many at 0) since it's
  // derived from the funnel map above — filter out zero-count stages first
  // so this stays null when there are truly no rejections anywhere, same as
  // when rejectedByStage used to be a sparse, rejections-only map.
  const biggestDropOff = Object.entries(rejectedByStage).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];

  res.json({
    metrics: {
      open_roles_count:       openRolesCount,
      open_roles_by_priority: openRolesByPriority,
      active_candidates:      activeCandidates,
      strong_fit_candidates:  candBuckets.strong_fit,
      sla_breaches:           parseInt(slaBreaches?.count || '0'),
      total_pending_actions:  totalPendingActions,
      red_aging_roles:        redAlertRoles,
      founder_review_pending: pendingActions.filter(pa => pa.action_type === 'Founder Review').length,
      joining_risk_count:     joiningRisk.length,
    },
    pending_actions_by_owner: pendingByOwner,
    aging_roles:   rolesWithAging.filter(r => r.aging_alert !== 'ok'),
    low_pipeline:  lowPipelineRoles,
    roles_by_status: rolesByStatus,
    source_quality:     sourceQuality,
    time_to_fill:       timeToFill,
    hiring_funnel: hiringFunnel,
    rejected_by_stage: rejectedByStageSparse,
    velocity: {
      interview_to_offer_ratio: interviewToOfferRatio,
      interviewed_count: interviewedCount,
      offered_count: offeredCount,
      tat_by_stage: tatByStage,
      biggest_drop_off: biggestDropOff ? { stage: biggestDropOff[0], count: biggestDropOff[1] } : null,
    },
    joining_risk:  joiningRisk,
  });
});

// ─── GET /api/dashboard/pending — just the pending actions queue ──────────────
router.get('/pending', async (req: Request, res: Response) => {
  const persona = req.user!.persona;
  let ownerFilter = '';
  const params: unknown[] = [];

  // Each persona only sees their own queue by default. Hiring managers are
  // further scoped to responsible_person matching their own name — owner_type
  // alone only isolates the HM queue as a whole, not which specific HM each
  // row belongs to, which previously showed every HM every other HM's items.
  if (persona === 'hiring_manager') {
    ownerFilter = `AND owner_type='Hiring Manager' AND lower(trim(responsible_person))=lower(trim($1))`;
    params.push(req.user!.name);
  }
  if (persona === 'interviewer')    ownerFilter = `AND owner_type='Interviewer'`;
  if (persona === 'leadership')     ownerFilter = `AND owner_type='Leadership / Founders'`;

  const actions = await query(
    `SELECT * FROM pending_actions WHERE resolved=false ${ownerFilter}
     ORDER BY priority_level DESC, created_at ASC LIMIT 100`,
    params
  );
  res.json({ actions });
});

export default router;
