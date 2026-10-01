import { transaction } from '../../db/index.js';
import { SLA_HOURS } from '../../types/index.js';
import { priorityBucketFromScore } from '../resumeIQ.js';
import { computeAvg } from './rubric.js';
import { PortfolioAnalysisResult } from './types.js';
import { jsonbSafeStringify } from './text.js';

// Writes the portfolio review into the application: the 9th ResumeIQ
// dimension, the recomputed average (and everything derived from it), the
// highlights, and the stored review. Re-runnable — every value is derived from
// the 8 stored base scores plus THIS run's portfolio score, never from the
// previous average, so running it twice can't double-count.

const SUMMARY_MARK = ' Portfolio review: ';
const FLAG_PREFIX = 'Portfolio: ';

export interface PortfolioOutcome {
  status:   'completed' | 'inaccessible' | 'no_portfolio';
  /** null = the dimension is not applied at all (e.g. the resume itself was unreadable). */
  score:    number | null;
  note:     string;
  oneLiner?: string;
  /** Stored in portfolio_analysis_error — an explanation shown next to the status. */
  message?: string;
  redFlags: string[];
  analysis?: PortfolioAnalysisResult;
}

export async function applyPortfolioOutcome(applicationId: string, out: PortfolioOutcome): Promise<{ avg: number | null }> {
  return transaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [applicationId]);
    const app = rows[0];
    if (!app) throw new Error('Application not found');

    const base: Array<number | null> = [
      app.score_technical, app.score_experience, app.score_industry_fit, app.score_culture_fit,
      app.score_role_alignment, app.score_trajectory, app.score_leadership, app.score_communication,
    ];
    const haveBase = base.every(v => v != null);

    let avg: number | null = null;
    if (out.score != null && haveBase) {
      avg = computeAvg(base as number[], out.score);
      const baseSummary = String(app.score_summary || '').split(SUMMARY_MARK)[0].trim();
      const summary = out.oneLiner ? `${baseSummary}${SUMMARY_MARK}${out.oneLiner}` : baseSummary;
      const keptFlags = ((app.score_red_flags as string[] | null) || []).filter(f => !f.startsWith(FLAG_PREFIX));
      const flags = [...keptFlags, ...out.redFlags.slice(0, 3).map(f => `${FLAG_PREFIX}${f}`)];
      await client.query(
        `UPDATE applications SET
           score_portfolio=$1, score_portfolio_note=$2,
           score_avg=$3, ai_fit_score=$4, ai_priority_bucket=$5,
           score_summary=$6, score_red_flags=$7,
           sla_hours = CASE WHEN stage='Applied and Screened' THEN $8::int ELSE sla_hours END,
           portfolio_analysis_status=$9, portfolio_analysis_error=$10, portfolio_analyzed_at=NOW()
         WHERE id=$11`,
        [
          out.score, out.note.slice(0, 120), avg, Math.round(avg * 10), priorityBucketFromScore(avg),
          summary, flags,
          avg >= 8 ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL,
          out.status, out.message ?? null, applicationId,
        ],
      );
    } else {
      // The dimension isn't applied (or there's no base score to fold it into yet).
      await client.query(
        `UPDATE applications SET portfolio_analysis_status=$1, portfolio_analysis_error=$2, portfolio_analyzed_at=NOW() WHERE id=$3`,
        [out.status, out.message ?? null, applicationId],
      );
    }

    if (out.analysis) {
      await client.query(
        `INSERT INTO portfolio_analyses (application_id, analysis) VALUES ($1, $2::jsonb)
         ON CONFLICT (application_id) DO UPDATE SET analysis=EXCLUDED.analysis, updated_at=NOW()`,
        [applicationId, jsonbSafeStringify(out.analysis)],
      );
    }

    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by_name)
       VALUES ($1,$2,$3,'Portfolio Review Completed',$4,$5,'System')`,
      [
        applicationId, app.candidate_id, app.role_id,
        out.score != null && avg != null
          ? `Portfolio ${out.score}/10 (${out.status}) — overall score now ${avg}/10`
          : `Portfolio review: ${out.status}`,
        out.status,
      ],
    );
    return { avg };
  });
}

export { SUMMARY_MARK, FLAG_PREFIX };
