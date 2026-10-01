// WORKER-ONLY (see browser.ts): the orchestrator behind the queue consumer and
// the direct-run endpoint in api/portfolio-worker.ts.
import { query, queryOne } from '../../db/index.js';
import { Application, Candidate, Role } from '../../types/index.js';
import { BrowserBusyError, isBrowserInUse, withBrowser } from './browser.js';
import { capturePortfolios, CapturedPortfolio } from './capture.js';
import { analyzePortfolios } from './analyze.js';
import { applyPortfolioOutcome } from './scoring.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';
import { PortfolioAnalysisResult, PortfolioLink, PortfolioReviewed } from './types.js';

// Wall-clock budget for the whole job. The function limit is 300s; browser work
// gets what's left after reserving time for the model call and DB writes.
const TOTAL_BUDGET_MS = 270_000;
const ANALYSIS_RESERVE_MS = 75_000;

/** Queue deliveries after which a transient failure is recorded as 'failed' instead of retried. */
export const MAX_ATTEMPTS = 3;

/**
 * How long a review waits for this instance's browser before reporting 'busy'. Short on
 * purpose: the occupant needs minutes, so waiting longer only burns billed time — the
 * caller hands the review back to the queue to be tried again later instead.
 */
export const BUSY_WAIT_MS = 3_000;

export interface RunResult {
  ran:     boolean;
  /** 'busy' = another review holds this instance's browser; nothing was run or recorded, hand the job back. */
  status?: string;
  reason?: string;
}

/**
 * Atomically claims the job so a redelivered queue message can't run it twice.
 * A row stuck in 'running' longer than the function can possibly live is
 * treated as dead (killed by a timeout/OOM — its `finally` never ran) and is
 * reclaimable, both by the queue's redelivery and by an HR re-run.
 */
