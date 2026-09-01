import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR, stripRestrictedFields, isHRTier, canSeeCompForRole } from '../middleware/auth.js';
import { Application, SLA_HOURS, Candidate, Role } from '../types/index.js';
import { runResumeIQScoring } from '../services/resumeIQTrigger.js';
import { parseRoleFilters, buildRoleFilterSql, toArray } from '../utils/roleFilters.js';
import { STAGE_SLA_ACTION_TYPES } from '../jobs/slaChecker.js';
import { isSeverelyOverBudget } from '../utils/budget.js';

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function getSlaHours(stage: string, fitScore?: number | null): number {
  // Applied and Screened (renamed from plain 'Applied' 2026-09-01, see
  // STAGE_ORDER) now covers what 'Resume Review' used to (that stage was
  // retired) — same high-fit/normal threshold, just measured from
  // application creation instead of a later manual move.
  if (stage === 'Applied and Screened') {
    return (fitScore && fitScore >= 75) ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL;
  }
  if (stage === 'Reference Check') return SLA_HOURS.REF_INIT;
  if (stage === 'Offer Released') return SLA_HOURS.OFFER_RELEASE;
  // 'Founders Round' no longer matches startsWith('Interview') after the
  // rename from 'Interview – Round 3' — treated the same as a plain
  // interview round for SLA purposes.
  if (stage.startsWith('Interview') || stage === 'Founders Round') return SLA_HOURS.INTERVIEW_FEEDBACK;
  return SLA_HOURS.IDLE;
}

