import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR, stripRestrictedFields } from '../middleware/auth.js';
import { Application, SLA_HOURS, Candidate, Role } from '../types/index.js';
import { scoreCandidate } from '../services/resumeIQ.js';
import { fetchResumeText } from '../services/driveService.js';

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSlaHours(stage: string, fitScore?: number | null): number {
  if (stage === 'Resume Review') {
    return (fitScore && fitScore >= 75) ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL;
  }
  if (stage === 'Shortlisted') return SLA_HOURS.HM_SHORTLIST;
  if (stage === 'Final Evaluation') return SLA_HOURS.FINAL_EVAL;
  if (stage === 'Reference Check') return SLA_HOURS.REF_INIT;
  if (stage === 'Offer Released') return SLA_HOURS.OFFER_RELEASE;
  if (stage.startsWith('Interview')) return SLA_HOURS.INTERVIEW_FEEDBACK;
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
  const { role_id, stage, status, screening_status, sla_breach, founder_flag,
          limit = '50', offset = '0' } = req.query;

  let sql = `
    SELECT a.*, c.full_name AS candidate_name, c.email, c.phone,
           c.current_ctc_fixed AS candidate_ctc_fixed,
           c.current_ctc_variable AS candidate_ctc_variable,
           c.expected_ctc AS candidate_expected_ctc,
           c.notice_period_days AS candidate_notice_period_days,
           r.title AS role_title, r.priority AS role_priority,
           ag.name AS agency_name
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN roles r ON r.id = a.role_id
    LEFT JOIN agencies ag ON ag.id = a.agency_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let i = 1;

  if (role_id)          { sql += ` AND a.role_id = $${i++}`;                       params.push(role_id); }
  if (stage)            { sql += ` AND a.stage = $${i++}`;                         params.push(stage); }
  if (status)           { sql += ` AND a.status = $${i++}`;                        params.push(status); }
  if (screening_status) { sql += ` AND a.recruiter_screening_status = $${i++}`;    params.push(screening_status); }
  if (sla_breach === 'true') { sql += ` AND a.sla_breach = true`; }
  if (founder_flag === 'true') { sql += ` AND a.founder_review_flag = true`; }

  sql += ` ORDER BY a.ai_fit_score DESC NULLS LAST, a.application_date DESC LIMIT $${i++} OFFSET $${i++}`;
  params.push(parseInt(limit as string), parseInt(offset as string));

  const apps = await query<Application>(sql, params);
  const persona = req.user!.persona;

  const result = apps.map(a => stripRestrictedFields(a as Record<string, unknown>, persona));
  res.json({ applications: result, count: apps.length });
});

// ─── GET /api/applications/:id ────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const app = await queryOne<Application>(
    `SELECT a.*, c.full_name AS candidate_name, c.email, c.phone, c.linkedin_url,
            c.parsed_skills, c.parsed_total_yoe, c.parsed_industries,
            r.title AS role_title, r.priority AS role_priority, r.must_have_skills,
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
  const safeApp = stripRestrictedFields(app as Record<string, unknown>, persona);
  res.json({ application: safeApp, rounds, activity });
});

