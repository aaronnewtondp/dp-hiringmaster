import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Acquired } from './acquire/types.js';
import type { CapturedPortfolio } from './capture.js';
import type { PortfolioAnalysisResult, PortfolioLink, PortfolioSignals } from './types.js';
import { MARKETING_CRITERIA } from './rubric.marketing.js';

// run.ts decides WHICH review a job gets (by the role's review profile) and hands marketing jobs to run.marketing.ts
// inside its own try/catch, with its own failure handling. Here run.ts and run.marketing.ts are both REAL; the
// database is a recording stub and browser, capture, the fetchers, both model calls and scoring are mocks.
// (The designer flow itself is pinned by run.test.ts / run.busy.test.ts, the marketing decisions by run.marketing.test.ts.)
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a), transaction: vi.fn() }));

const browser = { inUse: vi.fn(), withBrowser: vi.fn() };
vi.mock('./browser.js', async () => {
  const actual = await vi.importActual<typeof import('./browser.js')>('./browser.js');
  return {
    ...actual,
    isBrowserInUse: () => browser.inUse(),
    withBrowser: (...a: unknown[]) => browser.withBrowser(...a),
  };
});
vi.mock('./capture.js', async () => {
  const actual = await vi.importActual<typeof import('./capture.js')>('./capture.js');
  return { ...actual, capturePortfolios: vi.fn() };
});
vi.mock('./analyze.js', () => ({ analyzePortfolios: vi.fn() }));
vi.mock('./analyze.marketing.js', () => ({
  analyzeMarketing: vi.fn(),
  reviewedFromAcquired: (a: Acquired) => ({
    url: a.link.url, platform: a.link.platform, isPortfolio: true, belongsToCandidate: null, accessible: a.outcome === 'ok' || a.outcome === 'partial',
    pagesReviewed: 0, pageTitles: [], signals: SIGNALS, ref: a.ref, outcome: a.outcome,
  }),
}));
vi.mock('./acquire/index.js', async () => {
  const actual = await vi.importActual<typeof import('./acquire/index.js')>('./acquire/index.js');
  return { ...actual, acquireFetchItems: vi.fn() };
});
vi.mock('./acquire/fetchers.js', () => ({ defaultFetchers: {} }));
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: vi.fn() }));

import { BrowserBusyError } from './browser.js';
import { MARKETING_CAPTURE_OPTS, capturePortfolios } from './capture.js';
import { acquireFetchItems } from './acquire/index.js';
import { analyzePortfolios } from './analyze.js';
import { analyzeMarketing } from './analyze.marketing.js';
import { applyPortfolioOutcome } from './scoring.js';
import * as marketing from './run.marketing.js';
import { BUSY_WAIT_MS, MAX_ATTEMPTS, TOTAL_BUDGET_MS, runPortfolioAnalysis } from './run.js';

// ── fixtures ────────────────────────────────────────────────────────────────
const APP_ID = 'A0900';
const NOW = '2026-10-22T10:00:00.000Z';
const T0 = Date.parse(NOW);
const FAKE_BROWSER = { fake: 'browser' };
const SIGNALS: PortfolioSignals = {
  brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0,
  failedRequests: 0, mobileOverflow: null, loadMs: null, truncated: false,
};

const DOC:  PortfolioLink = { url: 'https://drive.google.com/file/d/1AbCdEfGhIjK/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' };
const SITE: PortfolioLink = { url: 'https://brand.example/work', host: 'brand.example', platform: 'custom', handler: 'site' };
const RESUME_LINK: PortfolioLink = { url: 'https://x.example', host: 'x.example', platform: 'custom' };

