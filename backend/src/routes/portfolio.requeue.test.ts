import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// requeue() in routes/portfolio.ts — HR's Re-run and the backfill's primitive — and the routes that call it, for
// the review that takes its links from the screening answer (the Head of Marketing work-sample review). The
// designer branch of requeue (links from the resume, 502 when Drive fails) is covered here only to prove it is
// untouched. The database, auth, Drive, link picking and the enqueue layer are mocked; the profile rules
// (profiles.ts), the stale-running threshold and the router itself are real.
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a) }));
vi.mock('../middleware/auth.js', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireHR: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const fetchResumeTextAndLinks = vi.fn();
vi.mock('../services/driveService.js', () => ({ fetchResumeTextAndLinks: (...a: unknown[]) => fetchResumeTextAndLinks(...a) }));
const pickPortfolioLinks = vi.fn();
vi.mock('../services/portfolio/links.js', () => ({ pickPortfolioLinks: (...a: unknown[]) => pickPortfolioLinks(...a) }));
const pickAnswerLinks = vi.fn();
vi.mock('../services/portfolio/answerLinks.js', () => ({ pickAnswerLinks: (...a: unknown[]) => pickAnswerLinks(...a) }));
const preparePortfolioReview = vi.fn();
const prepareMarketingReview = vi.fn();
vi.mock('../services/portfolio/enqueue.js', () => ({
  preparePortfolioReview: (...a: unknown[]) => preparePortfolioReview(...a),
  prepareMarketingReview: (...a: unknown[]) => prepareMarketingReview(...a),
}));

import router, { requeue, storedReviewKind } from './portfolio.js';
import { STALE_RUNNING_SECONDS } from '../services/portfolio/jobState.js';

// ─── fixtures ────────────────────────────────────────────────────────────────
const NOW = new Date('2026-10-22T10:00:00.000Z');
const SCREENING = [{ question: "Links to public resources/portfolio to highlight your past work?", answer: 'https://jane.design' }];
const SITE = { url: 'https://jane.design', host: 'jane.design', platform: 'custom', handler: 'site' };
const PICK = { answered: true, textOnly: false, claimText: 'https://jane.design', links: [SITE], listedNotReviewed: [] };
const RESUME_URL = 'https://drive.google.com/file/d/abc123/view';
const READABLE_TEXT = 'Jane Doe — Head of brand and growth, ten years of building brands for climate and water startups.';

const APP = {
  id: 'A0619', candidate_id: 'C1001', role_id: 'R019', score_avg: '7.4',
  portfolio_analysis_status: null, portfolio_started_at: null, screening_answers: SCREENING,
};
const CANDIDATE = { id: 'C1001', full_name: 'Jane Doe', resume_drive_link: RESUME_URL };
// The row GET /:id/portfolio-analysis selects (review_kind = the role's portfolio_review_kind, null without a role).
const GET_APP = {
  id: 'A0619', role_id: 'R019', portfolio_urls: null, portfolio_analysis_status: null, portfolio_analysis_error: null,
  portfolio_analyzed_at: null, score_portfolio: null, score_portfolio_note: null, review_kind: 'marketing_work',
};
const MARKETING = { id: 'R019', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' };
const DESIGNER = { id: 'R007', portfolio_analysis_enabled: true };

let app: Record<string, unknown> | null;
let role: Record<string, unknown> | null;
let candidate: Record<string, unknown> | null;
// What the GET route reads: the application row joined to its role's kind, and the stored review (null = none stored).
let getApp: Record<string, unknown> | null;
let storedRow: { analysis: Record<string, unknown> | null } | null;

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = { ...APP };
  role = { ...MARKETING };
  candidate = { ...CANDIDATE };
  getApp = { ...GET_APP };
  storedRow = null;
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockImplementation(async (s: string) => {
    const sql = norm(s);
    if (/^SELECT a\.id, a\.role_id, a\.portfolio_urls/.test(sql)) return getApp;
    if (/^SELECT analysis FROM portfolio_analyses/.test(sql)) return storedRow;
    if (/^SELECT \* FROM applications/.test(sql)) return app;
    if (/^SELECT \* FROM roles/.test(sql)) return role;
    if (/^SELECT id, portfolio_analysis_enabled, portfolio_review_kind FROM roles/.test(sql)) return role;
    if (/^SELECT \* FROM candidates/.test(sql)) return candidate;
    if (/count\(\*\)/.test(sql)) return { n: '2' };
    return null;
  });
  fetchResumeTextAndLinks.mockReset().mockResolvedValue({ text: READABLE_TEXT, links: [{ url: 'https://resume-link.example' }] });
  pickPortfolioLinks.mockReset().mockReturnValue([SITE]);
  pickAnswerLinks.mockReset().mockReturnValue(PICK);
  preparePortfolioReview.mockReset().mockResolvedValue({ status: 'pending', links: [SITE], queued: true });
  prepareMarketingReview.mockReset().mockResolvedValue({ status: 'pending', links: [SITE], queued: true });
});
afterEach(() => { vi.useRealTimers(); });

