// LIGHT — safe to import from the main API. Only knows how to hand a job to
// the queue; the browser/Claude work lives in run.ts, which only the separate
// worker function (api/portfolio-worker.ts) ever imports.
import { query } from '../../db/index.js';
import { PortfolioLink } from './types.js';
import { applyPortfolioOutcome } from './scoring.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

export const PORTFOLIO_TOPIC = 'portfolio-analysis';

export async function enqueuePortfolioAnalysis(applicationId: string): Promise<{ enqueued: boolean; error?: string }> {
  try {
    const { send } = await import('@vercel/queue');
    // Queueing runs inside the applicant-facing scoring request (and the Job
    // Application webhook). A slow or hung queue service must degrade to "not
    // queued, use Re-run" — never stall the request that already saved a score.
    await Promise.race([
      send(PORTFOLIO_TOPIC, { applicationId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue did not respond within 8s')), 8000)),
    ]);
    return { enqueued: true };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    console.error('[Portfolio] Could not enqueue', applicationId, error);
    // Leave the row 'pending' with a visible reason — the manual Re-run
    // button and the sweep pick it up; never a silent null.
    await query(
      `UPDATE applications SET portfolio_analysis_error=$1 WHERE id=$2`,
      [`Could not be queued (${error}). Use Re-run to retry.`, applicationId],
    ).catch(() => {});
    return { enqueued: false, error };
  }
}

export interface PreparedPortfolio {
  /** 'busy' = a live review is running for this application right now; nothing was changed. */
  status: 'pending' | 'no_portfolio' | 'busy';
  links:  PortfolioLink[];
  queued: boolean;
}

/** Records a failure that is ours (not the candidate's) so it shows up with a Re-run action instead of vanishing. */
export async function markPortfolioFailed(applicationId: string, message: string): Promise<void> {
  await query(
    `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1
     WHERE id=$2 AND portfolio_analysis_status IS DISTINCT FROM 'running'`,
    [message.slice(0, 500), applicationId],
  ).catch(() => {});
}

// The reset is conditional IN SQL — a separate "is it running?" read followed by
// a write would let a worker claim the row in between and then have its status
// stomped back to 'pending' (and a second worker started concurrently).
const NOT_RUNNING_SQL = `(portfolio_analysis_status IS DISTINCT FROM 'running'
  OR portfolio_started_at < NOW() - ($3 || ' seconds')::interval)`;

/**
 * Called right after the base 8-dimension score is saved, for roles with
 * portfolio review enabled. Stores the portfolio links the resume contained
 * and either queues the review or settles it immediately (no link at all).
 */
export async function preparePortfolioReview(args: {
  applicationId: string;
  links:         PortfolioLink[];
  resumeRead:    boolean;
}): Promise<PreparedPortfolio> {
  const { applicationId, links, resumeRead } = args;

  if (!links.length) {
    const reset = await query(
      `UPDATE applications SET portfolio_urls='[]'::jsonb, portfolio_analysis_status='pending', portfolio_analysis_error=NULL
       WHERE id=$1 AND ${NOT_RUNNING_SQL.replace('$3', '$2')} RETURNING id`,
      [applicationId, String(STALE_RUNNING_SECONDS)],
    );
    if (!reset.length) return { status: 'busy', links: [], queued: false };
    // No portfolio is itself a finding for a role whose first must-have is a
    // strong portfolio — but only when we could actually read the resume. An
    // unreadable resume says nothing about whether a link exists, so the
    // dimension is simply not applied.
    await applyPortfolioOutcome(applicationId, resumeRead
      ? {
          status: 'no_portfolio', score: 0, note: 'No portfolio link in resume',
          oneLiner: 'No portfolio link was found in the resume, so the portfolio could not be reviewed.',
          redFlags: ['No portfolio link found in the resume'],
        }
      : { status: 'no_portfolio', score: null, note: '', redFlags: [], message: 'The resume could not be read, so no portfolio link could be extracted.' });
    return { status: 'no_portfolio', links: [], queued: false };
  }

  const reset = await query(
    `UPDATE applications SET portfolio_urls=$1::jsonb, portfolio_analysis_status='pending', portfolio_analysis_error=NULL
     WHERE id=$2 AND ${NOT_RUNNING_SQL} RETURNING id`,
    [JSON.stringify(links), applicationId, String(STALE_RUNNING_SECONDS)],
  );
  if (!reset.length) return { status: 'busy', links, queued: false };
  const { enqueued } = await enqueuePortfolioAnalysis(applicationId);
  return { status: 'pending', links, queued: enqueued };
}
