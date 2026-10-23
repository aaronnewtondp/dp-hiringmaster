// LIGHT — safe to import from the main API. Only knows how to hand a job to
// the queue; the browser/Claude work lives in run.ts, which only the separate
// worker function (api/portfolio-worker.ts) ever imports.
import { query } from '../../db/index.js';
import { PortfolioAnalysisResult, PortfolioLink } from './types.js';
import { applyPortfolioOutcome } from './scoring.js';
import type { PortfolioOutcome } from './scoring.js';
import type { AnswerLinkPick } from './answerLinks.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

export const PORTFOLIO_TOPIC = 'portfolio-analysis';

export async function enqueuePortfolioAnalysis(
  applicationId: string,
  opts: { busyRetries?: number; attemptsUsed?: number; delaySeconds?: number } = {},
): Promise<{ enqueued: boolean; error?: string }> {
  try {
    const { send } = await import('@vercel/queue');
    // Queueing runs inside the applicant-facing scoring request (and the Job
    // Application webhook). A slow or hung queue service must degrade to "not
    // queued, use Re-run" — never stall the request that already saved a score.
    await Promise.race([
      send(
        PORTFOLIO_TOPIC,
        opts.busyRetries || opts.attemptsUsed
          ? { applicationId, busyRetries: opts.busyRetries ?? 0, attemptsUsed: opts.attemptsUsed ?? 0 }
          : { applicationId },
        opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue did not respond within 8s')), 8000)),
    ]);
    return { enqueued: true };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    console.error('[Portfolio] Could not enqueue', applicationId, error);
    // Leave the row 'pending' with a visible reason — the manual Re-run
    // button and the sweep pick it up; never a silent null.
    // Only while the review is still waiting: by now the row may have settled (a duplicate
    // chain's hand-back failing late) and must not get an error note written onto a good review.
    await query(
      `UPDATE applications SET portfolio_analysis_error=$1 WHERE id=$2 AND portfolio_analysis_status='pending'`,
      [`Could not be queued (${error}). Use Re-run to retry.`, applicationId],
    ).catch(() => {});
    return { enqueued: false, error };
  }
}

export interface PreparedPortfolio {
  /**
   * 'busy' = a live review is running for this application right now; nothing was changed.
   * 'unreviewable' and 'failed' only come from prepareMarketingReview: every link is on a platform that cannot be
   * opened automatically, or a re-run could not settle and the earlier review was kept.
   */
  status: 'pending' | 'no_portfolio' | 'unreviewable' | 'failed' | 'busy';
  links:  PortfolioLink[];
  queued: boolean;
}

/**
 * Worker-side give-up (budget spent, or the browser stayed busy too long). Unlike
 * markPortfolioFailed it only touches a row that is genuinely still waiting — 'pending', or
 * 'running' past the point a live worker could hold it — so a stale duplicate message can never
 * flip a review that has since completed (or settled any other way) to 'failed'.
 */
export async function markPortfolioGaveUp(applicationId: string, message: string): Promise<void> {
  await query(
    `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1
     WHERE id=$2 AND (
       portfolio_analysis_status='pending'
       OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($3 || ' seconds')::interval)
     )`,
    [message.slice(0, 500), applicationId, String(STALE_RUNNING_SECONDS)],
  ).catch(() => {});
}

/**
 * Is there still a review for a queue message to do? True for a waiting row ('pending', or
 * 'failed' which claim() will pick up) and for a dead 'running' one; false once the review has
 * settled, is held by a live worker, or the application is gone. A legitimate Re-run always
 * resets the row to 'pending' before it queues, so a message for a settled row is a stale
 * duplicate.
 */
export async function portfolioNeedsReview(applicationId: string): Promise<boolean> {
  const rows = await query<{ needs: boolean }>(
    `SELECT (portfolio_analysis_status IN ('pending','failed')
             OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($2 || ' seconds')::interval)) AS needs
     FROM applications WHERE id=$1`,
    [applicationId, String(STALE_RUNNING_SECONDS)],
  );
  return rows[0]?.needs === true;
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

/**
 * A valid, empty marketing review for the outcomes decided without opening anything. No model ran, so the
 * review carries only what code knows: the candidate's own wording and the links that were not opened. The real
 * score lives in applications.score_portfolio, which stays NULL here (`score` below is a placeholder, never read).
 */
export function minimalMarketingAnalysis(args: {
  summary:     string;
  claimText?:  string;
  unreviewed?: AnswerLinkPick['listedNotReviewed'];
}): PortfolioAnalysisResult {
  return {
    version: 1, kind: 'marketing_work', analyzedAt: new Date().toISOString(), model: 'none',
    portfolios: [], criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
    modelScore: 0, checklistScore: 0, score: 0, scoreNote: '', highlights: [], redFlags: [],
    summary: args.summary,
    ...(args.claimText ? { claimText: args.claimText } : {}),
    ...(args.unreviewed?.length ? { unreviewed: args.unreviewed.map(({ url, platform, reason }) => ({ url, platform, reason })) } : {}),
  };
}

interface UnscoredMarketingCase {
  status:  'no_portfolio' | 'unreviewable';
  /** Stored in portfolio_analysis_error and shown next to the status. */
  message: string;
  summary: string;
  /** Why nothing could be reviewed this time, worded to lead "<this> — the earlier review (N/10) still applies". */
  now:     string;
  extra:   { claimText?: string; unreviewed?: AnswerLinkPick['listedNotReviewed'] };
}

/**
 * The answers that need no job at all: nothing to open (blank, "N/A", "under NDA"), only words, or only links that
 * are never opened automatically (LinkedIn, social, file-transfer). null = at least one link will be opened.
 */
function unscoredMarketingCase(pick: AnswerLinkPick): UnscoredMarketingCase | null {
  if (!pick.answered) {
    return {
      status: 'no_portfolio', message: 'No work samples provided; this dimension is not applied',
      summary: 'No work samples were provided.', now: 'No work samples were found in the answer this time', extra: {},
    };
  }
  if (pick.textOnly) {
    return {
      status: 'no_portfolio',
      message: 'Only a written description was provided - there were no work samples to review; this dimension is not applied',
      summary: 'Only a written description was provided; there were no work samples to review.',
      now: 'Only a written description was found this time', extra: { claimText: pick.claimText },
    };
  }
  if (!pick.links.length) {
    return {
      status: 'unreviewable', message: 'The links are on platforms that cannot be opened automatically - open them by hand',
      summary: 'Every link is on a platform that cannot be opened automatically. Open them by hand.',
      now: 'The links could not be opened this time (their platforms cannot be opened automatically)',
      extra: { unreviewed: pick.listedNotReviewed },
    };
  }
  return null;
}

/**
 * The marketing work-sample review's counterpart of preparePortfolioReview: called right after the base score is
 * saved (and by Re-run) with the links picked from the candidate's screening answer. Whatever cannot be opened is
 * settled at once with score NULL — the dimension is simply not applied, never a 0 — and with no model call; the
 * rest is stored and queued for the worker.
 */
export async function prepareMarketingReview(args: {
  applicationId: string;
  pick:          AnswerLinkPick;
}): Promise<PreparedPortfolio> {
  const { applicationId, pick } = args;
  const unscored = unscoredMarketingCase(pick);
  const links = unscored ? [] : pick.links;

  // Same conditional reset as the designer path (see NOT_RUNNING_SQL), plus the score a previous review left.
  // The stored links are replaced in every case EXCEPT one: a re-run that finds nothing to open ($4) while an earlier
  // review exists. That run ends 'failed … the earlier review still applies' (below), so the links that review was
  // built from must survive it — they are what the application row says the kept score is based on. Deciding it in
  // the same statement (score_portfolio is the row's value before the update) leaves no gap for a worker to slip a
  // score in between a read and this write. A run that DOES queue always replaces them: the worker treats
  // portfolio_urls as authoritative, so keeping the old ones would review the wrong links.
  const reset = await query<{ id: string; score_portfolio: number | null }>(
    `UPDATE applications
     SET portfolio_urls=CASE WHEN $4::boolean AND score_portfolio IS NOT NULL THEN portfolio_urls ELSE $1::jsonb END,
         portfolio_analysis_status='pending', portfolio_analysis_error=NULL
     WHERE id=$2 AND ${NOT_RUNNING_SQL} RETURNING id, score_portfolio`,
    [JSON.stringify(links), applicationId, String(STALE_RUNNING_SECONDS), unscored !== null],
  );
  if (!reset.length) return { status: 'busy', links, queued: false };

  if (!unscored) {
    const { enqueued } = await enqueuePortfolioAnalysis(applicationId);
    return { status: 'pending', links, queued: enqueued };
  }

  // A re-run that finds nothing to review must not overwrite a good review: the earlier score is already folded
  // into the average, and a 'no_portfolio' / 'unreviewable' status beside it would contradict that. Same rule the
  // worker applies when a re-run comes back without a score.
  const earlier = reset[0].score_portfolio;
  if (earlier != null) {
    await markPortfolioFailed(applicationId, `${unscored.now} — the earlier review (${earlier}/10) still applies. Use Re-run to retry.`);
    return { status: 'failed', links: [], queued: false };
  }

  const outcome: PortfolioOutcome = {
    status: unscored.status, score: null, note: '', redFlags: [], message: unscored.message,
    analysis: minimalMarketingAnalysis({ summary: unscored.summary, ...unscored.extra }),
  };
  try {
    await applyPortfolioOutcome(applicationId, outcome);
  } catch (err) {
    // The row is 'pending' and nothing is queued: say so, with a Re-run action, instead of leaving it waiting forever.
    await markPortfolioFailed(applicationId, 'The review could not be recorded. Use Re-run to retry.');
    throw err;
  }
  return { status: unscored.status, links: [], queued: false };
}