// ─── requeue: the guards come first, for both reviews ────────────────────────
describe('requeue — guards (the same for every review)', () => {
  it('unknown application → 404, and nothing else is looked at', async () => {
    app = null;
    expect(await requeue('A9999')).toStrictEqual({ ok: false, code: 404, error: 'Application not found' });
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  it('review switched off for the role → 400, whatever the kind says', async () => {
    for (const r of [null, { ...MARKETING, portfolio_analysis_enabled: false }, { ...MARKETING, portfolio_analysis_enabled: null }, { id: 'R003' }]) {
      role = r;
      expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 400, error: 'Portfolio review is not enabled for this role' });
    }
    expect(prepareMarketingReview).not.toHaveBeenCalled();
    expect(pickAnswerLinks).not.toHaveBeenCalled();
  });

  it('base scoring has not completed → 409', async () => {
    for (const score_avg of [null, undefined]) {
      app = { ...APP, score_avg };
      expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 409, error: 'Resume scoring has not completed for this application yet' });
    }
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  it('a review that is running right now → 409; one stuck past the point a live worker could hold it is fair game', async () => {
    app = { ...APP, portfolio_analysis_status: 'running', portfolio_started_at: new Date(NOW.getTime() - 10_000).toISOString() };
    expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 409, error: 'A portfolio review is already running' });
    expect(prepareMarketingReview).not.toHaveBeenCalled();

    app = { ...APP, portfolio_analysis_status: 'running', portfolio_started_at: new Date(NOW.getTime() - (STALE_RUNNING_SECONDS * 1000 - 1)).toISOString() };
    expect((await requeue('A0619')).ok).toBe(false);

    app = { ...APP, portfolio_analysis_status: 'running', portfolio_started_at: new Date(NOW.getTime() - STALE_RUNNING_SECONDS * 1000).toISOString() };
    expect((await requeue('A0619')).ok).toBe(true);
    expect(prepareMarketingReview).toHaveBeenCalledTimes(1);
  });

  it('candidate missing → 404, after the other guards', async () => {
    candidate = null;
    expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 404, error: 'Candidate not found' });
    expect(prepareMarketingReview).not.toHaveBeenCalled();
    expect(preparePortfolioReview).not.toHaveBeenCalled();
  });
});

// ─── requeue: the work-sample review ─────────────────────────────────────────
describe('requeue — a role whose links come from the screening answer', () => {
  it('picks the links from the stored answers with the candidate name and prepares the review', async () => {
    const r = await requeue('A0619');

    expect(pickAnswerLinks).toHaveBeenCalledTimes(1);
    expect(pickAnswerLinks.mock.calls[0][0]).toBe(SCREENING);
    expect(pickAnswerLinks.mock.calls[0][1]).toStrictEqual({ candidateName: 'Jane Doe' });
    expect(prepareMarketingReview).toHaveBeenCalledTimes(1);
    expect(prepareMarketingReview.mock.calls[0][0]).toStrictEqual({ applicationId: 'A0619', pick: PICK });
    expect(prepareMarketingReview.mock.calls[0][0].pick).toBe(PICK);

    expect(r).toStrictEqual({ ok: true, status: 'pending', links: 1, queued: true });
  });

  it('needs no Drive read: the resume is never fetched, so a Drive outage cannot block or 502 a re-run', async () => {
    fetchResumeTextAndLinks.mockRejectedValue(new Error('drive down'));
    expect((await requeue('A0619')).ok).toBe(true);
    candidate = { ...CANDIDATE, resume_drive_link: null };
    expect((await requeue('A0619')).ok).toBe(true);
    expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
    expect(pickPortfolioLinks).not.toHaveBeenCalled();
    expect(preparePortfolioReview).not.toHaveBeenCalled();
  });

  describe('what prepareMarketingReview returns is passed on', () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['pending, queued',          { status: 'pending', links: [SITE, SITE], queued: true },  { ok: true, status: 'pending', links: 2, queued: true }],
      ['pending, queue refused it', { status: 'pending', links: [SITE], queued: false },       { ok: true, status: 'pending', links: 1, queued: false }],
      ['no_portfolio',             { status: 'no_portfolio', links: [], queued: false },       { ok: true, status: 'no_portfolio', links: 0, queued: false }],
      ['unreviewable',             { status: 'unreviewable', links: [], queued: false },       { ok: true, status: 'unreviewable', links: 0, queued: false }],
      ['failed (earlier review kept)', { status: 'failed', links: [], queued: false },         { ok: true, status: 'failed', links: 0, queued: false }],
    ];
    for (const [name, prepared, expected] of cases) {
      it(name, async () => {
        prepareMarketingReview.mockResolvedValue(prepared);
        expect(await requeue('A0619')).toStrictEqual(expected);
      });
    }

    it("'busy' (a live worker took the row between the check and the reset) → 409", async () => {
      prepareMarketingReview.mockResolvedValue({ status: 'busy', links: [SITE], queued: false });
      expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 409, error: 'A portfolio review is already running' });
    });
  });

  it('a throwing prepare propagates (the route layer answers 500; the backfill records the row as an error)', async () => {
    prepareMarketingReview.mockRejectedValue(new Error('db down'));
    await expect(requeue('A0619')).rejects.toThrow('db down');
  });
});