// ─── POST /api/applications/:id/stage — advance stage (PRD Section 9.3) ──────
router.post('/:id/stage', requireHR, async (req: Request, res: Response) => {
  const { new_stage, skip_reason } = req.body;
  if (!new_stage) { res.status(400).json({ error: 'new_stage required' }); return; }

  const app = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  const slaHours = getSlaHours(new_stage, app.ai_fit_score);

  await transaction(async (client) => {
    await client.query(
      `UPDATE applications SET stage=$1, stage_entry_time=NOW(), sla_hours=$2,
       sla_breach=false, last_updated=NOW() WHERE id=$3`,
      [new_stage, slaHours, req.params.id]
    );
    await logActivity(client, app.id, app.candidate_id, app.role_id,
      'Stage Changed',
      skip_reason ? `Stage skipped to ${new_stage}. Reason: ${skip_reason}` : `Stage → ${new_stage}`,
      app.stage, new_stage, req.user!.userId, req.user!.name
    );
  });

  // Trigger ResumeIQ when entering Resume Review — async, non-blocking
  if (new_stage === 'Resume Review' && !app.score_avg) {
    setImmediate(async () => {
      try {
        const candidate = await queryOne<Candidate>('SELECT * FROM candidates WHERE id=$1', [app.candidate_id]);
        const role      = await queryOne<Role>('SELECT * FROM roles WHERE id=$1', [app.role_id]);
        if (!candidate || !role) return;

        // Fetch actual resume text from Drive if a link is on file.
        // Falls back gracefully to profile-fields-only scoring on any failure.
        let resumeText: string | null = null;
        if (candidate.resume_drive_link) {
          resumeText = await fetchResumeText(candidate.resume_drive_link);
          if (resumeText) {
            console.log(`[ResumeIQ] Resume text fetched for ${candidate.id} (${resumeText.length} chars)`);
          } else {
            console.warn(`[ResumeIQ] Could not fetch resume for ${candidate.id} — scoring from profile fields only`);
          }
        }

        const result = await scoreCandidate(candidate, role, resumeText);
        await query(
          `UPDATE applications SET
             score_technical=$1, score_technical_note=$2,
             score_experience=$3, score_experience_note=$4,
             score_industry_fit=$5, score_industry_fit_note=$6,
             score_culture_fit=$7, score_culture_fit_note=$8,
             score_role_alignment=$9, score_role_alignment_note=$10,
             score_trajectory=$11, score_trajectory_note=$12,
             score_leadership=$13, score_leadership_note=$14,
             score_communication=$15, score_communication_note=$16,
             score_avg=$17, score_strengths=$18, score_red_flags=$19,
             score_summary=$20, score_recommendation=$21, score_resume_read=$22,
             score_computed_at=NOW()
           WHERE id=$23`,
          [
            result.technical.score, result.technical.note,
            result.experience.score, result.experience.note,
            result.industryFit.score, result.industryFit.note,
            result.cultureFit.score, result.cultureFit.note,
            result.roleAlignment.score, result.roleAlignment.note,
            result.trajectory.score, result.trajectory.note,
            result.leadership.score, result.leadership.note,
            result.communication.score, result.communication.note,
            result.avgScore, result.strengths, result.redFlags,
            result.summary, result.recommendation, result.resumeRead,
            app.id,
          ]
        );
        // Update SLA now we know the fit score (avgScore is out of 10)
        const refinedSla = result.avgScore >= 8 ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL;
        await query('UPDATE applications SET sla_hours=$1 WHERE id=$2', [refinedSla, app.id]);
        await query(
          `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by_name)
           VALUES ($1,$2,$3,'ResumeIQ Scoring Completed',$4,$5,'System')`,
          [app.id, app.candidate_id, app.role_id,
           `Score: ${result.fit_score}/100 (${result.priority_bucket})`,
           result.priority_bucket]
        );
      } catch (err) {
        console.error('[ResumeIQ] Scoring failed for', app.id, err);
      }
    });
  }

  // If advancing to Shortlisted, create pending action for HM
  if (new_stage === 'Shortlisted') {
    const role = await queryOne<{ title: string; hiring_manager_name: string }>(
      'SELECT title, hiring_manager_name FROM roles WHERE id = $1', [app.role_id]
    );
    const cand = await queryOne<{ full_name: string }>(
      'SELECT full_name FROM candidates WHERE id = $1', [app.candidate_id]
    );
    await queryOne(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
       VALUES ('Hiring Manager', 'High', 'HM shortlist review', $1, $2, $3, $4, 0)`,
      [
        `Review ${cand?.full_name} for ${role?.title} — HM shortlist decision needed`,
        app.id, cand?.full_name, role?.title
      ]
    );
  }

  const updated = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  res.json({ application: updated });
});

// ─── POST /api/applications/:id/status — change status (On Hold/Reject/Withdraw)
// PRD Section 9.1: status changes are SEPARATE from stage
router.post('/:id/status', requireHR, async (req: Request, res: Response) => {
  const { new_status, rejection_reason_cat, rejection_reason_detail,
          withdrawal_reason_cat, withdrawal_reason_detail } = req.body;

  if (!new_status) { res.status(400).json({ error: 'new_status required' }); return; }

  // Rejection and withdrawal require a reason
  if ((new_status === 'Rejected' || new_status === 'Withdrawn') && !rejection_reason_cat && !withdrawal_reason_cat) {
    res.status(400).json({ error: 'A reason is required when rejecting or withdrawing a candidate' });
    return;
  }

  const app = await queryOne<Application>('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  await transaction(async (client) => {
    await client.query(
      `UPDATE applications SET status=$1,
       rejection_reason_cat=$2, rejection_reason_detail=$3,
       withdrawal_reason_cat=$4, withdrawal_reason_detail=$5,
       last_updated=NOW() WHERE id=$6`,
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

  // Only HMs can set HM Shortlisted; HR can set everything else
  if (new_screening_status === 'HM Shortlisted' &&
      req.user!.persona !== 'hiring_manager' && req.user!.persona !== 'hr_recruiter') {
    res.status(403).json({ error: 'Only a Hiring Manager can set HM Shortlisted' });
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
    'next_action','next_action_owner'];

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

  values.push(req.params.id);
  await queryOne(
    `UPDATE applications SET ${updates.join(', ')}, last_updated=NOW() WHERE id=$${i}`,
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
  if (req.user!.persona !== 'leadership' && req.user!.persona !== 'hr_recruiter') {
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

export default router;