async function claim(applicationId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW(), portfolio_analysis_error=NULL
     WHERE id=$1 AND (
       portfolio_analysis_status IN ('pending','failed')
       OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($2 || ' seconds')::interval)
     )
     RETURNING id`,
    [applicationId, String(STALE_RUNNING_SECONDS)],
  );
  return rows.length > 0;
}

/** Hands a claimed job back (so a retry can claim it again) without recording a failure. */
async function release(applicationId: string): Promise<void> {
  await query(
    `UPDATE applications SET portfolio_analysis_status='pending', portfolio_started_at=NULL WHERE id=$1 AND portfolio_analysis_status='running'`,
    [applicationId],
  ).catch(() => {});
}

async function fail(applicationId: string, message: string): Promise<void> {
  await query(
    `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 WHERE id=$2`,
    [message.slice(0, 500), applicationId],
  ).catch(() => {});
}

/** Failures worth retrying: our infrastructure or a rate-limited/overloaded model, not a bad input. */
export function isTransient(err: unknown): boolean {
  if (err instanceof BrowserBusyError) return true;
  const e = err as { status?: number; message?: string; name?: string } | null;
  if (e?.status && [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(e.status)) return true;
  return /timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|Failed to launch|Target closed|overloaded|rate.?limit/i.test(e?.message || '');
}

function reviewedFromCapture(c: CapturedPortfolio): PortfolioReviewed {
  return {
    url: c.link.url, platform: c.link.platform, isPortfolio: true, belongsToCandidate: null,
    accessible: c.access === 'ok', accessKind: c.access, accessNote: c.accessNote,
    pagesReviewed: c.pages.length, pageTitles: c.pages.map(p => p.title).slice(0, 6), signals: c.signals,
  };
}

/**
 * `attempt` is the queue's delivery count (1-based). A transient failure on an
 * earlier attempt hands the job back and THROWS so the queue redelivers it; on
 * the last attempt (or a direct run) it is recorded as 'failed' instead.
 */
export async function runPortfolioAnalysis(applicationId: string, opts: { attempt?: number } = {}): Promise<RunResult> {
  const attempt = opts.attempt ?? MAX_ATTEMPTS;
  // Cheapest possible rejection: no database write at all when this instance is already busy.
  if (isBrowserInUse()) return { ran: false, status: 'busy', reason: 'browser in use by another review on this instance' };
  if (!(await claim(applicationId))) return { ran: false, reason: 'not claimable (already running, completed or settled)' };
  const startedAt = Date.now();

  const settleFailure = async (err: unknown, prefix: string): Promise<RunResult> => {
    if (isTransient(err) && attempt < MAX_ATTEMPTS) {
      await release(applicationId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    await fail(applicationId, `${prefix} — ${(err as Error)?.message ?? String(err)}. Use Re-run to retry.`);
    return { ran: true, status: 'failed' };
  };

  try {
    const app = await queryOne<Application>('SELECT * FROM applications WHERE id=$1', [applicationId]);
    if (!app) return { ran: false, reason: 'application not found' };
    const [candidate, role] = await Promise.all([
      queryOne<Candidate>('SELECT * FROM candidates WHERE id=$1', [app.candidate_id]),
      queryOne<Role>('SELECT * FROM roles WHERE id=$1', [app.role_id]),
    ]);
    if (!candidate || !role) { await fail(applicationId, 'Candidate or role not found'); return { ran: true, status: 'failed' }; }
    if (!role.portfolio_analysis_enabled) { await fail(applicationId, 'Portfolio review is not enabled for this role'); return { ran: true, status: 'failed' }; }

    const links = (app.portfolio_urls || []) as PortfolioLink[];
    if (!links.length) { await fail(applicationId, 'No portfolio links stored for this application'); return { ran: true, status: 'failed' }; }

    const captureDeadline = startedAt + TOTAL_BUDGET_MS - ANALYSIS_RESERVE_MS;
    let captured: CapturedPortfolio[];
    try {
      captured = await withBrowser(b => capturePortfolios(b, links, captureDeadline), { maxWaitMs: BUSY_WAIT_MS });
    } catch (err) {
      if (err instanceof BrowserBusyError) {
        // Lost a race for the browser after claiming. Not a failure and not an attempt used:
        // put the job back so the caller can re-queue it.
        await release(applicationId);
        return { ran: false, status: 'busy', reason: 'browser in use by another review on this instance' };
      }
      return await settleFailure(err, 'Could not start the browser');
    }

    // Every link is dead/private/unreadable-by-design → the candidate's problem
    // (held against them). If anything failed on OUR side, that is not a verdict.
    const ok = captured.filter(c => c.access === 'ok');
    const blocked = captured.filter(c => c.access === 'blocked');
    const errored = captured.filter(c => c.access === 'error');
    const skipped = captured.filter(c => c.access === 'skipped');

    if (!ok.length && errored.length) {
      return await settleFailure(new Error(`Could not open the portfolio (${errored[0].accessNote || 'unknown error'})`), 'Portfolio capture failed');
    }

    if (!ok.length) {
      // Only blocked / file-link portfolios. Nothing for a reviewer to look at.
      const reviewed = captured.map(reviewedFromCapture);
      const why = [...blocked, ...skipped].map(c => c.accessNote).filter(Boolean).join('; ');
      const onlyFiles = !blocked.length && skipped.length > 0;
      const analysis: PortfolioAnalysisResult = {
        version: 1, analyzedAt: new Date().toISOString(), model: 'none', portfolios: reviewed,
        criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
        modelScore: 0, checklistScore: 0, score: onlyFiles ? 3 : 1,
        scoreNote: onlyFiles ? 'Portfolio is a file/deck link' : 'Portfolio link not reachable',
        highlights: [],
        redFlags: [onlyFiles
          ? 'Portfolio is a PDF / slide-deck link that was not reviewed automatically — review it manually'
          : `Portfolio link not reviewable — ${why}`],
        summary: onlyFiles
          ? 'The only portfolio link is a file or slide deck, which is not opened automatically. Review it manually.'
          : 'The portfolio link(s) in the resume are private, dead or otherwise unreachable for an outside viewer.',
      };
      await applyPortfolioOutcome(applicationId, {
        status: 'inaccessible', score: analysis.score, note: analysis.scoreNote,
        oneLiner: analysis.summary, redFlags: analysis.redFlags, analysis,
        message: why || undefined,
      });
      return { ran: true, status: 'inaccessible' };
    }

    let analysis: PortfolioAnalysisResult;
    try {
      analysis = await analyzePortfolios(candidate, role, captured, { deadline: startedAt + TOTAL_BUDGET_MS });
    } catch (err) {
      return await settleFailure(err, 'Analysis failed');
    }
    const reviewedReal = analysis.portfolios.filter(p => p.accessible && p.isPortfolio && p.belongsToCandidate !== false);

    if (!reviewedReal.length) {
      // What we opened wasn't a design portfolio, or wasn't theirs. But if a
      // link ALSO failed on our side we can't say the candidate has no portfolio.
      if (errored.length) {
        return await settleFailure(new Error(`${errored.length} link(s) could not be opened (${errored[0].accessNote}) and the rest were not a usable portfolio`), 'Inconclusive review');
      }
      analysis.score = Math.min(analysis.score, 1);
      await applyPortfolioOutcome(applicationId, {
        status: 'no_portfolio', score: analysis.score, note: 'No usable portfolio found',
        oneLiner: analysis.summary || 'No usable design portfolio was found behind the links in the resume.',
        redFlags: analysis.redFlags, analysis,
        message: 'The links in the resume were not a design portfolio belonging to the candidate.',
      });
      return { ran: true, status: 'no_portfolio' };
    }

    await applyPortfolioOutcome(applicationId, {
      status: 'completed', score: analysis.score, note: analysis.scoreNote,
      oneLiner: analysis.summary, redFlags: analysis.redFlags, analysis,
      message: errored.length ? `${errored.length} of ${captured.length} portfolio links could not be opened (${errored[0].accessNote}).` : undefined,
    });
    return { ran: true, status: 'completed' };
  } catch (err) {
    console.error('[Portfolio] Analysis failed for', applicationId, err);
    return await settleFailure(err, 'Analysis failed');
  }
}