async function logActivity(
  client: import('pg').PoolClient,
  appId: string, candId: string, roleId: string,
  eventType: string, detail: string,
  oldVal: string | null, newVal: string | null,
  userId: string, userName: string
) {
  await client.query(
    `INSERT INTO activity_log
       (application_id, candidate_id, role_id, event_type, event_detail, old_value, new_value, performed_by, performed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [appId, candId, roleId, eventType, detail, oldVal, newVal, userId, userName]
  );
}

// ─── GET /api/applications — list with filters ────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const { stage, status, screening_status, sla_breach, founder_flag,
          exclude_stale_archived, scored_only, q, limit = '50', offset = '0' } = req.query;

  let sql = `
    SELECT a.*, c.full_name AS candidate_name, c.email, c.phone,
           c.current_ctc_fixed AS candidate_ctc_fixed,
           c.current_ctc_variable AS candidate_ctc_variable,
           c.expected_ctc AS candidate_expected_ctc,
           c.notice_period_days AS candidate_notice_period_days,
           c.current_company AS candidate_company,
           c.current_industry AS candidate_industry,
           c.resume_drive_link AS candidate_resume_link,
           r.title AS role_title, r.priority AS role_priority, r.ctc_band AS role_ctc_band,
           r.hiring_manager_name,
           ag.name AS agency_name, last_activity.event_detail AS last_activity_detail
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN roles r ON r.id = a.role_id
    LEFT JOIN agencies ag ON ag.id = a.agency_id
    LEFT JOIN LATERAL (
      SELECT event_detail FROM activity_log
      WHERE application_id = a.id
      ORDER BY created_at DESC LIMIT 1
    ) last_activity ON true
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let i = 1;

  if (stage)            { sql += ` AND a.stage = $${i++}`;                         params.push(stage); }
  const statuses = toArray(status);
  if (statuses.length) { sql += ` AND a.status = ANY($${i++})`;                     params.push(statuses); }
  if (screening_status) { sql += ` AND a.recruiter_screening_status = $${i++}`;    params.push(screening_status); }
  if (sla_breach === 'true') { sql += ` AND a.sla_breach = true`; }
  if (founder_flag === 'true') { sql += ` AND a.founder_review_flag = true`; }
  // Archival (PRD §21) — opt-in only, so every existing caller of this
  // shared endpoint is unaffected unless it explicitly starts passing this.
  // Candidates.tsx's default pipeline table always passes it; the excluded
  // rows remain reachable via the Talent Pool page's Archived mode instead
  // of being hidden with no way back.
  if (exclude_stale_archived === 'true') {
    sql += ` AND a.status NOT IN ('Rejected','Withdrawn')`;
  }
  // Scorecard Summary's "only show applications that have actually been
  // through ResumeIQ" filter — opt-in, so every existing caller is
  // unaffected.
  if (scored_only === 'true') {
    sql += ` AND a.score_avg IS NOT NULL`;
  }
  // Free-text search — matches candidates.ts's own `q` param SQL shape.
  // Candidates.tsx used to filter client-side over whatever this route's
  // flat `limit` happened to fetch, so a candidate ranked below that cutoff
  // (e.g. brand new, unscored, so sorted last) was silently unsearchable —
  // this makes search hit the full table server-side instead.
  if (q) {
    sql += ` AND (c.full_name ILIKE $${i} OR c.email ILIKE $${i} OR r.title ILIKE $${i})`;
    params.push(`%${q}%`); i++;
  }

  // Master filters (department/location/recruitment_mode/priority/role_id +
  // role_status) — shared with Dashboard/Roles via roleFilters.ts. `role_id`
  // and role-level `status` collide with this route's own pre-existing
  // `status` param (the APPLICATION's status), so the frontend sends the
  // latter under `role_status` and it's remapped here before parsing.
  const roleFilters = parseRoleFilters({ ...req.query, status: req.query.role_status });
  const { sql: roleFilterSql, params: roleFilterParams } = buildRoleFilterSql(roleFilters, i);
  sql += roleFilterSql;
  params.push(...roleFilterParams);
  i += roleFilterParams.length;

  sql += ` ORDER BY a.ai_fit_score DESC NULLS LAST, a.application_date DESC LIMIT $${i++} OFFSET $${i++}`;
  params.push(parseInt(limit as string), parseInt(offset as string));

  const apps = await query<Application>(sql, params);
  const persona = req.user!.persona;

  // is_severely_over_budget is computed here, BEFORE role_ctc_band is
  // stripped for non-HR-tier personas, and deliberately excluded from
  // RESTRICTED_FIELDS — a Hiring Manager is explicitly allowed to shortlist
  // (and is the one who has to resolve the mandatory-reason gate on
  // POST /:id/stage when it fires), so the frontend needs this yes/no
  // signal even though the actual compensation figures stay hidden from
  // them. Without it, an HM's shortlist attempt hit the backend's 400 with
  // no way to ever open the reason modal, since the frontend's own gate
  // check depended on role_ctc_band, which is exactly the field stripped
  // for their persona.
  const result = apps.map(a => {
    const row = a as unknown as Record<string, unknown> & { candidate_expected_ctc?: number; role_ctc_band?: string; hiring_manager_name?: string | null };
    const isSeverelyOver = isSeverelyOverBudget(row.candidate_expected_ctc, row.role_ctc_band);
    const canSeeComp = canSeeCompForRole(persona, req.user!.name, row.hiring_manager_name);
    return { ...stripRestrictedFields(row, persona, canSeeComp), is_severely_over_budget: isSeverelyOver };
  });
  res.json({ applications: result, count: apps.length });
});