// ─── requeue: the designer review is untouched ───────────────────────────────
describe('requeue — the designer review still reads the resume', () => {
  beforeEach(() => { role = { ...DESIGNER }; });

  it('reads the resume, picks at most 3 links with the candidate name and prepares the designer review', async () => {
    const r = await requeue('A0619');
    expect(fetchResumeTextAndLinks).toHaveBeenCalledTimes(1);
    expect(fetchResumeTextAndLinks).toHaveBeenCalledWith(RESUME_URL);
    expect(pickPortfolioLinks).toHaveBeenCalledWith([{ url: 'https://resume-link.example' }], 3, { candidateName: 'Jane Doe' });
    expect(preparePortfolioReview).toHaveBeenCalledWith({ applicationId: 'A0619', links: [SITE], resumeRead: true });
    expect(prepareMarketingReview).not.toHaveBeenCalled();
    expect(pickAnswerLinks).not.toHaveBeenCalled();
    expect(r).toStrictEqual({ ok: true, status: 'pending', links: 1, queued: true });
  });

  it('a resume that cannot be read right now → 502 and nothing is changed', async () => {
    fetchResumeTextAndLinks.mockResolvedValue({ text: null, links: [] });
    expect(await requeue('A0619')).toStrictEqual({
      ok: false, code: 502, error: 'The resume could not be read right now — nothing was changed. Try again shortly.',
    });
    fetchResumeTextAndLinks.mockResolvedValue({ text: READABLE_TEXT, links: [], linksError: true });
    expect((await requeue('A0619')).ok).toBe(false);
    expect(preparePortfolioReview).not.toHaveBeenCalled();
  });

  it("'busy' → 409", async () => {
    preparePortfolioReview.mockResolvedValue({ status: 'busy', links: [SITE], queued: false });
    expect(await requeue('A0619')).toStrictEqual({ ok: false, code: 409, error: 'A portfolio review is already running' });
  });

  it('a flagged role with an unknown kind is a designer role, never a work-sample one', async () => {
    role = { ...DESIGNER, portfolio_review_kind: 'astrology' };
    await requeue('A0619');
    expect(fetchResumeTextAndLinks).toHaveBeenCalledTimes(1);
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });
});

