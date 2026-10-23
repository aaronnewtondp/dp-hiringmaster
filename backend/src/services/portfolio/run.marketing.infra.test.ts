import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Acquired } from './acquire/types.js';
import type { CapturedPortfolio } from './capture.js';
import type { PortfolioAnalysisResult, PortfolioLink, PortfolioSignals } from './types.js';
import { MARKETING_CRITERIA } from './rubric.marketing.js';

// The fourth review's two infrastructure findings that end in "the review is retried, never silently dropped", pinned from run.ts down to the recorded outcome:
//  A1  a browser that never hands back its capture (a stuck close, a capture that never returns) used to hold the worker invocation to Vercel's 300 s kill.
//      run.marketing.ts now waits for the capture only until the capture deadline plus a short grace, and then treats it as a failure on OUR side.
//  A4  a PDF whose own deadline passed while it WAITED behind other files in the one-at-a-time sandbox used to come back as the neutral "took too long to read"
//      (never retried). It is now 'unavailable' (ours) -> the document is 'failed' -> the review retries (attempts 1-2) and records failed with the Re-run hint (3).
// run.ts and run.marketing.ts are REAL here (as in run.dispatch.test.ts); the database is a recording stub; browser, capture, the fetch phase, the model and
// scoring are mocks, except in the A4 test, where the PDF queue and preparePdf are the real ones over a stand-in parser.
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a), transaction: vi.fn() }));

const browser = { inUse: vi.fn(), withBrowser: vi.fn() };
vi.mock('./browser.js', async () => {
  const actual = await vi.importActual<typeof import('./browser.js')>('./browser.js');
  return { ...actual, isBrowserInUse: () => browser.inUse(), withBrowser: (...a: unknown[]) => browser.withBrowser(...a) };
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

import { capturePortfolios } from './capture.js';
import { BudgetTracker, BUDGET } from './acquire/budget.js';
import { acquireFetchItems } from './acquire/index.js';
import { PDF_READER_REASON, preparePdf } from './acquire/pdf.js';
import { readPdfInSandbox } from './acquire/pdfSandbox.js';
import { pages, rawPdf } from './acquire/pdf.fixtures.js';
import { analyzeMarketing } from './analyze.marketing.js';
import { BROWSER_CLOSE_MS } from './browser.js';
import { applyPortfolioOutcome } from './scoring.js';
import { CAPTURE_GRACE_MS } from './run.marketing.js';
import { MAX_ATTEMPTS, isTransient, runPortfolioAnalysis } from './run.js';

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
const CANDIDATE = { id: 'C1', full_name: 'Jane Doe' };
const MARKETING_ROLE = { id: 'R019', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' };

const acq = (ref: string, l: PortfolioLink, over: Partial<Acquired> = {}): Acquired => ({
  ref, link: l, outcome: 'ok', basis: 'artifact', media: [], text: 'Campaign deck: six launches, with results.', facts: [], injectionHit: false, ...over,
});
const captured = (l: PortfolioLink): CapturedPortfolio => ({
  link: l, access: 'ok', signals: SIGNALS,
  pages: [{ url: l.url, title: 'Home', text: 'We built the brand from zero.', shots: [{ label: 'home', data: 'QUJD' }] }],
});
const shownLink = (ref: string, l: PortfolioLink): PortfolioAnalysisResult['portfolios'][number] => ({
  url: l.url, platform: l.platform, isPortfolio: true, belongsToCandidate: null, accessible: true, pagesReviewed: 0, pageTitles: [],
  signals: SIGNALS, ref, outcome: 'ok', coverage: 'full',
});
const analysis = (): PortfolioAnalysisResult => ({
  version: 1, kind: 'marketing_work', analyzedAt: '2026-10-22T09:59:00.000Z', model: 'claude-sonnet-4-5', portfolios: [shownLink('L1', DOC), shownLink('L2', SITE)],
  criteria: MARKETING_CRITERIA.map(c => ({ id: c.id, label: c.label, verdict: 'partial' as const, evidence: 'Shown', group: c.group, weight: c.weight, basis: 'seen' as const, source: 'L1', assessable: true })),
  jdAlignment: { mustHaves: [], niceToHaves: [] },
  modelScore: 7, checklistScore: 7, score: 7, scoreNote: 'Strong campaigns', highlights: [], redFlags: [], summary: 'A summary.',
});

const SQL_RELEASE = "UPDATE applications SET portfolio_analysis_status='pending', portfolio_started_at=NULL WHERE id=$1 AND portfolio_analysis_status='running'";
const SQL_FAIL = "UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 WHERE id=$2";
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const writes = () => query.mock.calls.map(c => ({ sql: norm(c[0]), params: c[1] as unknown[] }));
const releases = () => writes().filter(w => w.sql === SQL_RELEASE);
const failMessages = () => writes().filter(w => w.sql === SQL_FAIL).map(w => w.params[0] as string);

const run = (attempt: number) => runPortfolioAnalysis(APP_ID, { attempt });
let db: { app: Record<string, unknown> | null; candidate: unknown; role: unknown };
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

const marketingApp = (over: Record<string, unknown> = {}) => ({
  id: APP_ID, candidate_id: 'C1', role_id: 'R019', portfolio_urls: [DOC, SITE], score_portfolio: null,
  screening_answers: [{ question: 'Links to public resources/portfolio to highlight your past work?', answer: `${DOC.url} ${SITE.url}` }],
  ...over,
});

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = { app: marketingApp(), candidate: CANDIDATE, role: MARKETING_ROLE };
  query.mockReset().mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) ? [{ id: APP_ID }] : []));
  queryOne.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM applications/.test(sql)) return db.app;
    if (/FROM candidates/.test(sql)) return db.candidate;
    if (/FROM roles/.test(sql)) return db.role;
    return null;
  });
  browser.inUse.mockReset().mockReturnValue(false);
  browser.withBrowser.mockReset().mockImplementation(async (cb: (b: unknown) => unknown) => cb(FAKE_BROWSER));
  vi.mocked(capturePortfolios).mockReset().mockImplementation(async (_b, links) => links.map(captured));
  vi.mocked(analyzeMarketing).mockReset().mockResolvedValue(analysis());
  vi.mocked(acquireFetchItems).mockReset().mockImplementation(async items => items.map(i => acq(i.ref, i.link)));
  vi.mocked(applyPortfolioOutcome).mockReset().mockResolvedValue({ avg: null });
});
afterEach(() => { vi.useRealTimers(); errorSpy.mockRestore(); warnSpy.mockRestore(); });

