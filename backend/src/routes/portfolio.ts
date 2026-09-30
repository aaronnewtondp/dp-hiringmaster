import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';
import { Application, Candidate, Role } from '../types/index.js';
import { fetchResumeTextAndLinks } from '../services/driveService.js';
import { pickPortfolioLinks } from '../services/portfolio/links.js';
import { preparePortfolioReview } from '../services/portfolio/enqueue.js';
import { STALE_RUNNING_SECONDS } from '../services/portfolio/jobState.js';

// Mounted at /api/applications, ahead of applicationsRouter. Auth is applied
// per route (not router-wide) because the batch endpoint is secret-protected
// instead of user-authenticated, like the other machine-facing routes.
const router = Router();

/**
 * Re-reads the resume for portfolio links and (re)queues the review. This is
 * both the manual "Re-run" action and the backfill primitive — re-extracting
 * each time means a link the first extraction missed can be picked up.
 */
async function requeue(applicationId: string): Promise<
  { ok: true; status: string; links: number; queued: boolean } | { ok: false; code: number; error: string }
> {
  const app = await queryOne<Application>('SELECT * FROM applications WHERE id=$1', [applicationId]);
  if (!app) return { ok: false, code: 404, error: 'Application not found' };
  const role = await queryOne<Role>('SELECT * FROM roles WHERE id=$1', [app.role_id]);
  if (!role?.portfolio_analysis_enabled) return { ok: false, code: 400, error: 'Portfolio review is not enabled for this role' };
  if (app.score_avg == null) return { ok: false, code: 409, error: 'Resume scoring has not completed for this application yet' };
  // 'running' only counts while the job could still be alive — a row stuck
  // there past the function's hard limit belongs to a killed job and is fair game.
  const startedMs = app.portfolio_started_at ? new Date(app.portfolio_started_at).getTime() : 0;
  if (app.portfolio_analysis_status === 'running' && Date.now() - startedMs < STALE_RUNNING_SECONDS * 1000) {
    return { ok: false, code: 409, error: 'A portfolio review is already running' };
  }

  const candidate = await queryOne<Candidate>('SELECT * FROM candidates WHERE id=$1', [app.candidate_id]);
  if (!candidate) return { ok: false, code: 404, error: 'Candidate not found' };

  let links: ReturnType<typeof pickPortfolioLinks> = [];
  let resumeRead = false;
  if (candidate.resume_drive_link) {
    const fetched = await fetchResumeTextAndLinks(candidate.resume_drive_link);
    // A transient Drive failure must not be mistaken for "this resume has no
    // portfolio": that would wipe the stored links and turn a good review into
    // 'no_portfolio' while the old score stayed in the average. Change nothing.
    if (fetched.text == null || fetched.linksError) {
      return { ok: false, code: 502, error: 'The resume could not be read right now — nothing was changed. Try again shortly.' };
    }
    resumeRead = true;
    links = pickPortfolioLinks(fetched.links, 3, { candidateName: candidate.full_name });
  }
  const prepared = await preparePortfolioReview({ applicationId, links, resumeRead });
  if (prepared.status === 'busy') return { ok: false, code: 409, error: 'A portfolio review is already running' };
  return { ok: true, status: prepared.status, links: prepared.links.length, queued: prepared.queued };
}

// GET — the review for one application (any signed-in user; it contains no
// compensation data, so it follows the same visibility as the score itself).
router.get('/:id/portfolio-analysis', authenticate, async (req: Request, res: Response) => {
  const app = await queryOne<Application>(
    `SELECT id, role_id, portfolio_urls, portfolio_analysis_status, portfolio_analysis_error,
            portfolio_analyzed_at, score_portfolio, score_portfolio_note
     FROM applications WHERE id=$1`, [req.params.id]);
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }
  const row = await queryOne<{ analysis: unknown }>('SELECT analysis FROM portfolio_analyses WHERE application_id=$1', [req.params.id]);
  res.json({
    status:      app.portfolio_analysis_status ?? null,
    message:     app.portfolio_analysis_error ?? null,
    urls:        app.portfolio_urls ?? [],
    analyzed_at: app.portfolio_analyzed_at ?? null,
    score:       app.score_portfolio ?? null,
    note:        app.score_portfolio_note ?? null,
    analysis:    row?.analysis ?? null,
  });
});