// ─── GET /api/applications/:id ────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const app = await queryOne<Application>(
    `SELECT a.*, c.full_name AS candidate_name, c.email, c.phone, c.linkedin_url,
            c.parsed_skills, c.parsed_total_yoe, c.parsed_industries,
            c.expected_ctc AS candidate_expected_ctc,
            r.title AS role_title, r.priority AS role_priority, r.must_have_skills, r.ctc_band AS role_ctc_band,
            r.hiring_manager_name,
            ag.name AS agency_name
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     JOIN roles r ON r.id = a.role_id
     LEFT JOIN agencies ag ON ag.id = a.agency_id
     WHERE a.id = $1`,
    [req.params.id]
  );
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  const rounds = await query(
    'SELECT * FROM interview_rounds WHERE application_id = $1 ORDER BY round_number',
    [req.params.id]
  );
  const activity = await query(
    'SELECT * FROM activity_log WHERE application_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.params.id]
  );

  const persona = req.user!.persona;
  const rawApp = app as unknown as Record<string, unknown> & { candidate_expected_ctc?: number; role_ctc_band?: string; hiring_manager_name?: string | null };
  // Same reasoning as the list route above — computed before stripping,
  // never itself stripped.
  const isSeverelyOver = isSeverelyOverBudget(rawApp.candidate_expected_ctc, rawApp.role_ctc_band);
  const canSeeComp = canSeeCompForRole(persona, req.user!.name, rawApp.hiring_manager_name);
  const safeApp = { ...stripRestrictedFields(rawApp, persona, canSeeComp), is_severely_over_budget: isSeverelyOver };
  res.json({ application: safeApp, rounds, activity });
});