const CANDIDATE = { id: 'C1', full_name: 'Jane Doe' };
const MARKETING_ROLE = { id: 'R019', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' };
const DESIGN_ROLE    = { id: 'R007', portfolio_analysis_enabled: true, portfolio_review_kind: 'design_portfolio' };
const MARKETING_PROFILE = { kind: 'marketing_work', source: 'screening', unreachable: 'unscored', noEvidence: 'unscored', foldPolicy: 'always' };

const acq = (ref: string, l: PortfolioLink, over: Partial<Acquired> = {}): Acquired => ({
  ref, link: l, outcome: 'ok', basis: 'artifact', media: [], text: 'Campaign deck: six launches, with results.', facts: [], injectionHit: false, ...over,
});
const refused = (ref: string, l: PortfolioLink, outcome: 'inaccessible' | 'failed' | 'unreviewable', reason: string): Acquired =>
  acq(ref, l, { outcome, text: '', reason });
const captured = (l: PortfolioLink): CapturedPortfolio => ({
  link: l, access: 'ok', signals: SIGNALS,
  pages: [{ url: l.url, title: 'Home', text: 'We built the brand from zero.', shots: [{ label: 'home', data: 'QUJD' }] }],
});
// A review in which the model was SHOWN both links: the analyzer records a coverage for exactly those, and the run layer scores
// only what the model saw (a review whose analysis shows it nothing is never recorded as completed).
const shownLink = (ref: string, l: PortfolioLink): PortfolioAnalysisResult['portfolios'][number] => ({
  url: l.url, platform: l.platform, isPortfolio: true, belongsToCandidate: null, accessible: true, pagesReviewed: 0, pageTitles: [],
  signals: SIGNALS, ref, outcome: 'ok', coverage: 'full',
});
const marketingAnalysis = (): PortfolioAnalysisResult => ({
  version: 1, kind: 'marketing_work', analyzedAt: '2026-10-22T09:59:00.000Z', model: 'claude-sonnet-4-5', portfolios: [shownLink('L1', DOC), shownLink('L2', SITE)],
  // all 15 criteria, assessable: a review in which nothing the work can show could be assessed is settled as unreviewable, not completed
  criteria: MARKETING_CRITERIA.map(c => ({ id: c.id, label: c.label, verdict: 'partial' as const, evidence: 'Shown', group: c.group, weight: c.weight, basis: 'seen' as const, source: 'L1', assessable: true })),
  jdAlignment: { mustHaves: [], niceToHaves: [] },
  modelScore: 7, checklistScore: 7, score: 7, scoreNote: 'Strong campaigns', highlights: [], redFlags: ['rf'], summary: 'A summary.',
});

// ── the SQL run.ts itself issues (whitespace-normalised) ───────────────────
const SQL_RELEASE = "UPDATE applications SET portfolio_analysis_status='pending', portfolio_started_at=NULL WHERE id=$1 AND portfolio_analysis_status='running'";
const SQL_FAIL = "UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 WHERE id=$2";
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const writes = () => query.mock.calls.map(c => ({ sql: norm(c[0]), params: c[1] as unknown[] }));
const releases = () => writes().filter(w => w.sql === SQL_RELEASE);
const failMessages = () => writes().filter(w => w.sql === SQL_FAIL).map(w => w.params[0] as string);

const run = (attempt?: number) => runPortfolioAnalysis(APP_ID, attempt === undefined ? {} : { attempt });

// The REAL run.marketing.ts, seen through a spy that calls straight through, so what run.ts hands it can be looked at.
let runMarketingReview: MockInstance<typeof marketing.runMarketingReview>;

let db: { app: Record<string, unknown> | null; candidate: unknown; role: unknown };
let errorSpy: ReturnType<typeof vi.spyOn>;

const marketingApp = (over: Record<string, unknown> = {}) => ({
  id: APP_ID, candidate_id: 'C1', role_id: 'R019', portfolio_urls: [DOC, SITE], score_portfolio: null,
  screening_answers: [{ question: 'Links to public resources/portfolio to highlight your past work?', answer: `${DOC.url} ${SITE.url}` }],
  ...over,
});
const fetchGives = (make: (items: Array<{ link: PortfolioLink; ref: string }>) => Acquired[]) =>
  vi.mocked(acquireFetchItems).mockImplementation(async items => make(items));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  db = { app: marketingApp(), candidate: CANDIDATE, role: MARKETING_ROLE };
  query.mockReset().mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) ? [{ id: APP_ID }] : []));   // the claim succeeds
  queryOne.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM applications/.test(sql)) return db.app;
    if (/FROM candidates/.test(sql)) return db.candidate;
    if (/FROM roles/.test(sql)) return db.role;
    return null;
  });
  browser.inUse.mockReset().mockReturnValue(false);
  browser.withBrowser.mockReset().mockImplementation(async (cb: (b: unknown) => unknown) => cb(FAKE_BROWSER));
  vi.mocked(capturePortfolios).mockReset().mockImplementation(async (_b, links) => links.map(captured));
  vi.mocked(analyzePortfolios).mockReset().mockResolvedValue({ ...marketingAnalysis(), kind: undefined, portfolios: [{ url: RESUME_LINK.url, platform: 'custom', isPortfolio: true, belongsToCandidate: true, accessible: true, accessKind: 'ok', pagesReviewed: 1, pageTitles: [], signals: SIGNALS }] });
  vi.mocked(analyzeMarketing).mockReset().mockResolvedValue(marketingAnalysis());
  vi.mocked(acquireFetchItems).mockReset();
  fetchGives(items => items.map(i => acq(i.ref, i.link)));
  vi.mocked(applyPortfolioOutcome).mockReset().mockResolvedValue({ avg: null });
  runMarketingReview = vi.spyOn(marketing, 'runMarketingReview');
});