// ─── through the router ──────────────────────────────────────────────────────
describe('the routes that call requeue', () => {
  let server: http.Server;
  let base = '';
  const savedSecret = process.env.ROLE_INGEST_SECRET;

  beforeAll(async () => {
    process.env.ROLE_INGEST_SECRET = 'test-secret';
    const api = express();
    api.use(express.json());
    api.use('/api/applications', router);
    server = http.createServer(api);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (savedSecret === undefined) delete process.env.ROLE_INGEST_SECRET; else process.env.ROLE_INGEST_SECRET = savedSecret;
  });

  // The fake clock above only fakes Date, so real sockets still work.
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("Re-run answers 202 with what was prepared: status, number of links, whether it was queued", async () => {
    prepareMarketingReview.mockResolvedValue({ status: 'unreviewable', links: [], queued: false });
    const res = await post('/api/applications/A0619/portfolio-analysis');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'unreviewable', links: 0, queued: false });
  });

  it('Re-run maps the guard failures to their status codes', async () => {
    role = { ...MARKETING, portfolio_analysis_enabled: false };
    expect((await post('/api/applications/A0619/portfolio-analysis')).status).toBe(400);
    role = { ...MARKETING };
    prepareMarketingReview.mockResolvedValue({ status: 'busy', links: [SITE], queued: false });
    const busy = await post('/api/applications/A0619/portfolio-analysis');
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'A portfolio review is already running' });
  });

  it('the backfill refuses without the shared secret', async () => {
    expect((await post('/api/applications/portfolio-backfill', { role_id: 'R019' })).status).toBe(401);
    expect((await post('/api/applications/portfolio-backfill', { role_id: 'R019' }, { 'x-ingest-secret': 'wrong' })).status).toBe(401);
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  it('the backfill of a work-sample role queues each application from its answer, with no Drive read, and keeps its response shape', async () => {
    query.mockResolvedValue([{ id: 'A0619' }, { id: 'A0620' }]);
    prepareMarketingReview
      .mockResolvedValueOnce({ status: 'pending', links: [SITE], queued: true })
      .mockResolvedValueOnce({ status: 'no_portfolio', links: [], queued: false });

    const res = await post('/api/applications/portfolio-backfill', { role_id: 'R019', limit: 2 }, { 'x-ingest-secret': 'test-secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      remaining_before: 2,
      processed: 2,
      left_unchanged: 0,
      dry_run: false,
      results: [
        { id: 'A0619', status: 'pending', links: 1, queued: true },
        { id: 'A0620', status: 'no_portfolio', links: 0, queued: false },
      ],
      next_offset: 0,                   // the same offset again: a processed row leaves the never-reviewed set
    });
    expect(prepareMarketingReview).toHaveBeenCalledTimes(2);
    expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
  });

  it('the backfill steps over a row it could not queue (a 409) so a caller looping on next_offset cannot spin', async () => {
    query.mockResolvedValue([{ id: 'A0619' }, { id: 'A0620' }]);
    prepareMarketingReview
      .mockResolvedValueOnce({ status: 'busy', links: [SITE], queued: false })
      .mockResolvedValueOnce({ status: 'pending', links: [SITE], queued: true });
    const res = await post('/api/applications/portfolio-backfill', { role_id: 'R019', limit: 2 }, { 'x-ingest-secret': 'test-secret' });
    const body = await res.json() as { processed: number; left_unchanged: number; next_offset: number | null; results: Array<{ status: string }> };
    expect(body.results.map(r => r.status)).toEqual(['skipped', 'pending']);
    expect(body.processed).toBe(1);
    expect(body.left_unchanged).toBe(1);
    expect(body.next_offset).toBe(1);
  });

  it('the backfill still refuses a role without portfolio review', async () => {
    role = { ...MARKETING, portfolio_analysis_enabled: false };
    const res = await post('/api/applications/portfolio-backfill', { role_id: 'R019' }, { 'x-ingest-secret': 'test-secret' });
    expect(res.status).toBe(400);
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  // ─── GET: which review is this (kind) ──────────────────────────────────────
  describe('GET /:id/portfolio-analysis — kind', () => {
    const get = async (id = 'A0619') => {
      const res = await fetch(`${base}/api/applications/${id}/portfolio-analysis`);
      return { code: res.status, body: await res.json() as Record<string, unknown> };
    };
    const STORED_MARKETING = { version: 1, kind: 'marketing_work', model: 'claude-sonnet-4-5', summary: 'S' };
    const STORED_DESIGNER  = { version: 1, kind: 'design_portfolio', model: 'claude-sonnet-4-5', summary: 'S' };
    const { kind: _kind, ...STORED_LEGACY } = STORED_DESIGNER;        // made before kinds existed: no `kind` at all

    it('a stored review names its own kind, whatever the role says now', async () => {
      getApp = { ...GET_APP, review_kind: 'design_portfolio' };
      storedRow = { analysis: STORED_MARKETING };
      expect((await get()).body.kind).toBe('marketing_work');

      getApp = { ...GET_APP, review_kind: 'marketing_work' };
      storedRow = { analysis: STORED_DESIGNER };
      expect((await get()).body.kind).toBe('design_portfolio');
    });

    it('a stored review WITHOUT a kind is a designer review even when the role was switched to marketing_work later', async () => {
      // This is the regression: the old code fell through to the ROLE's kind, so an old designer review was reported
      // as 'marketing_work' and the card drew marketing copy over 15 designer criteria.
      getApp = { ...GET_APP, review_kind: 'marketing_work' };
      storedRow = { analysis: STORED_LEGACY };
      const { code, body } = await get();
      expect(code).toBe(200);
      expect(body.kind).toBe('design_portfolio');
      expect(body.analysis).toEqual(STORED_LEGACY);          // the review itself is passed on untouched, no kind added
    });

    it('a stored kind that is not one of the two (unknown string, number, null, object) counts as no kind: designer', async () => {
      getApp = { ...GET_APP, review_kind: 'marketing_work' };
      for (const bad of ['astrology', '', 'MARKETING_WORK', 7, null, {}, ['marketing_work']]) {
        storedRow = { analysis: { ...STORED_LEGACY, kind: bad } };
        expect((await get()).body.kind, JSON.stringify(bad)).toBe('design_portfolio');
      }
    });

    it('an empty stored review is still a stored review: designer, not the role\'s kind', async () => {
      getApp = { ...GET_APP, review_kind: 'marketing_work' };
      storedRow = { analysis: {} };
      expect((await get()).body.kind).toBe('design_portfolio');
    });

    it('before any review is stored the ROLE\'s kind says which one is on its way', async () => {
      storedRow = null;
      for (const [review_kind, kind] of [
        ['marketing_work', 'marketing_work'],
        ['design_portfolio', 'design_portfolio'],
        [null, 'design_portfolio'],                       // no role row at all (LEFT JOIN)
        ['astrology', 'design_portfolio'],                // unreadable kind on the role
      ] as const) {
        getApp = { ...GET_APP, review_kind };
        const { code, body } = await get();
        expect(code).toBe(200);
        expect(body.kind, String(review_kind)).toBe(kind);
        expect(body.analysis).toBeNull();
      }
    });

    it('keeps the rest of the response as it was: status, message, urls, analyzed_at, score, note, analysis', async () => {
      const links = [SITE];
      getApp = {
        ...GET_APP, portfolio_urls: links, portfolio_analysis_status: 'completed', portfolio_analysis_error: 'msg',
        portfolio_analyzed_at: '2026-10-22T09:00:00.000Z', score_portfolio: 7, score_portfolio_note: 'note',
      };
      storedRow = { analysis: STORED_MARKETING };
      expect(await get()).toEqual({
        code: 200,
        body: {
          kind: 'marketing_work', status: 'completed', message: 'msg', urls: links, analyzed_at: '2026-10-22T09:00:00.000Z',
          score: 7, note: 'note', analysis: STORED_MARKETING,
        },
      });
    });

    it('an application with nothing recorded yet answers nulls (urls: [])', async () => {
      expect((await get()).body).toEqual({
        kind: 'marketing_work', status: null, message: null, urls: [], analyzed_at: null, score: null, note: null, analysis: null,
      });
    });

    it('unknown application → 404 and the stored review is never read', async () => {
      getApp = null;
      const { code, body } = await get('A9999');
      expect(code).toBe(404);
      expect(body).toEqual({ error: 'Application not found' });
      expect(queryOne.mock.calls.some(c => /portfolio_analyses/.test(String(c[0])))).toBe(false);
    });
  });
});

// ─── storedReviewKind (the rule behind GET's `kind`) ─────────────────────────
describe('storedReviewKind', () => {
  const MARKETING_KIND = 'marketing_work';
  const DESIGNER_KIND = 'design_portfolio';

  it('a stored review with a valid kind: that kind, never the role\'s', () => {
    expect(storedReviewKind({ analysis: { kind: MARKETING_KIND } }, DESIGNER_KIND)).toBe(MARKETING_KIND);
    expect(storedReviewKind({ analysis: { kind: DESIGNER_KIND } }, MARKETING_KIND)).toBe(DESIGNER_KIND);
  });

  it('a stored review without a valid kind: designer, whatever the role says', () => {
    for (const roleKind of [MARKETING_KIND, DESIGNER_KIND, null, undefined, 'astrology']) {
      expect(storedReviewKind({ analysis: {} }, roleKind)).toBe(DESIGNER_KIND);
      expect(storedReviewKind({ analysis: { kind: 'astrology' } }, roleKind)).toBe(DESIGNER_KIND);
      expect(storedReviewKind({ analysis: { kind: undefined } }, roleKind)).toBe(DESIGNER_KIND);
      expect(storedReviewKind({ analysis: null }, roleKind)).toBe(DESIGNER_KIND);
    }
  });

  it('no stored review: the role\'s kind when valid, else designer', () => {
    for (const none of [null, undefined]) {
      expect(storedReviewKind(none, MARKETING_KIND)).toBe(MARKETING_KIND);
      expect(storedReviewKind(none, DESIGNER_KIND)).toBe(DESIGNER_KIND);
      expect(storedReviewKind(none, null)).toBe(DESIGNER_KIND);
      expect(storedReviewKind(none, undefined)).toBe(DESIGNER_KIND);
      expect(storedReviewKind(none, 'astrology')).toBe(DESIGNER_KIND);
      expect(storedReviewKind(none, 42)).toBe(DESIGNER_KIND);
    }
  });
});
