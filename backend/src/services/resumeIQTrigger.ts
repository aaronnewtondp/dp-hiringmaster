// Shared ResumeIQ scoring trigger — every place an application is created
// (manual "Add candidate", Link to role, Job Application Form ingestion)
// calls this the moment the row exists, synchronously, so a candidate is
// scored the instant they apply rather than waiting on a later manual
// "move to Resume Review" step (2026-09-01 — that stage was retired
// outright; see backend/src/types/index.ts's STAGE_ORDER). Extracted out of
// applications.ts's old stage-change handler so every creation path shares
// one implementation instead of re-deriving it.
import { query, queryOne } from '../db/index.js';
import { Application, Candidate, Role, SLA_HOURS } from '../types/index.js';
import { scoreCandidate, priorityBucketFromScore } from './resumeIQ.js';
import { fetchResumeText } from './driveService.js';

export interface ResumeIqTriggerResult {
  scored: boolean;
  error?: string;
}

// Guarded by !app.score_avg by the caller (or here, redundantly, since a
// couple of callers pass an application id without having checked first) —
// this only ever runs once per application, ever.
export async function runResumeIQScoring(applicationId: string): Promise<ResumeIqTriggerResult> {
  const app = await queryOne<Application>('SELECT * FROM applications WHERE id=$1', [applicationId]);
  if (!app) return { scored: false, error: 'Application not found' };
  if (app.score_avg) return { scored: true };

  try {
    const candidate = await queryOne<Candidate>('SELECT * FROM candidates WHERE id=$1', [app.candidate_id]);
    const role      = await queryOne<Role>('SELECT * FROM roles WHERE id=$1', [app.role_id]);
    if (!candidate || !role) return { scored: false, error: 'Candidate or role not found' };

    // Fetch actual resume text from Drive if a link is on file. Falls back
    // gracefully to profile-fields-only scoring on any failure.
    let resumeText: string | null = null;
    if (candidate.resume_drive_link) {
      resumeText = await fetchResumeText(candidate.resume_drive_link);
      if (resumeText) {
        console.log(`[ResumeIQ] Resume text fetched for ${candidate.id} (${resumeText.length} chars)`);
      } else {
        console.warn(`[ResumeIQ] Could not fetch resume for ${candidate.id} — scoring from profile fields only`);
      }
    }

    const result = await scoreCandidate(candidate, role, resumeText, app.preferred_location, app.screening_answers);
    // ai_fit_score/ai_priority_bucket are the legacy 0-100-scale columns
    // still read by the dashboard's fit buckets and the role-pipeline sort
    // — derived from avgScore (0-10) here to keep every reader in sync.
    const aiFitScore = Math.round(result.avgScore * 10);
    const aiPriorityBucket = priorityBucketFromScore(result.avgScore);
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
         score_computed_at=NOW(), ai_fit_score=$23, ai_priority_bucket=$24,
         sla_hours=$25
       WHERE id=$26`,
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
        aiFitScore, aiPriorityBucket,
        // Refined SLA now the fit score is known — same threshold ResumeIQ
        // scoring at the old 'Resume Review' stage used to apply.
        result.avgScore >= 8 ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL,
        app.id,
      ]
    );
    await query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by_name)
       VALUES ($1,$2,$3,'ResumeIQ Scoring Completed',$4,$5,'System')`,
      [app.id, app.candidate_id, app.role_id,
       `Score: ${aiFitScore}/100 (${aiPriorityBucket})`,
       aiPriorityBucket]
    );
    return { scored: true };
  } catch (err) {
    console.error('[ResumeIQ] Scoring failed for', app.id, err);
    return { scored: false, error: 'Scoring failed — will retry automatically the next time this is retried' };
  }
}