// POST — HR re-runs the review (re-extracts the links, queues the job).
router.post('/:id/portfolio-analysis', authenticate, requireHR, async (req: Request, res: Response) => {
  const r = await requeue(req.params.id);
  if (!r.ok) { res.status(r.code).json({ error: r.error }); return; }
  res.status(202).json({ status: r.status, links: r.links, queued: r.queued });
});

// POST — batch (re)queue for a role, protected by the shared ingest secret.
// Processes a small page per call (each application re-reads a resume from
// Drive) so a call stays well inside the 60s function limit; callers loop on
// `next_offset` until it is null.
router.post('/portfolio-backfill', async (req: Request, res: Response) => {
  const secret = process.env.ROLE_INGEST_SECRET;
  if (!secret || req.headers['x-ingest-secret'] !== secret) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const roleId  = String(req.body?.role_id || '');
  const statuses: string[] = Array.isArray(req.body?.statuses) && req.body.statuses.length ? req.body.statuses : ['Active'];
  const limit   = Math.min(Math.max(parseInt(String(req.body?.limit ?? '6'), 10) || 6, 1), 10);
  const offset  = Math.max(parseInt(String(req.body?.offset ?? '0'), 10) || 0, 0);
  const dryRun  = req.body?.dry_run === true;
  if (!roleId) { res.status(400).json({ error: 'role_id required' }); return; }
  const role = await queryOne<Role>('SELECT id, portfolio_analysis_enabled FROM roles WHERE id=$1', [roleId]);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  if (!role.portfolio_analysis_enabled) { res.status(400).json({ error: 'Portfolio review is not enabled for this role' }); return; }

  // Only applications that have never been through portfolio review.
  const rows = await query<{ id: string }>(
    `SELECT id FROM applications
     WHERE role_id=$1 AND status = ANY($2::text[]) AND score_avg IS NOT NULL AND portfolio_analysis_status IS NULL
     ORDER BY id LIMIT $3 OFFSET $4`,
    [roleId, statuses, limit, offset],
  );
  const total = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM applications
     WHERE role_id=$1 AND status = ANY($2::text[]) AND score_avg IS NOT NULL AND portfolio_analysis_status IS NULL`,
    [roleId, statuses],
  );

  const results: Array<{ id: string; status: string; links?: number; queued?: boolean; error?: string }> = [];
  if (!dryRun) {
    for (const row of rows) {
      try {
        const r = await requeue(row.id);
        results.push(r.ok ? { id: row.id, status: r.status, links: r.links, queued: r.queued } : { id: row.id, status: 'skipped', error: r.error });
      } catch (err) {
        results.push({ id: row.id, status: 'error', error: (err as Error).message.slice(0, 120) });
      }
    }
  }
  // The eligibility filter (status IS NULL) shrinks as rows are settled, so the
  // next page starts at the same offset — EXCEPT for rows that stayed NULL
  // (skipped, errored, or a transient 502): those must be stepped over or a
  // caller looping on next_offset would fetch the same rows forever.
  const stayedEligible = dryRun ? rows.length : results.filter(r => r.status === 'skipped' || r.status === 'error').length;
  res.json({
    remaining_before: parseInt(total?.n || '0', 10),
    processed: dryRun ? 0 : results.length - stayedEligible,
    left_unchanged: stayedEligible,
    dry_run: dryRun,
    results,
    next_offset: rows.length === limit ? offset + stayedEligible : null,
  });
});

export default router;