// ─── POST /api/applications/:id/stage — advance stage (PRD Section 9.3) ──────
router.post('/:id/stage', async (req: Request, res: Response) => {
  const { new_stage, skip_reason, budget_exception_reason_cat, budget_exception_reason_detail } = req.body;
  if (!new_stage) { res.status(400).json({ error: 'new_stage required' }); return; }

  const app = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  // A candidate 15%+ over the role's stated CTC band needs an explicit,
  // on-record reason before they can be shortlisted — enforced here (not
  // just the frontend gate) since this is the only place every shortlist
  // path (single-row, bulk, either page) actually goes through. "Shortlist"
  // now means advancing straight to Interview Round 1 (the old intermediate
  // 'Shortlisted' stage was retired — see STAGE_ORDER).
  if (new_stage === 'Interview Round 1') {
    const candidate = await queryOne<{ expected_ctc: number }>('SELECT expected_ctc FROM candidates WHERE id=$1', [app.candidate_id]);
    const role      = await queryOne<{ ctc_band: string }>('SELECT ctc_band FROM roles WHERE id=$1', [app.role_id]);
    if (isSeverelyOverBudget(candidate?.expected_ctc, role?.ctc_band) && !budget_exception_reason_cat) {
      res.status(400).json({ error: "This candidate's expected CTC is 15%+ over the role's band — select a reason before shortlisting." });
      return;
    }
  }

  // HR-tier can advance to any stage. Everyone else may only make the one
  // transition the simplified HM-shortlist workflow depends on — Applied
  // and Screened straight to Interview Round 1 — from Scorecard Summary/
  // My Tasks' "Shortlist" action, which is deliberately open to every persona.
  const canShortlistFromApplied = app.stage === 'Applied and Screened' && new_stage === 'Interview Round 1';
  if (!isHRTier(req.user!.persona) && !canShortlistFromApplied) {
    res.status(403).json({ error: 'HR access required' });
    return;
  }

  // Every scheduled interview/assignment round must have feedback submitted
  // before advancing further — skip_reason is the existing, deliberate
  // escape hatch for genuinely bypassing normal flow (already logged below).
  if (!skip_reason) {
    const pendingRounds = await query<{ round_name: string }>(
      `SELECT round_name FROM interview_rounds WHERE application_id=$1 AND feedback_status != 'Submitted'`,
      [req.params.id]
    );
    if (pendingRounds.length > 0) {
      res.status(400).json({
        error: `Feedback is still pending for: ${pendingRounds.map(r => r.round_name).join(', ')}. Submit feedback for these rounds before advancing this candidate.`,
      });
      return;
    }
  }

  // Leaving Reference Check requires at least one reference check on file.
  if (!skip_reason && app.stage === 'Reference Check' && new_stage !== 'Reference Check') {
    const refCount = await queryOne<{ count: string }>(
      'SELECT count(*) FROM ref_checks WHERE application_id=$1', [req.params.id]
    );
    if (!refCount || parseInt(refCount.count, 10) === 0) {
      res.status(400).json({ error: 'Add at least one reference check before advancing this candidate.' });
      return;
    }
  }

  const slaHours = getSlaHours(new_stage, app.ai_fit_score);

  // Dashboard's Time to Fill is a literal AVG(offer_accepted_date -
  // role.start_date) — nothing ever stamped this column on the stage
  // transition itself, so every accepted offer silently had a NULL date and
  // never contributed to the metric despite the stage genuinely being
  // 'Offer Accepted'. Same gap existed for 'Offer Released' → offer_sent_date.
  // Also stamped on a direct jump to 'Joined' (skip_reason bypasses the
  // normal Offer Accepted step entirely) — COALESCE so a real, earlier
  // Offer Accepted date from a non-skipped progression is never overwritten.
  let offerDateSql = '';
  if (new_stage === 'Offer Released') offerDateSql = ', offer_sent_date=NOW()';
  if (new_stage === 'Offer Accepted') offerDateSql = ', offer_accepted_date=NOW()';
  if (new_stage === 'Joined') offerDateSql = ', offer_accepted_date=COALESCE(offer_accepted_date, NOW())';

  // status is a separate field from stage (see CLAUDE.md's application state
  // model) and nothing else ever sets it to 'Joined' — every dashboard
  // metric that filters WHERE status='Active' (active_candidates,
  // strong_fit_candidates, hiring_funnel, sla_breaches) was therefore
  // permanently counting every actual hire as if still an open pipeline
  // case, forever, with no way for that to self-correct.
  const statusSql = new_stage === 'Joined' ? `, status='Joined'` : '';

  await transaction(async (client) => {
    await client.query(
      `UPDATE applications SET stage=$1, stage_entry_time=NOW(), sla_hours=$2,
       sla_breach=false, last_updated=NOW()${offerDateSql}${statusSql},
       budget_exception_reason_cat=COALESCE($4, budget_exception_reason_cat),
       budget_exception_reason_detail=COALESCE($5, budget_exception_reason_detail)
       WHERE id=$3`,
      [new_stage, slaHours, req.params.id, budget_exception_reason_cat || null, budget_exception_reason_detail || null]
    );
    // A stage-SLA pending_action (Resume to triage, Interview feedback due,
    // etc.) is only ever valid for the stage it was raised against — once the
    // stage moves on, resolve it here rather than leaving it to slaChecker's
    // own recovery check, which can't detect this: by the time it next runs,
    // sla_breach is already false and stage_entry_time already reset, so it
    // has no "was breached, now isn't" transition left to see.
    await client.query(
      `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
       WHERE application_id=$1 AND resolved=false AND action_type = ANY($2::text[])`,
      [req.params.id, STAGE_SLA_ACTION_TYPES]
    );
    await logActivity(client, app.id, app.candidate_id, app.role_id,
      'Stage Changed',
      skip_reason ? `Stage skipped to ${new_stage}. Reason: ${skip_reason}`
        : budget_exception_reason_cat ? `Stage → ${new_stage} (over-budget exception: ${budget_exception_reason_cat})`
        : `Stage → ${new_stage}`,
      app.stage, new_stage, req.user!.userId, req.user!.name
    );
  });

  // Defensive fallback only — every application is scored synchronously the
  // moment it's created now (candidates.ts / candidateIngest.ts both call
  // runResumeIQScoring() inline on creation), so this should normally be a
  // no-op (score_avg already set). Kept here in case an application somehow
  // reached this route unscored (e.g. pre-existing data from before this
  // change), so advancing it still triggers scoring rather than silently
  // leaving it unscored forever.
  let resumeiq: { scored: boolean; error?: string } | undefined;
  if (!app.score_avg) {
    resumeiq = await runResumeIQScoring(app.id);
  }

  // If shortlisting (Applied and Screened → Interview Round 1), create a
  // pending action for the HM — same event this used to fire on reaching
  // the old intermediate 'Shortlisted' stage, just retargeted to the new
  // direct transition.
  if (app.stage === 'Applied and Screened' && new_stage === 'Interview Round 1') {
    const role = await queryOne<{ title: string; hiring_manager_name: string }>(
      'SELECT title, hiring_manager_name FROM roles WHERE id = $1', [app.role_id]
    );
    const cand = await queryOne<{ full_name: string }>(
      'SELECT full_name FROM candidates WHERE id = $1', [app.candidate_id]
    );
    await queryOne(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person)
       VALUES ('Hiring Manager', 'High', 'HM shortlist review', $1, $2, $3, $4, 0, $5, $6)`,
      [
        `Review ${cand?.full_name} for ${role?.title} — HM shortlist decision needed`,
        app.id, cand?.full_name, role?.title, app.role_id, role?.hiring_manager_name,
      ]
    );
  }

  // This response used to return the raw, fully-unstripped row — internal_
  // risk_notes/agency_fee_estimate/offer_ctc_fixed/offer_ctc_variable/
  // hr_comp_alignment (and, before today, candidate/application CTC fields
  // too) went out over the wire regardless of persona. Reachable by any
  // persona via the Shortlist-from-Resume-Review carve-out above, so this
  // was a real leak, not just an HR-only code path that happened to be safe.
  const updatedRaw = await queryOne<Application & { hiring_manager_name?: string | null }>(
    `SELECT a.*, r.hiring_manager_name FROM applications a JOIN roles r ON r.id = a.role_id WHERE a.id = $1`,
    [req.params.id]
  );
  const canSeeComp = canSeeCompForRole(req.user!.persona, req.user!.name, updatedRaw?.hiring_manager_name);
  const updated = updatedRaw
    ? stripRestrictedFields(updatedRaw as unknown as Record<string, unknown>, req.user!.persona, canSeeComp)
    : updatedRaw;
  res.json({ application: updated, resumeiq });
});

// ─── POST /api/applications/:id/status — change status (Reject/Withdraw/Hold)
// PRD Section 9.1: status changes are SEPARATE from stage
router.post('/:id/status', async (req: Request, res: Response) => {
  const { new_status, rejection_reason_cat, rejection_reason_detail,
          withdrawal_reason_cat, withdrawal_reason_detail } = req.body;

  if (!new_status) { res.status(400).json({ error: 'new_status required' }); return; }

  const app = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  // HR-tier can set any status. Everyone else may only set the two values
  // the simplified HM workflow depends on — Hold for Future / Rejected —
  // and only from Applied and Screened, matching the Shortlist carve-out above.
  const canActFromApplied = app.stage === 'Applied and Screened' &&
    (new_status === 'Hold for Future' || new_status === 'Rejected');
  if (!isHRTier(req.user!.persona) && !canActFromApplied) {
    res.status(403).json({ error: 'HR access required' });
    return;
  }

  // Rejection and withdrawal require a reason
  if ((new_status === 'Rejected' || new_status === 'Withdrawn') && !rejection_reason_cat && !withdrawal_reason_cat) {
    res.status(400).json({ error: 'A reason is required when rejecting or withdrawing a candidate' });
    return;
  }

  // Same write-once problem as pending_actions: joining_risk_auto_flag is
  // only ever set true, never reset — a candidate who accepted an offer,
  // got auto-flagged at-risk, and then withdrew/was rejected would stay
  // flagged (and stuck in the Joining Risk dashboard list) forever, since
  // there was no path back to false once status moved off 'Active'.
  const clearJoiningRisk = new_status !== 'Active' ? `, joining_risk_auto_flag = false` : '';

  await transaction(async (client) => {
    await client.query(
      `UPDATE applications SET status=$1,
       rejection_reason_cat=$2, rejection_reason_detail=$3,
       withdrawal_reason_cat=$4, withdrawal_reason_detail=$5,
       last_updated=NOW()${clearJoiningRisk} WHERE id=$6`,
      [new_status, rejection_reason_cat || null, rejection_reason_detail || null,
       withdrawal_reason_cat || null, withdrawal_reason_detail || null, req.params.id]
    );
    await logActivity(client, app.id, app.candidate_id, app.role_id,
      'Status Changed',
      `Status → ${new_status}${rejection_reason_cat ? ` (${rejection_reason_cat})` : ''}`,
      app.status, new_status, req.user!.userId, req.user!.name
    );
    // Resolve any open SLA breach for this application
    await client.query(
      `UPDATE pending_actions SET resolved=true, resolved_at=NOW() WHERE application_id=$1 AND resolved=false`,
      [req.params.id]
    );
  });

  res.json({ success: true, new_status });
});

// ─── POST /api/applications/:id/screening — update recruiter screening status ──
router.post('/:id/screening', async (req: Request, res: Response) => {
  const { new_screening_status } = req.body;
  if (!new_screening_status) { res.status(400).json({ error: 'new_screening_status required' }); return; }

  const app = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  // HR-tier can set any screening status; a Hiring Manager can set only the
  // one transition they own (HM Shortlisted); everyone else (interviewer)
  // can set none. Previously only the HM Shortlisted value was gated at
  // all — every other value was silently open to any persona.
  const isHMShortlistByHM = new_screening_status === 'HM Shortlisted' && req.user!.persona === 'hiring_manager';
  if (!isHRTier(req.user!.persona) && !isHMShortlistByHM) {
    res.status(403).json({ error: 'Only HR/Leadership can set this screening status.' });
    return;
  }

  await transaction(async (client) => {
    await client.query(
      'UPDATE applications SET recruiter_screening_status=$1, last_updated=NOW() WHERE id=$2',
      [new_screening_status, req.params.id]
    );
    await logActivity(client, app.id, app.candidate_id, app.role_id,
      'Recruiter Screening Status Changed', `Screening → ${new_screening_status}`,
      app.recruiter_screening_status, new_screening_status, req.user!.userId, req.user!.name
    );
    // If HM Shortlisted, resolve HM pending action and create HR schedule action
    if (new_screening_status === 'HM Shortlisted') {
      await client.query(
        `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
         WHERE application_id=$1 AND action_type='HM shortlist review' AND resolved=false`,
        [req.params.id]
      );
      const cand = await client.query('SELECT full_name FROM candidates WHERE id=$1', [app.candidate_id]);
      const role = await client.query('SELECT title FROM roles WHERE id=$1', [app.role_id]);
      await client.query(
        `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
         VALUES ('HR / Recruiter','High','Schedule interview','Schedule Round 1 for '||$2||' applying for '||$3,$1,$2,$3,0)`,
        [req.params.id, cand.rows[0]?.full_name, role.rows[0]?.title]
      );
    }
  });

  res.json({ success: true, new_screening_status });
});

// ─── PATCH /api/applications/:id/notes — update HR screening notes ────────────
router.patch('/:id/notes', requireHR, async (req: Request, res: Response) => {
  const allowed = ['hr_recruiter_summary','hr_key_positives','hr_key_concerns',
    'hr_comp_alignment','hr_communication_assessment','internal_risk_notes',
    'hr_priority_override','hr_priority_override_reason','hr_tags',
    'resume_drive_link','joining_confidence','last_hr_contact','joining_risk_notes',
    'next_action','next_action_owner','preferred_location'];

  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${i++}`);
      values.push(req.body[field]);
    }
  }
  if (!updates.length) { res.status(400).json({ error: 'No valid fields' }); return; }

  // joining_risk_auto_flag is otherwise write-once (only ever set true, by
  // slaChecker.ts's checkJoiningRisk) — logging fresh HR contact here is the
  // one real signal that the risk this flag represents has been addressed,
  // so it's the one place that resets it back to false. Without this, a
  // flagged application stayed flagged forever regardless of any later
  // follow-up, permanently stuck in the dashboard's Joining Risk list.
  const resetAutoFlag = req.body.last_hr_contact !== undefined ? `, joining_risk_auto_flag = false` : '';

  values.push(req.params.id);
  await queryOne(
    `UPDATE applications SET ${updates.join(', ')}, last_updated=NOW()${resetAutoFlag} WHERE id=$${i}`,
    values
  );

  // Log if priority override was set
  if (req.body.hr_priority_override) {
    const app = await queryOne<Application>('SELECT candidate_id, role_id FROM applications WHERE id=$1', [req.params.id]);
    await transaction(async (client) => {
      await logActivity(client, req.params.id, app!.candidate_id, app!.role_id,
        'Priority Override Set', `HR Priority → ${req.body.hr_priority_override}: ${req.body.hr_priority_override_reason || ''}`,
        null, req.body.hr_priority_override, req.user!.userId, req.user!.name
      );
    });
  }

  res.json({ success: true });
});

