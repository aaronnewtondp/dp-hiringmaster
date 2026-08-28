import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { Priority } from '../types/index.js';
import { runSlaCheck, STAGE_SLA_ACTION_TYPES } from '../jobs/slaChecker.js';
import { parseRoleFilters, buildRoleFilterSql, roleIdsSubquery } from '../utils/roleFilters.js';
import { computeAging } from '../utils/aging.js';

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

// Source Quality's Pass Rate / Hire Rate stage sets (KPI redesign) — derived
// from STAGE_ORDER rather than hardcoded stage-name lists, so a future
// change to the canonical stage order can't silently desync these from the
// rest of the file's own index-based comparisons above.
const SHORTLISTED_PLUS_STAGES = STAGE_ORDER.slice(STAGE_ORDER.indexOf('Shortlisted'));
const OFFER_ACCEPTED_PLUS_STAGES = STAGE_ORDER.slice(STAGE_ORDER.indexOf('Offer Accepted'));

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

  // Hiring Funnel Snapshot's own owner filter — independent of the master
  // role filters above, scopes just the SLA-breach query/section below.
  const ownerParam = typeof req.query.owner === 'string' &&
    (req.query.owner === 'HR / Recruiter' || req.query.owner === 'Hiring Manager')
    ? req.query.owner : undefined;

  // Run all aggregate queries in parallel
  const [
    roleStats, candidateStats, activeCandidatesByStage, rolesFilledRow, unmatchedCountRow,
    slaBreachRows, founderReviewCount,
    agingRoles, funnelRows, joiningRisk,
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

    // Candidate stats — single-row aggregate (KPI redesign): total Active
    // count plus the two score thresholds the new Active Candidates card
    // needs. Superseded the old strong_fit/review/low/unscored bucket
    // shape — nothing besides the old KPI subtitle ever read the
    // review/low/unscored buckets, and strong_fit is replaced outright by
    // the new score_ge_75/score_le_45 pair.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return queryOne<{ total: string; score_ge_75: string; score_le_45: string }>(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ai_fit_score >= 75) AS score_ge_75,
          COUNT(*) FILTER (WHERE ai_fit_score <= 45) AS score_le_45
        FROM applications
        WHERE status = 'Active'
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
      `, scoped?.params || []);
    })(),

    // Active candidates by current stage (KPI redesign) — mirrors the
    // existing allStageRows velocity query below but Active-only, feeding
    // "candidates at >= Interview Round 1 stage" (current position, not a
    // historical "ever reached" — matches the metric's own present-tense
    // wording).
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return query<{ stage: string; count: string }>(`
        SELECT stage, COUNT(*) as count
        FROM applications
        WHERE status = 'Active'
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY stage
      `, scoped?.params || []);
    })(),

    // Roles filled in the last 30 days (KPI redesign) — mined from the same
    // activity_log status-change trail roles.ts's PATCH already writes on
    // every transition (the tat_by_stage query below already mines this
    // same table for a different event type), so no schema change needed.
    (() => {
      const f = buildRoleFilterSql(filters, 1);
      return queryOne<{ count: string }>(`
        SELECT COUNT(DISTINCT al.role_id) as count
        FROM activity_log al
        JOIN roles r ON r.id = al.role_id
        WHERE al.event_type = 'Status Changed' AND al.new_value = 'Closed – Filled'
          AND al.created_at >= NOW() - INTERVAL '30 days'
        ${f.sql}
      `, f.params);
    })(),

    // Unmatched candidates (KPI redesign) — reuses candidates.ts's
    // /unmatched-role-submissions CTE verbatim (COUNT-only): a Job
    // Application Form submission whose role text never matched a role,
    // dropped the moment a real application resolves it. Not scoped by the
    // master role filters — these candidates have no role_id by definition.
    queryOne<{ count: string }>(`
      WITH latest AS (
        SELECT DISTINCT ON (al.candidate_id, al.event_detail)
          al.candidate_id, al.event_detail AS submitted_text,
          (SELECT r.id FROM roles r
             WHERE lower(regexp_replace(translate(trim(r.title), '–—', '--'), '\\s+', ' ', 'g'))
                 = lower(regexp_replace(translate(trim(al.event_detail), '–—', '--'), '\\s+', ' ', 'g'))
               AND r.status NOT IN ('Closed – Filled', 'Closed – Cancelled')
             LIMIT 1) AS suggested_role_id
        FROM activity_log al
        WHERE al.event_type = 'Unmatched Role — Manual Reconciliation'
        ORDER BY al.candidate_id, al.event_detail, al.created_at DESC
      )
      SELECT COUNT(*) as count FROM latest l
      WHERE NOT EXISTS (
        SELECT 1 FROM applications a2 WHERE a2.candidate_id = l.candidate_id AND a2.role_id = l.suggested_role_id
      )
    `),

    // SLA breach rows — every unresolved pending_actions row produced by the
    // stage-driven breach engine (slaChecker.ts's STAGE_SLA_ACTION_TYPES),
    // joined to its application for current stage/candidate id. Feeds BOTH
    // the merged KPI card (sla_breach_total/by_owner) and the
    // hiring_funnel_snapshot drill-down below, so the two numbers can never
    // disagree. The section-local owner filter (ownerParam) scopes this
    // query only — it's independent of the page's master role filters.
    (() => {
      const scoped = roleIdsSubquery(filters, 2);
      const params: unknown[] = [STAGE_SLA_ACTION_TYPES, ...(scoped?.params || [])];
      let ownerSql = '';
      if (ownerParam) {
        params.push(ownerParam);
        ownerSql = ` AND pa.owner_type = $${params.length}`;
      }
      return query<{ id: number; action_type: string; owner_type: string; hours_overdue: number;
               application_id: string; candidate_name: string; role_title: string;
               pa_role_id: string | null; current_stage: string | null; candidate_id: string | null;
               responsible_person: string | null }>(`
        SELECT pa.id, pa.action_type, pa.owner_type, pa.hours_overdue, pa.application_id,
               pa.candidate_name, pa.role_title, pa.role_id AS pa_role_id,
               a.stage AS current_stage, a.candidate_id AS candidate_id, pa.responsible_person
        FROM pending_actions pa
        LEFT JOIN applications a ON a.id = pa.application_id
        WHERE pa.resolved=false AND pa.action_type = ANY($1::text[])
          ${scoped ? ` AND COALESCE(a.role_id, pa.role_id) IN ${scoped.sql}` : ''}
          ${ownerSql}
        ORDER BY pa.hours_overdue DESC
      `, params);
    })(),

    // Founder Review pending count — a separate, untouched mechanism (not
    // stage-driven), scoped by the same master role filters for consistency.
    (() => {
      const scoped = roleIdsSubquery(filters, 1);
      return queryOne<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM pending_actions pa
        LEFT JOIN applications a ON a.id = pa.application_id
        WHERE pa.resolved=false AND pa.action_type='Founder Review'
          ${scoped ? ` AND COALESCE(a.role_id, pa.role_id) IN ${scoped.sql}` : ''}
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

    // Source Quality (Phase 2, PRD §18; redefined for the KPI redesign) —
    // pass rate = reached Shortlisted stage or higher, hire rate = reached
    // Offer Accepted stage or higher (both derived from STAGE_ORDER rather
    // than a hardcoded single-stage check, so "or higher" is exact).
    // Computed over full history, not status='Active' only — a lagging
    // quality measure, not a live-state snapshot: restricting to Active
    // would make hire_rate collapse toward 0% for every channel, since a
    // hired candidate's status is 'Joined', not 'Active'.
    (() => {
      const scoped = roleIdsSubquery(filters, 3);
      return query<{ source_channel: string; n: string; engaged: string; hired: string }>(`
        SELECT source_channel,
               COUNT(*) AS n,
               COUNT(*) FILTER (WHERE stage = ANY($1::text[])) AS engaged,
               COUNT(*) FILTER (WHERE stage = ANY($2::text[])) AS hired
        FROM applications
        WHERE source_channel IS NOT NULL AND source_channel <> ''
        ${scoped ? ` AND role_id IN ${scoped.sql}` : ''}
        GROUP BY source_channel ORDER BY n DESC
      `, [SHORTLISTED_PLUS_STAGES, OFFER_ACCEPTED_PLUS_STAGES, ...(scoped?.params || [])]);
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

  const activeCandidates = parseInt(candidateStats?.total || '0');
  const candidatesScoreGe75 = parseInt(candidateStats?.score_ge_75 || '0');
  const candidatesScoreLe45 = parseInt(candidateStats?.score_le_45 || '0');

  // Active candidates currently at Interview Round 1 or later — current
  // stage position (frozen only on rejection, and this is Active-only
  // anyway), matching the metric's own present-tense "candidates AT" wording.
  let candidatesAtInterview1Plus = 0;
  for (const row of activeCandidatesByStage) {
    if (STAGE_ORDER.indexOf(row.stage) >= FIRST_INTERVIEW_IDX) candidatesAtInterview1Plus += parseInt(row.count);
  }

  const rolesFilledLast30d = parseInt(rolesFilledRow?.count || '0');
  const candidatesUnmatched = parseInt(unmatchedCountRow?.count || '0');

  // ── Compute aging for each role ─────────────────────────────────────────────
  const rolesWithAging = agingRoles.map(r => {
    const { days_open, days_overdue, aging_alert } = computeAging(
      r.start_date || null, r.target_closure_date || null, r.priority as Priority
    );
    return { ...r, days_open, days_overdue, aging_alert, active_count: parseInt(r.active_count || '0') };
  });

  const redAlertRoles   = rolesWithAging.filter(r => r.aging_alert === 'red').length;
  const lowPipelineRoles = rolesWithAging.filter(r => r.active_count < 3 && r.aging_alert !== 'ok');

  // Average active role age (KPI redesign) — mean days_open over the same
  // "open roles" set already fetched for Aging Roles (its WHERE clause
  // already reduces to exactly Live – Sourcing/Approved/Under Review).
  // Roles with no start_date yet (not yet approved) are excluded rather
  // than counted as 0 — age isn't meaningful for them yet.
  const rolesWithRealAge = rolesWithAging.filter(r => !!r.start_date);
  const avgActiveRoleAgeDays = rolesWithRealAge.length > 0
    ? Math.round(rolesWithRealAge.reduce((sum, r) => sum + r.days_open, 0) / rolesWithRealAge.length)
    : null;

  // ── SLA breach total + by-owner (the merged KPI card) ───────────────────────
  // A Hiring Manager's KPI number is scoped to just their own queue (matching
  // the old total_pending_actions' persona-scoping) — the Hiring Funnel
  // Snapshot section below stays unscoped/company-wide regardless of
  // persona, same as the old "Pending Actions by Owner" board's columns
  // always showed everyone's items to every viewer.
  const userNameLower = req.user!.name.trim().toLowerCase();
  const kpiScopedRows = req.user!.persona === 'hiring_manager'
    ? slaBreachRows.filter(pa =>
        pa.owner_type === 'Hiring Manager' &&
        !!pa.responsible_person &&
        pa.responsible_person.trim().toLowerCase() === userNameLower
      )
    : slaBreachRows;

  const slaBreachByOwner: Record<string, number> = { 'HR / Recruiter': 0, 'Hiring Manager': 0 };
  for (const pa of kpiScopedRows) {
    slaBreachByOwner[pa.owner_type] = (slaBreachByOwner[pa.owner_type] || 0) + 1;
  }
  const slaBreachTotal = kpiScopedRows.length;

  // SLA type/stage with the highest count (KPI redesign) — derived from the
  // same kpiScopedRows array used just above, so a Hiring Manager viewer's
  // breakdown stays consistently scoped to their own queue. Ties break on
  // first-seen order (stable, since object key insertion order is
  // preserved for string keys) — an acceptable simplification for a KPI
  // subtitle, not presented as a precise ranking.
  function topByCount(rows: typeof kpiScopedRows, key: 'action_type' | 'current_stage'): { value: string; count: number } | null {
    const counts: Record<string, number> = {};
    for (const pa of rows) {
      const k = pa[key];
      if (!k) continue;
      counts[k] = (counts[k] || 0) + 1;
    }
    let best: { value: string; count: number } | null = null;
    for (const [value, count] of Object.entries(counts)) {
      if (!best || count > best.count) best = { value, count };
    }
    return best;
  }
  const topType  = topByCount(kpiScopedRows, 'action_type');
  const topStage = topByCount(kpiScopedRows, 'current_stage');

  // ── Hiring Funnel Snapshot — every canonical stage, its breach types, and
  // the candidates behind each one. Always includes all 13 stages (even
  // zero-breach ones) so the chevron strip never has to guess at a missing
  // entry; a stage's breach_types array is simply empty when nothing's
  // overdue there.
  type SnapshotCandidate = {
    application_id: string; candidate_id: string | null; candidate_name: string;
    role_id: string | null; role_title: string; owner: string; stage: string; overdue_hours: number;
  };
  const snapshotByStage: Record<string, Record<string, SnapshotCandidate[]>> = {};
  for (const stage of STAGE_ORDER) snapshotByStage[stage] = {};
  for (const pa of slaBreachRows) {
    const stage = pa.current_stage || 'Unknown';
    if (!snapshotByStage[stage]) snapshotByStage[stage] = {};
    if (!snapshotByStage[stage][pa.action_type]) snapshotByStage[stage][pa.action_type] = [];
    snapshotByStage[stage][pa.action_type].push({
      application_id: pa.application_id,
      candidate_id: pa.candidate_id,
      candidate_name: pa.candidate_name,
      role_id: pa.pa_role_id,
      role_title: pa.role_title,
      owner: pa.owner_type,
      stage,
      overdue_hours: pa.hours_overdue,
    });
  }
  const hiringFunnelSnapshot = STAGE_ORDER.map(stage => {
    const breachTypes = Object.entries(snapshotByStage[stage] || {}).map(([type, candidates]) => ({
      type, owner: candidates[0]?.owner || '', count: candidates.length, candidates,
    }));
    return { stage, total: breachTypes.reduce((sum, bt) => sum + bt.count, 0), breach_types: breachTypes };
  });

  // ── Source Quality — pass_rate/hire_rate/contribution_pct as 0-100, 1 decimal
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const sourceTotalN = sourceQualityRows.reduce((sum, r) => sum + parseInt(r.n), 0);
  const sourceQuality = sourceQualityRows.map(r => {
    const n = parseInt(r.n);
    return {
      source_channel: r.source_channel,
      n,
      pass_rate: n > 0 ? round1((parseInt(r.engaged) / n) * 100) : 0,
      hire_rate: n > 0 ? round1((parseInt(r.hired) / n) * 100) : 0,
      contribution_pct: sourceTotalN > 0 ? round1((n / sourceTotalN) * 100) : 0,
    };
  });

  // ── Time to Fill — weighted mean across priorities (KPI redesign: only the
  // overall figure is surfaced now, relocated into the Open Roles card; the
  // by-priority breakdown had no consumer besides the removed standalone
  // card, so it's dropped rather than kept as unused surface).
  let weightedSum = 0;
  let totalFilled = 0;
  for (const row of timeToFillRows) {
    const n = parseInt(row.n);
    const avgDays = row.avg_days != null ? Number(row.avg_days) : null;
    if (avgDays != null) {
      weightedSum += avgDays * n;
      totalFilled += n;
    }
  }
  const avgTimeToFillDays = totalFilled > 0 ? round1(weightedSum / totalFilled) : null;

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

  // Rejection RATE per stage (rejected / everyone who ever reached that
  // stage) — a separate callout from the raw-count version above, since the
  // two can point at different stages: a high-volume early stage (e.g.
  // Resume Review) racks up the most rejections in absolute terms simply by
  // funneling everyone through it, while a later stage with far fewer
  // candidates can reject a much larger share of the ones it does see.
  // Shown alongside biggest_drop_off rather than replacing it — by design
  // decision, not a bug fix.
  const biggestDropOffByRate = STAGE_ORDER
    .map(stage => {
      const b = funnelByStage[stage];
      const total = b.active + b.rejected + b.withdrawn + b.hold_for_future;
      return { stage, count: b.rejected, rate: total > 0 ? round1((b.rejected / total) * 100) : 0 };
    })
    .filter(s => s.count > 0)
    .sort((a, b) => b.rate - a.rate)[0];

  res.json({
    metrics: {
      open_roles_count:            openRolesCount,
      open_roles_by_priority:      openRolesByPriority,
      avg_active_role_age_days:    avgActiveRoleAgeDays,
      avg_time_to_fill_days:       avgTimeToFillDays,
      roles_filled_last_30d:       rolesFilledLast30d,
      active_candidates:           activeCandidates,
      candidates_score_ge_75:      candidatesScoreGe75,
      candidates_score_le_45:      candidatesScoreLe45,
      candidates_at_interview1_plus: candidatesAtInterview1Plus,
      candidates_unmatched:        candidatesUnmatched,
      sla_breach_total:            slaBreachTotal,
      sla_breach_by_owner:         slaBreachByOwner,
      sla_breach_top_type:         topType ? { type: topType.value, count: topType.count } : null,
      sla_breach_top_stage:        topStage ? { stage: topStage.value, count: topStage.count } : null,
      red_aging_roles:             redAlertRoles,
      founder_review_pending:      parseInt(founderReviewCount?.count || '0'),
      joining_risk_count:          joiningRisk.length,
    },
    hiring_funnel_snapshot: hiringFunnelSnapshot,
    aging_roles:   rolesWithAging.filter(r => r.aging_alert !== 'ok'),
    low_pipeline:  lowPipelineRoles,
    roles_by_status: rolesByStatus,
    source_quality:     sourceQuality,
    hiring_funnel: hiringFunnel,
    rejected_by_stage: rejectedByStageSparse,
    velocity: {
      interview_to_offer_ratio: interviewToOfferRatio,
      interviewed_count: interviewedCount,
      offered_count: offeredCount,
      tat_by_stage: tatByStage,
      biggest_drop_off: biggestDropOff ? { stage: biggestDropOff[0], count: biggestDropOff[1] } : null,
      biggest_drop_off_by_rate: biggestDropOffByRate || null,
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
  if (persona === 'leadership')     ownerFilter = `AND owner_type='Leadership / Founders'`;

  const actions = await query(
    `SELECT * FROM pending_actions WHERE resolved=false ${ownerFilter}
     ORDER BY priority_level DESC, created_at ASC LIMIT 100`,
    params
  );
  res.json({ actions });
});

export default router;