afterEach(() => {
  runMarketingReview.mockRestore();
  errorSpy.mockRestore();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
describe('run.ts hands the job to the review its role\'s profile names', () => {
  it('a marketing role goes to runMarketingReview, with everything it needs and run.ts\'s own failure handling', async () => {
    runMarketingReview.mockResolvedValueOnce({ ran: true, status: 'completed' });
    const r = await run(2);
    expect(r).toEqual({ ran: true, status: 'completed' });
    expect(runMarketingReview).toHaveBeenCalledTimes(1);
    const ctx = runMarketingReview.mock.calls[0][0];
    expect(ctx.applicationId).toBe(APP_ID);
    expect(ctx.app).toBe(db.app);
    expect(ctx.candidate).toBe(db.candidate);
    expect(ctx.role).toBe(db.role);
    expect(ctx.profile).toEqual(MARKETING_PROFILE);
    expect(ctx.startedAt).toBe(T0);
    expect(ctx.attempt).toBe(2);
    expect(ctx.settleFailure).toBeTypeOf('function');
    expect(ctx.release).toBeTypeOf('function');
  });

  it('a direct run (no attempt given) is the last attempt, as for the designer', async () => {
    runMarketingReview.mockResolvedValueOnce({ ran: true, status: 'completed' });
    await run();
    expect(runMarketingReview.mock.calls[0][0].attempt).toBe(MAX_ATTEMPTS);
  });

  it('the marketing flow never touches the designer\'s capture-and-analyse steps', async () => {
    await run(1);
    expect(analyzePortfolios).not.toHaveBeenCalled();
    expect(analyzeMarketing).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['design_portfolio', DESIGN_ROLE],
    ['no kind recorded at all', { id: 'R007', portfolio_analysis_enabled: true }],
    ['a kind nobody has heard of', { id: 'R007', portfolio_analysis_enabled: true, portfolio_review_kind: 'banana' }],
  ])('a role with %s takes the designer flow, unchanged', async (_name, role) => {
    db = { app: { id: APP_ID, candidate_id: 'C1', role_id: 'R007', portfolio_urls: [RESUME_LINK] }, candidate: CANDIDATE, role };
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'completed' });
    expect(runMarketingReview).not.toHaveBeenCalled();
    expect(analyzeMarketing).not.toHaveBeenCalled();
    expect(acquireFetchItems).not.toHaveBeenCalled();
    // the designer's own calls, exactly as before: three-argument capture (no marketing options), two-argument scoring
    expect(capturePortfolios).toHaveBeenCalledWith(FAKE_BROWSER, [RESUME_LINK], T0 + TOTAL_BUDGET_MS - 75_000);
    expect(vi.mocked(capturePortfolios).mock.calls[0]).toHaveLength(3);
    expect(analyzePortfolios).toHaveBeenCalledTimes(1);
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyPortfolioOutcome).mock.calls[0]).toHaveLength(2);
  });

  it('a role with review switched off is refused before any flow starts, whatever its kind', async () => {
    db.role = { ...MARKETING_ROLE, portfolio_analysis_enabled: false };
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Portfolio review is not enabled for this role']);
    expect(runMarketingReview).not.toHaveBeenCalled();
    expect(browser.withBrowser).not.toHaveBeenCalled();
  });

  it('a missing candidate or role is refused before any flow starts', async () => {
    db.candidate = null;
    expect(await run(1)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Candidate or role not found']);
    expect(runMarketingReview).not.toHaveBeenCalled();
  });

  it('a job that cannot be claimed never reaches the marketing flow', async () => {
    query.mockImplementation(async () => []);
    expect(await run(1)).toEqual({ ran: false, reason: 'not claimable (already running, completed or settled)' });
    expect(runMarketingReview).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('a marketing job is still bounced, before anything is written, while this instance\'s browser is busy (known limitation)', async () => {
    browser.inUse.mockReturnValue(true);
    expect(await run(1)).toMatchObject({ ran: false, status: 'busy' });
    expect(query).not.toHaveBeenCalled();
    expect(runMarketingReview).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the callbacks run.ts gives the marketing flow', () => {
  const handedContext = async (attempt: number) => {
    runMarketingReview.mockResolvedValueOnce({ ran: true, status: 'completed' });
    await run(attempt);
    query.mockClear();
    return runMarketingReview.mock.calls[0][0];
  };

  it('release puts the claimed job back to pending, for this application only', async () => {
    const ctx = await handedContext(1);
    await ctx.release();
    expect(releases()).toEqual([{ sql: SQL_RELEASE, params: [APP_ID] }]);
  });

  it('settleFailure on an early attempt hands a transient failure back and throws it', async () => {
    const ctx = await handedContext(1);
    await expect(ctx.settleFailure(new Error('read ECONNRESET'), 'Analysis failed')).rejects.toThrow('read ECONNRESET');
    expect(releases()).toHaveLength(1);
    expect(failMessages()).toEqual([]);
  });

  it('settleFailure records any other failure, with the prefix and a Re-run hint', async () => {
    const ctx = await handedContext(1);
    const r = await ctx.settleFailure(new Error('weird'), 'Analysis failed');
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — weird. Use Re-run to retry.']);
    expect(releases()).toEqual([]);
  });

  it('settleFailure records even a transient failure on the last attempt', async () => {
    const ctx = await handedContext(MAX_ATTEMPTS);
    expect(await ctx.settleFailure(new Error('read ECONNRESET'), 'Analysis failed')).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — read ECONNRESET. Use Re-run to retry.']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a marketing job, from run.ts to the recorded outcome', () => {
  it('opens a website with the marketing capture options, scores the work and folds by the profile\'s policy', async () => {
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'completed' });
    expect(browser.withBrowser).toHaveBeenCalledWith(expect.any(Function), { maxWaitMs: BUSY_WAIT_MS, blockPopups: true });
    expect(capturePortfolios).toHaveBeenCalledWith(FAKE_BROWSER, [SITE], T0 + 180_000, MARKETING_CAPTURE_OPTS);
    expect(vi.mocked(acquireFetchItems).mock.calls[0][0]).toEqual([{ link: DOC, ref: 'L1' }]);
    expect(vi.mocked(analyzeMarketing).mock.calls[0][0].deadline).toBe(T0 + TOTAL_BUDGET_MS);
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyPortfolioOutcome).mock.calls[0]).toEqual([
      APP_ID, expect.objectContaining({ status: 'completed', score: 7, note: 'Strong campaigns' }), { foldPolicy: 'always' },
    ]);
    expect(failMessages()).toEqual([]);
  });

  it('an analysis that shows the model nothing is recorded as not scored, never as a completed 0 — on any attempt, and not retried', async () => {
    // What analyzeMarketing hands back when everything was withheld or unreadable: model "none", a placeholder 0, no link shown.
    vi.mocked(analyzeMarketing).mockResolvedValue({
      ...marketingAnalysis(), model: 'none', score: 0, modelScore: 0, scoreNote: 'Nothing reviewable', portfolios: [],
      summary: 'No work could be opened and read, so nothing was reviewed or scored.',
    });
    for (const attempt of [1, MAX_ATTEMPTS]) {
      vi.mocked(applyPortfolioOutcome).mockClear();
      query.mockClear();
      expect(await run(attempt)).toEqual({ ran: true, status: 'unreviewable' });
      expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
      expect(vi.mocked(applyPortfolioOutcome).mock.calls[0][1]).toMatchObject({
        // the reason comes from what the analyzer recorded per link (nothing here), else from the acquisition: no "scanned pages" guess
        status: 'unreviewable', score: null, message: 'Nothing readable was found',
      });
      expect(failMessages()).toEqual([]);
      expect(releases()).toEqual([]);
    }
  });

  it('no links stored: recorded as failed at once, even on an early attempt — nothing a retry could change', async () => {
    db.app = marketingApp({ portfolio_urls: [] });
    expect(await run(1)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Work-sample review could not start — No work-sample links stored for this application. Use Re-run to retry.']);
    expect(releases()).toEqual([]);
  });

  it('loses the race for the browser: the job goes back to pending and is reported busy — no attempt used, nothing recorded', async () => {
    browser.withBrowser.mockRejectedValue(new BrowserBusyError());
    for (const attempt of [1, MAX_ATTEMPTS]) {
      query.mockClear();
      expect(await run(attempt)).toMatchObject({ ran: false, status: 'busy' });
      expect(releases()).toHaveLength(1);
      expect(failMessages()).toEqual([]);
    }
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('a link that failed on our side: an early attempt hands the job back and throws, the last records it as failed', async () => {
    fetchGives(items => [refused(items[0].ref, items[0].link, 'failed', 'Google temporarily blocked our automated download')]);
    db.app = marketingApp({ portfolio_urls: [DOC] });

    await expect(run(1)).rejects.toThrow('1 link(s) could not be opened (Google temporarily blocked our automated download)');
    expect(releases().length).toBeGreaterThan(0);
    expect(failMessages()).toEqual([]);

    query.mockClear();
    expect(await run(MAX_ATTEMPTS)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual([
      'Work-sample capture failed — 1 link(s) could not be opened (Google temporarily blocked our automated download). Use Re-run to retry.',
    ]);
    expect(releases()).toEqual([]);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
    expect(analyzeMarketing).not.toHaveBeenCalled();
  });

  it('the model overloaded: handed back on an early attempt, recorded on the last', async () => {
    vi.mocked(analyzeMarketing).mockRejectedValue(Object.assign(new Error('Overloaded'), { status: 529 }));
    await expect(run(1)).rejects.toThrow('Overloaded');
    expect(releases().length).toBeGreaterThan(0);
    expect(failMessages()).toEqual([]);

    query.mockClear();
    expect(await run(MAX_ATTEMPTS)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — Overloaded. Use Re-run to retry.']);
  });

  it('the browser cannot start: handed back on an early attempt, recorded on the last', async () => {
    browser.withBrowser.mockRejectedValue(new Error('Failed to launch the browser process'));
    await expect(run(1)).rejects.toThrow('Failed to launch');
    expect(failMessages()).toEqual([]);
    query.mockClear();
    expect(await run(MAX_ATTEMPTS)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Could not start the browser — Failed to launch the browser process. Use Re-run to retry.']);
  });

  it('something unexpected inside the marketing flow is caught by run.ts like any other failure', async () => {
    vi.mocked(acquireFetchItems).mockRejectedValue(new Error('the fetch phase broke'));
    expect(await run(1)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — the fetch phase broke. Use Re-run to retry.']);
    expect(errorSpy).toHaveBeenCalled();
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('the same unexpected failure, if transient, is handed back on an early attempt', async () => {
    vi.mocked(acquireFetchItems).mockRejectedValue(new Error('read ECONNRESET'));
    await expect(run(1)).rejects.toThrow('ECONNRESET');
    expect(releases().length).toBeGreaterThan(0);
    expect(failMessages()).toEqual([]);
  });

  describe('a re-run that comes back without a score', () => {
    const allPrivate = () => fetchGives(items => items.map(i => refused(i.ref, i.link, 'inaccessible', 'Link is private or deleted')));

    it('keeps the earlier review: recorded as failed with the earlier score named, and nothing scored or overwritten', async () => {
      allPrivate();
      db.app = marketingApp({ portfolio_urls: [DOC], score_portfolio: 7 });
      expect(await run(1)).toEqual({ ran: true, status: 'failed' });
      expect(failMessages()).toEqual([
        'The links could not be opened this time (they are private or no longer exist) — the earlier review (7/10) still applies. Use Re-run to retry.',
      ]);
      expect(applyPortfolioOutcome).not.toHaveBeenCalled();
      expect(releases()).toEqual([]);
    });

    it('the same re-run on the very first review simply records "inaccessible" with no score', async () => {
      allPrivate();
      db.app = marketingApp({ portfolio_urls: [DOC], score_portfolio: null });
      expect(await run(1)).toEqual({ ran: true, status: 'inaccessible' });
      expect(failMessages()).toEqual([]);
      expect(vi.mocked(applyPortfolioOutcome).mock.calls[0][1]).toMatchObject({
        status: 'inaccessible', score: null, message: 'The links are private or no longer exist - ask the candidate to re-share them',
      });
    });

    it('the longest message it can write still keeps its closing words inside the 500 characters that are stored', async () => {
      fetchGives(items => items.map((i, n) => refused(i.ref, i.link, 'unreviewable', `${String.fromCharCode(97 + n).repeat(120)}`)));
      const links = ['a', 'b', 'c', 'd'].map(h => ({ ...DOC, url: `https://${h}.example/f.pdf`, host: `${h}.example` }));
      db.app = marketingApp({ portfolio_urls: links, score_portfolio: 10 });
      await run(1);
      const [message] = failMessages();
      expect(message.length).toBeLessThan(500);
      expect(message.endsWith('— the earlier review (10/10) still applies. Use Re-run to retry.')).toBe(true);
    });
  });
});