// ─── POST /api/applications/:id/founder-flag — set/clear founder review ──────
router.post('/:id/founder-flag', async (req: Request, res: Response) => {
  if (!isHRTier(req.user!.persona)) {
    res.status(403).json({ error: 'Only HR or Leadership can set the Founder Review flag' });
    return;
  }

  const { set, note } = req.body;
  const app = await queryOne<Application>('SELECT * FROM applications WHERE id=$1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Not found' }); return; }

  await transaction(async (client) => {
    await client.query(
      `UPDATE applications SET founder_review_flag=$1, founder_review_note=$2,
       founder_review_set_by=$3, founder_review_set_at=NOW(), last_updated=NOW() WHERE id=$4`,
      [set === true, note || null, req.user!.userId, req.params.id]
    );
    await logActivity(client, app.id, app.candidate_id, app.role_id,
      set ? 'Founder Review Flag Set' : 'Founder Review Flag Cleared',
      note || '', null, set ? 'true' : 'false', req.user!.userId, req.user!.name
    );
    if (set) {
      const cand = await client.query('SELECT full_name FROM candidates WHERE id=$1', [app.candidate_id]);
      const role = await client.query('SELECT title FROM roles WHERE id=$1', [app.role_id]);
      await client.query(
        `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
         VALUES ('Leadership / Founders','High','Founder Review',
         'Review flagged candidate '||$2||' for '||$3,$1,$2,$3,0)`,
        [app.id, cand.rows[0]?.full_name, role.rows[0]?.title]
      );
    } else {
      await client.query(
        `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
         WHERE application_id=$1 AND action_type='Founder Review' AND resolved=false`,
        [app.id]
      );
    }
  });

  res.json({ success: true });
});

// ─── POST /api/applications/:id/retry-scoring — manually retry ResumeIQ ──────
// Safety net for the case where the synchronous scoring call at
// application-creation time (candidates.ts / candidateIngest.ts) threw or
// was cut off mid-call (e.g. a Vercel function timeout) and left the
// application permanently unscored with no record of the attempt anywhere —
// runResumeIQScoring() only writes an activity_log entry on SUCCESS, so a
// failed attempt is otherwise invisible. HR-tier only, matching the other
// maintenance-style actions in this file. Idempotent — runResumeIQScoring
// itself no-ops if score_avg is already set.
router.post('/:id/retry-scoring', requireHR, async (req: Request, res: Response) => {
  const app = await queryOne<Application>('SELECT id, score_avg FROM applications WHERE id=$1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }
  const resumeiq = await runResumeIQScoring(app.id);
  res.json({ resumeiq });
});

export default router;
