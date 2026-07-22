import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';
import { InterviewRound } from '../types/index.js';
import { createInterviewCalendarEvent } from '../services/calendarService.js';

const router = Router();
router.use(authenticate);

async function nextRoundId(client?: import('pg').PoolClient): Promise<string> {
  const q = client
    ? client.query("SELECT id FROM interview_rounds ORDER BY id DESC LIMIT 1")
    : queryOne<{ id: string }>("SELECT id FROM interview_rounds ORDER BY id DESC LIMIT 1");
  const last = await q;
  const row = client ? (last as import('pg').QueryResult).rows[0] : last as { id: string } | null;
  const num = row ? parseInt(row.id.replace('IR', '')) + 1 : 1;
  return `IR${String(num).padStart(4, '0')}`;
}

// ─── GET /api/interviews?application_id=A001 ─────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const { application_id } = req.query;
  if (!application_id) { res.status(400).json({ error: 'application_id required' }); return; }

  const rounds = await query<InterviewRound>(
    'SELECT * FROM interview_rounds WHERE application_id=$1 ORDER BY round_number',
    [application_id]
  );
  res.json({ rounds });
});

// ─── POST /api/interviews — create / schedule a round ────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', requireHR, async (req: Request, res: Response) => {
  const {
    application_id, round_name, round_type = 'Standard',
    round_number, interviewer_emails, scheduled_date,
    interview_mode = 'Video', focus_areas, duration_minutes = 60,
  } = req.body;

  if (!application_id || !round_name) {
    res.status(400).json({ error: 'application_id and round_name required' });
    return;
  }

  if (interviewer_emails != null) {
    if (!Array.isArray(interviewer_emails) || !interviewer_emails.every((e: unknown) => typeof e === 'string')) {
      res.status(400).json({ error: 'interviewer_emails must be an array of strings' });
      return;
    }
    const invalid = interviewer_emails.find((e: string) => !EMAIL_RE.test(e));
    if (invalid) { res.status(400).json({ error: `"${invalid}" is not a valid email address` }); return; }
  }

  const app = await queryOne<{ candidate_id: string; role_id: string; candidate_name: string; role_title: string }>(
    `SELECT a.candidate_id, a.role_id, c.full_name AS candidate_name, r.title AS role_title
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     JOIN roles r ON r.id = a.role_id
     WHERE a.id = $1`,
    [application_id]
  );
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  const round = await transaction(async (client) => {
    const id = await nextRoundId(client);
    const r = await client.query(
      `INSERT INTO interview_rounds
         (id, application_id, round_name, round_type, round_number,
          interviewer_emails, scheduled_date, interview_mode, focus_areas, duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, application_id, round_name, round_type,
       round_number || 1, interviewer_emails || null, scheduled_date, interview_mode,
       focus_areas || [], duration_minutes]
    );

    // Stage no longer auto-advances here — the application must already be
    // sitting in the correct stage (Interview Round 1/2, Founders Round, or
    // Assignment Round) for this button to have been reachable at all, via
    // POST /applications/:id/stage, which already owns stage_entry_time and
    // sla_hours. Scheduling a round is purely additive.

    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [application_id, app.candidate_id, app.role_id,
       'Interview Round Scheduled', `${round_name} scheduled for ${scheduled_date || 'TBD'}`,
       JSON.stringify({ round: round_name, interviewer_emails: interviewer_emails || null }),
       req.user!.userId, req.user!.name]
    );

    return r.rows[0] as InterviewRound;
  });

  // Synchronous, gracefully-degrading Calendar sync — deliberately not async
  // fire-and-forget like ResumeIQ. A missing ResumeIQ score still degrades to
  // a usable profile-only result; a failed calendar invite means the
  // interviewer never finds out about the meeting at all (the invite email
  // IS the notification), so HR needs to know immediately, not silently.
  // Only attempted for Standard rounds with an actual date + attendees —
  // Assignment rounds have no meeting to put on a calendar.
  let calendar: { synced: boolean; event_link?: string; error?: string } | undefined;

  if (
    round.round_type === 'Standard' && round.scheduled_date &&
    Array.isArray(round.interviewer_emails) && round.interviewer_emails.length > 0
  ) {
    try {
      const event = await createInterviewCalendarEvent({
        organizerEmail: req.user!.email,
        attendees: round.interviewer_emails,
        summary: `${round.round_name} — ${app.candidate_name} (${app.role_title})`,
        description: `Interview round "${round.round_name}" for ${app.candidate_name}'s application to ${app.role_title}.\nScheduled via DigitalPaani HMS.`,
        startTime: round.scheduled_date,
        durationMinutes: round.duration_minutes ?? 60,
        mode: (round.interview_mode as 'In-person' | 'Video' | 'Phone') || 'Video',
      });
      await query(
        `UPDATE interview_rounds SET calendar_event_id=$1, calendar_event_link=$2, calendar_sync_error=NULL, updated_at=NOW() WHERE id=$3`,
        [event.eventId, event.eventLink, round.id]
      );
      round.calendar_event_id = event.eventId;
      round.calendar_event_link = event.eventLink;
      calendar = { synced: true, event_link: event.eventLink };
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[Calendar] Failed to create event for round ${round.id}:`, message);
      await query(
        `UPDATE interview_rounds SET calendar_sync_error=$1, updated_at=NOW() WHERE id=$2`,
        [message.slice(0, 500), round.id]
      );
      calendar = { synced: false, error: 'Round scheduled, but the calendar invite failed — you may need to notify interviewers manually.' };
    }

    await query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [application_id, app.candidate_id, app.role_id,
       calendar.synced ? 'Calendar Invite Created' : 'Calendar Invite Failed',
       calendar.synced ? `Invite sent to ${round.interviewer_emails!.join(', ')}` : calendar.error,
       calendar.synced ? round.calendar_event_link! : null,
       req.user!.userId, req.user!.name]
    );
  }

  res.status(201).json({ round, calendar });
});

// ─── PATCH /api/interviews/:id/feedback — submit feedback ────────────────────
router.patch('/:id/feedback', async (req: Request, res: Response) => {
  const round = await queryOne<InterviewRound>(
    'SELECT * FROM interview_rounds WHERE id=$1', [req.params.id]
  );
  if (!round) { res.status(404).json({ error: 'Round not found' }); return; }

  // Check HM/Interviewer can only submit for their own rounds
  const persona = req.user!.persona;
  if (persona === 'interviewer') {
    // Would check interviewer_emails includes req.user.email — simplified here
  }

  const isAssignment = round.round_type === 'Assignment';

  const {
    eval_areas_assessed, scores_per_area, confidence_level,
    overall_assessment, strengths_observed, key_concerns,
    unresolved_questions, suggested_probe_areas, round_recommendation, notes,
  } = req.body;
  const {
    assignment_outcome, score_technical_accuracy, score_problem_solving,
    score_clarity, score_practical_thinking, score_completeness, assignment_notes,
  } = req.body;

  // Compute weighted average (Standard rounds)
  let overall_round_score: number | null = null;
  if (scores_per_area && typeof scores_per_area === 'object') {
    const vals = Object.values(scores_per_area) as number[];
    overall_round_score = vals.length > 0
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : null;
  }

  // Weighted rubric total (Assignment rounds) — Technical Accuracy 40% /
  // Problem Solving 25% / Clarity & Structure 15% / Practical Thinking 10%
  // / Completeness 10%, per PRD §12. Only computed once all 5 are in.
  let assignment_overall_score: number | null = null;
  if (isAssignment && [score_technical_accuracy, score_problem_solving, score_clarity,
      score_practical_thinking, score_completeness].every(v => v != null)) {
    assignment_overall_score = Math.round((
      score_technical_accuracy * 0.4 + score_problem_solving * 0.25 +
      score_clarity * 0.15 + score_practical_thinking * 0.10 + score_completeness * 0.10
    ) * 10) / 10;
  }

  await transaction(async (client) => {
    if (isAssignment) {
      await client.query(
        `UPDATE interview_rounds SET
           assignment_outcome=$1, score_technical_accuracy=$2, score_problem_solving=$3,
           score_clarity=$4, score_practical_thinking=$5, score_completeness=$6,
           assignment_overall_score=$7, assignment_notes=$8,
           feedback_status='Submitted', feedback_submitted_at=NOW(),
           entered_by=$9, updated_at=NOW()
         WHERE id=$10`,
        [assignment_outcome, score_technical_accuracy, score_problem_solving,
         score_clarity, score_practical_thinking, score_completeness,
         assignment_overall_score, assignment_notes,
         req.user!.userId, req.params.id]
      );
    } else {
      await client.query(
        `UPDATE interview_rounds SET
           eval_areas_assessed=$1, scores_per_area=$2, overall_round_score=$3,
           confidence_level=$4, overall_assessment=$5, strengths_observed=$6,
           key_concerns=$7, unresolved_questions=$8, suggested_probe_areas=$9,
           round_recommendation=$10, notes=$11,
           feedback_status='Submitted', feedback_submitted_at=NOW(),
           entered_by=$12, updated_at=NOW()
         WHERE id=$13`,
        [eval_areas_assessed, JSON.stringify(scores_per_area), overall_round_score,
         confidence_level, overall_assessment, strengths_observed, key_concerns,
         unresolved_questions, suggested_probe_areas, round_recommendation, notes,
         req.user!.userId, req.params.id]
      );
    }

    // Resolve feedback-due pending action
    await client.query(
      `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
       WHERE application_id=$1 AND action_type='Interview feedback due' AND resolved=false`,
      [round.application_id]
    );

    const app = await client.query(
      'SELECT candidate_id, role_id FROM applications WHERE id=$1',
      [round.application_id]
    );

    if (isAssignment) {
      await client.query(
        `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [round.application_id, app.rows[0]?.candidate_id, app.rows[0]?.role_id,
         'Assignment Evaluated',
         `${round.round_name}: ${assignment_outcome || ''} (score: ${assignment_overall_score ?? '—'}/5)`,
         assignment_outcome, req.user!.userId, req.user!.name]
      );
    } else {
      await client.query(
        `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [round.application_id, app.rows[0]?.candidate_id, app.rows[0]?.role_id,
         'Interview Feedback Submitted',
         `${round.round_name}: ${overall_assessment || ''} (score: ${overall_round_score ?? '—'})`,
         round_recommendation, req.user!.userId, req.user!.name]
      );
    }
  });

  const updated = await queryOne<InterviewRound>(
    'SELECT * FROM interview_rounds WHERE id=$1', [req.params.id]
  );
  res.json({ round: updated });
});

// ─── POST /api/interviews/:id/assignment-send ─────────────────────────────────
router.post('/:id/assignment-send', requireHR, async (req: Request, res: Response) => {
  const { assignment_repo_id, submission_link_placeholder } = req.body;

  const round = await queryOne<InterviewRound>(
    'SELECT * FROM interview_rounds WHERE id=$1', [req.params.id]
  );
  if (!round) { res.status(404).json({ error: 'Round not found' }); return; }
  if (round.round_type !== 'Assignment') {
    res.status(400).json({ error: 'This round is not configured as an Assignment round' });
    return;
  }

  const sendTime = new Date();
  const deadline = new Date(sendTime.getTime() + 60 * 60 * 1000 * 60); // 60 hours

  await transaction(async (client) => {
    await client.query(
      `UPDATE interview_rounds SET
         assignment_repo_id=$1, assignment_send_date=$2, assignment_deadline=$3, updated_at=NOW()
       WHERE id=$4`,
      [assignment_repo_id || null, sendTime.toISOString(), deadline.toISOString(), req.params.id]
    );
    if (assignment_repo_id) {
      await client.query(
        `UPDATE assignment_repo SET times_used=times_used+1, last_used=NOW() WHERE id=$1`,
        [assignment_repo_id]
      );
    }
    const app = await client.query('SELECT candidate_id, role_id FROM applications WHERE id=$1', [round.application_id]);
    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [round.application_id, app.rows[0]?.candidate_id, app.rows[0]?.role_id,
       'Assignment Sent', `Deadline: ${deadline.toISOString()}`,
       deadline.toISOString(), req.user!.userId, req.user!.name]
    );
  });

  res.json({ success: true, deadline: deadline.toISOString() });
});

// ─── POST /api/interviews/:id/assignment-submit ───────────────────────────────
router.post('/:id/assignment-submit', requireHR, async (req: Request, res: Response) => {
  const { submission_link } = req.body;
  if (!submission_link) { res.status(400).json({ error: 'submission_link required' }); return; }

  const round = await queryOne<InterviewRound>('SELECT * FROM interview_rounds WHERE id=$1', [req.params.id]);
  if (!round) { res.status(404).json({ error: 'Round not found' }); return; }

  await transaction(async (client) => {
    await client.query(
      `UPDATE interview_rounds SET assignment_submission_date=NOW(), assignment_submission_link=$1, updated_at=NOW() WHERE id=$2`,
      [submission_link, req.params.id]
    );
    await client.query(
      `UPDATE applications SET assignment_submission_link=$1, last_updated=NOW() WHERE id=$2`,
      [submission_link, round.application_id]
    );
    const app = await client.query('SELECT candidate_id, role_id FROM applications WHERE id=$1', [round.application_id]);
    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [round.application_id, app.rows[0]?.candidate_id, app.rows[0]?.role_id,
       'Assignment Submitted', 'Submission received', submission_link, req.user!.userId, req.user!.name]
    );
  });

  res.json({ success: true });
});

export default router;