// ════════════════════════════════════════════════════════════════════════════
describe('A1: a browser that never hands back its capture ends the review as a failure on OUR side, not at the platform\'s kill', () => {
  // What can be flushed with fake timers: the flow up to the wait on the capture is promises only, so a few turns of the microtask queue get there.
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
  const stuckBrowser = () => browser.withBrowser.mockImplementation(() => new Promise(() => {}));
  const fakeClock = () => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(new Date(NOW)); };

  it('the grace is the browser\'s close limit plus a margin: past the capture deadline the browser has BROWSER_CLOSE_MS to close, then it is killed', () => {
    expect(CAPTURE_GRACE_MS).toBe(BROWSER_CLOSE_MS + 5_000);
    expect(CAPTURE_GRACE_MS).toBe(15_000);
  });

  it('attempt 1 and 2 hand the job back (released, the error thrown for the queue to redeliver); attempt 3 records failed with the Re-run hint; nothing is scored', async () => {
    fakeClock();
    stuckBrowser();
    for (const attempt of [1, 2]) {
      query.mockClear();
      const pending = run(attempt);
      const outcome = expect(pending).rejects.toThrow('the browser did not respond in time');
      await flush();
      await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + CAPTURE_GRACE_MS + 1_000);
      await outcome;
      expect(releases().length).toBeGreaterThan(0);                          // handed back (run.ts's catch repeats the release: harmless, it is conditional on 'running')
      expect(releases().every(w => w.params[0] === APP_ID)).toBe(true);
      expect(failMessages()).toEqual([]);
    }
    query.mockClear();
    const last = run(MAX_ATTEMPTS);
    await flush();
    await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + CAPTURE_GRACE_MS + 1_000);
    expect(await last).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Website capture did not finish — the browser did not respond in time. Use Re-run to retry.']);
    expect(releases()).toEqual([]);
    expect(analyzeMarketing).not.toHaveBeenCalled();
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('the failure it raises is what run.ts treats as transient (503), the same way as any other failure on our side', async () => {
    fakeClock();
    stuckBrowser();
    const pending = run(1);
    const caught = pending.then(() => null, (e: Error & { status?: number }) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + CAPTURE_GRACE_MS + 1_000);
    const err = (await caught) as Error & { status?: number };
    expect(err.status).toBe(503);
    expect(isTransient(err)).toBe(true);
  });

  it('it waits for the capture deadline plus the grace, to the second: not before (a slow capture is still a capture), not long after', async () => {
    fakeClock();
    stuckBrowser();
    const settled = vi.fn();
    const pending = run(MAX_ATTEMPTS).then(settled, settled);
    await flush();
    await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + CAPTURE_GRACE_MS - 1_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('a capture that finishes late but inside the grace is used as usual (the wait is a bound, not a shortened deadline)', async () => {
    fakeClock();
    browser.withBrowser.mockImplementation((cb: (b: unknown) => unknown) => new Promise(resolve => {
      setTimeout(() => resolve(cb(FAKE_BROWSER)), BUDGET.acquireMs + 10_000);       // 10 s past the capture deadline, 5 s inside the grace
    }));
    const pending = run(1);
    await flush();
    await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + 11_000);
    expect(await pending).toEqual({ ran: true, status: 'completed' });
    expect(failMessages()).toEqual([]);
  });

  it('the normal path is unchanged and leaves no timer behind (the bound must not keep a finished worker alive)', async () => {
    fakeClock();
    const pending = run(1);
    await flush();
    expect(await pending).toEqual({ ran: true, status: 'completed' });
    expect(vi.getTimerCount()).toBe(0);
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
  });

  it('a capture that is abandoned and fails LATER (the browser finally dies) cannot crash the process', async () => {
    fakeClock();
    const unhandled: unknown[] = [];
    const seen = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', seen);
    try {
      let reject!: (e: Error) => void;
      browser.withBrowser.mockImplementation(() => new Promise((_, r) => { reject = r; }));
      const pending = run(MAX_ATTEMPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(BUDGET.acquireMs + CAPTURE_GRACE_MS + 1_000);
      await pending;
      reject(new Error('Target closed'));
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
      await new Promise(r => setImmediate(r));
    } finally { process.off('unhandledRejection', seen); }
    expect(unhandled).toEqual([]);
  });

  it('a job whose capture deadline has already passed by the clock (it started long ago) still gives a running capture the grace: it is not abandoned on the spot, and a stuck one ends after the grace and no later', async () => {
    fakeClock();
    const settleFailure = vi.fn(async () => ({ ran: true, status: 'failed' as const }));
    const ctx = () => ({
      applicationId: APP_ID, app: marketingApp() as never, candidate: CANDIDATE as never, role: MARKETING_ROLE as never,
      profile: { kind: 'marketing_work', source: 'screening', unreachable: 'unscored', noEvidence: 'unscored', foldPolicy: 'always' } as never,
      startedAt: T0 - BUDGET.acquireMs - 60_000,               // the capture deadline was a minute ago
      attempt: 1, settleFailure, release: async () => {},
    });
    const { runMarketingReview } = await import('./run.marketing.js');

    browser.withBrowser.mockImplementation((cb: (b: unknown) => unknown) => new Promise(resolve => { setTimeout(() => resolve(cb(FAKE_BROWSER)), 5_000); }));
    const slow = runMarketingReview(ctx());
    await flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await slow).toEqual({ ran: true, status: 'completed' });
    expect(settleFailure).not.toHaveBeenCalled();

    stuckBrowser();
    const stuck = runMarketingReview(ctx());
    await flush();
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS - 1_000);
    expect(settleFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await stuck;
    expect(settleFailure).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('A4: a PDF that ran out of its own time WAITING in the sandbox queue is retried, never silently dropped', () => {
  let dir = '';
  let fakePath = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-queue-e2e-'));
    fakePath = path.join(dir, 'fake-pdf-parse.cjs');
    // The "PDF" bytes say what to do: a file containing SPINMARK holds the parser in an endless loop; any other is a one-page deck.
    fs.writeFileSync(fakePath, `
class PDFParse {
  constructor(opts) { this.spin = Buffer.from(opts.data).toString('latin1').includes('SPINMARK'); }
  async getInfo() { if (this.spin) { for (;;) {} } return { total: 1, permission: null }; }
  async getText() { return { text: '', pages: [{ num: 1, text: 'A short campaign deck with the results of six launches.' }] }; }
}
module.exports = { PDFParse };
`);
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** What documents.ts hands the review for a PDF: the Prepared result under the link's ref. Hostile files hold the one-at-a-time sandbox for their whole cap first. */
  async function deckBehindHostileFiles(): Promise<Acquired> {
    const options = { parserModule: fakePath, capMs: 500 };
    const hostile = [1, 2, 3].map(() => readPdfInSandbox(Buffer.from('SPINMARK'), { maxPages: 20, deadline: Date.now() + 60_000, ...options }));
    const ctx = { deadline: Date.now() + 700, budget: new BudgetTracker() };           // its own deadline is shorter than the wait for its turn
    const prepared = await preparePdf(rawPdf(pages(1)), 'deck.pdf', ctx, { options });
    await Promise.all(hostile);
    return { ref: 'L1', link: DOC, basis: 'artifact', ...prepared };
  }

  it('the deck comes back FAILED (ours: "will be retried"), not unreviewable "took too long to read"', async () => {
    const deck = await deckBehindHostileFiles();
    expect(deck).toMatchObject({ outcome: 'failed', reason: PDF_READER_REASON, text: '', media: [] });
  }, 30_000);

  it('through run.ts: attempts 1 and 2 hand the job back and throw, attempt 3 records failed with the Re-run hint; never a neutral "not scored"', async () => {
    const deck = await deckBehindHostileFiles();
    db.app = marketingApp({ portfolio_urls: [DOC] });
    vi.mocked(acquireFetchItems).mockReset().mockImplementation(async () => [deck]);
    const reason = 'The PDF reader could not be started on our side - this will be retried';

    for (const attempt of [1, 2]) {
      query.mockClear();
      await expect(run(attempt)).rejects.toThrow(`1 link(s) could not be opened (${reason})`);
      expect(releases().length).toBeGreaterThan(0);                          // handed back (run.ts's catch repeats the release: harmless, it is conditional on 'running')
      expect(releases().every(w => w.params[0] === APP_ID)).toBe(true);
      expect(failMessages()).toEqual([]);
    }
    query.mockClear();
    expect(await run(MAX_ATTEMPTS)).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual([`Work-sample capture failed — 1 link(s) could not be opened (${reason}). Use Re-run to retry.`]);
    expect(releases()).toEqual([]);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();     // no "unreviewable", no score, nothing recorded as the candidate's
    expect(analyzeMarketing).not.toHaveBeenCalled();
  }, 30_000);

  it('the contrast, so the test means something: the neutral timeout the file used to get is settled on the spot as "not scored" and is never retried', async () => {
    db.app = marketingApp({ portfolio_urls: [DOC] });
    vi.mocked(acquireFetchItems).mockReset().mockImplementation(async () => [acq('L1', DOC, { outcome: 'unreviewable', text: '', reason: 'This PDF took too long to read' })]);
    expect(await run(1)).toEqual({ ran: true, status: 'unreviewable' });          // attempt 1, and it is not handed back
    expect(releases()).toEqual([]);
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
  });
});
