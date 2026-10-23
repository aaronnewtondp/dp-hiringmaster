import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CapturedPortfolio } from './capture.js';
import type { PortfolioAnalysisResult, PortfolioReviewed, PortfolioSignals } from './types.js';

// Characterization tests for runPortfolioAnalysis (run.ts) — every NON-busy branch.
// (The "browser is taken / hand it back to the queue" path is in run.busy.test.ts.)
// The database is a recording stub; browser, capture, analysis and scoring are mocks.
// They pin what the orchestrator DECIDES and WRITES, so the pipeline can be refactored
// (a second review kind sharing it) without changing a single outcome for the designer role.
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a) }));

const browser = { inUse: vi.fn(), withBrowser: vi.fn() };
vi.mock('./browser.js', async () => {
  const actual = await vi.importActual<typeof import('./browser.js')>('./browser.js');
  return {
    ...actual,
    isBrowserInUse: () => browser.inUse(),
    withBrowser: (...a: unknown[]) => browser.withBrowser(...a),
  };
});
vi.mock('./capture.js', () => ({ capturePortfolios: vi.fn() }));
vi.mock('./analyze.js', () => ({ analyzePortfolios: vi.fn() }));
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: vi.fn() }));

import { BrowserBusyError } from './browser.js';
import { capturePortfolios } from './capture.js';
import { analyzePortfolios } from './analyze.js';
import { applyPortfolioOutcome } from './scoring.js';
import { BUSY_WAIT_MS, MAX_ATTEMPTS, isTransient, runPortfolioAnalysis } from './run.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

// ── fixtures ────────────────────────────────────────────────────────────────
const APP_ID = 'A0611';
const LINK  = { url: 'https://x.example', host: 'x.example', platform: 'custom' } as const;
const LINK2 = { url: 'https://y.example', host: 'y.example', platform: 'framer' } as const;
const CANDIDATE = { id: 'C1', full_name: 'Test Candidate' };
const ROLE = { id: 'R007', portfolio_analysis_enabled: true };
const NOW = '2026-10-22T10:00:00.000Z';
const T0 = Date.parse(NOW);
const FAKE_BROWSER = { fake: 'browser' };

const signals = (): PortfolioSignals => ({
  brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0,
  failedRequests: 0, mobileOverflow: null, loadMs: null, truncated: false,
});
const cap = (access: CapturedPortfolio['access'], over: Partial<CapturedPortfolio> = {}): CapturedPortfolio =>
  ({ link: LINK, access, pages: [], signals: signals(), ...over });
const reviewed = (over: Partial<PortfolioReviewed> = {}): PortfolioReviewed => ({
  url: LINK.url, platform: 'custom', isPortfolio: true, belongsToCandidate: true, accessible: true,
  accessKind: 'ok', pagesReviewed: 2, pageTitles: ['Home', 'Work'], signals: signals(), ...over,
});
const analysisOf = (over: Partial<PortfolioAnalysisResult> = {}): PortfolioAnalysisResult => ({
  version: 1, analyzedAt: '2026-10-22T09:59:00.000Z', model: 'claude-sonnet-4-5', portfolios: [reviewed()],
  criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
  modelScore: 7, checklistScore: 7, score: 7, scoreNote: 'Strong portfolio',
  highlights: ['h'], redFlags: ['rf'], summary: 'A summary.', ...over,
});

// ── the four SQL statements run.ts itself issues (whitespace-normalised) ───
const SQL_CLAIM = "UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW(), portfolio_analysis_error=NULL WHERE id=$1 AND ( portfolio_analysis_status IN ('pending','failed') OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($2 || ' seconds')::interval) ) RETURNING id";
const SQL_RELEASE = "UPDATE applications SET portfolio_analysis_status='pending', portfolio_started_at=NULL WHERE id=$1 AND portfolio_analysis_status='running'";
const SQL_FAIL = "UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 WHERE id=$2";
const SQL_APP = 'SELECT * FROM applications WHERE id=$1';
const SQL_CANDIDATE = 'SELECT * FROM candidates WHERE id=$1';
const SQL_ROLE = 'SELECT * FROM roles WHERE id=$1';

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const writes = () => query.mock.calls.map(c => ({ sql: norm(c[0]), params: c[1] as unknown[] }));
const callsTo = (sql: string) => writes().filter(w => w.sql === sql);
const releases = () => callsTo(SQL_RELEASE);
const failures = () => callsTo(SQL_FAIL);
const failMessages = () => failures().map(w => w.params[0] as string);

const run = (attempt?: number) => runPortfolioAnalysis(APP_ID, attempt === undefined ? {} : { attempt });
const captures = (...caps: CapturedPortfolio[]) => vi.mocked(capturePortfolios).mockResolvedValue(caps);
const analysis = (a: PortfolioAnalysisResult) => vi.mocked(analyzePortfolios).mockResolvedValue(a);
const applied = () => {
  expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
  const [id, out] = vi.mocked(applyPortfolioOutcome).mock.calls[0];
  expect(id).toBe(APP_ID);
  return out;
};
const nothingApplied = () => expect(applyPortfolioOutcome).not.toHaveBeenCalled();
const browserNeverOpened = () => {
  expect(browser.withBrowser).not.toHaveBeenCalled();
  expect(capturePortfolios).not.toHaveBeenCalled();
  expect(analyzePortfolios).not.toHaveBeenCalled();
  nothingApplied();
};
/** Hand-back = job put back to pending, nothing recorded as failed, nothing scored. */
const expectHandedBack = () => {
  expect(releases().length).toBeGreaterThan(0);
  expect(releases()[0].params).toEqual([APP_ID]);
  expect(failures()).toEqual([]);
  nothingApplied();
};

let db: { app: unknown; candidate: unknown; role: unknown };
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  db = {
    app: { id: APP_ID, candidate_id: 'C1', role_id: 'R007', portfolio_urls: [LINK] },
    candidate: CANDIDATE,
    role: ROLE,
  };
  query.mockReset();
  queryOne.mockReset();
  query.mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) ? [{ id: APP_ID }] : []));   // the claim succeeds
  queryOne.mockImplementation(async (sql: string) => {
    if (/FROM applications/.test(sql)) return db.app;
    if (/FROM candidates/.test(sql)) return db.candidate;
    if (/FROM roles/.test(sql)) return db.role;
    return null;
  });
  browser.inUse.mockReset().mockReturnValue(false);
  browser.withBrowser.mockReset().mockImplementation(async (cb: (b: unknown) => unknown) => cb(FAKE_BROWSER));
  vi.mocked(capturePortfolios).mockReset().mockResolvedValue([cap('ok', { pages: [{ url: LINK.url, title: 'Home', text: 't', shots: [] }] })]);
  vi.mocked(analyzePortfolios).mockReset().mockResolvedValue(analysisOf());
  vi.mocked(applyPortfolioOutcome).mockReset().mockResolvedValue({ avg: null });
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — claim and lookups', () => {
  it('claims the job with the stale-running window and stops right there when it is not claimable', async () => {
    query.mockImplementation(async () => []);
    const r = await run(1);
    expect(r).toEqual({ ran: false, reason: 'not claimable (already running, completed or settled)' });
    expect(writes()).toEqual([{ sql: SQL_CLAIM, params: [APP_ID, '310'] }]);
    expect(queryOne).not.toHaveBeenCalled();
    browserNeverOpened();
  });

  it('pins the job-state constants the claim depends on', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(STALE_RUNNING_SECONDS).toBe(310);
    expect(BUSY_WAIT_MS).toBe(3_000);
  });

  it('looks up the application, then the candidate and the role by the application\'s own ids', async () => {
    captures(cap('blocked', { accessNote: 'x' }));
    await run(1);
    expect(queryOne.mock.calls.map(c => [norm(c[0]), c[1]])).toEqual([
      [SQL_APP, [APP_ID]],
      [SQL_CANDIDATE, ['C1']],
      [SQL_ROLE, ['R007']],
    ]);
  });

  it('application vanished after the claim: { ran:false, reason } — and (as-is) neither released nor failed', async () => {
    db.app = null;
    const r = await run(1);
    expect(r).toEqual({ ran: false, reason: 'application not found' });
    // ODDITY: the claimed row is left 'running' until the stale window (310s) lets it be reclaimed.
    expect(writes().map(w => w.sql)).toEqual([SQL_CLAIM]);
    expect(queryOne).toHaveBeenCalledTimes(1);
    browserNeverOpened();
  });

  it.each([
    ['candidate', { candidate: null }],
    ['role', { role: null }],
    ['candidate and role', { candidate: null, role: null }],
  ])('missing %s: records failed "Candidate or role not found" and returns failed', async (_n, patch) => {
    Object.assign(db, patch);
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: ['Candidate or role not found', APP_ID] }]);
    expect(releases()).toEqual([]);
    browserNeverOpened();
  });

  it.each([false, null, undefined])('role.portfolio_analysis_enabled = %s: failed "Portfolio review is not enabled for this role"', async (flag) => {
    db.role = { id: 'R007', portfolio_analysis_enabled: flag };
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: ['Portfolio review is not enabled for this role', APP_ID] }]);
    browserNeverOpened();
  });

  it.each([[[]], [null], [undefined]])('portfolio_urls = %j: failed "No portfolio links stored for this application"', async (urls) => {
    db.app = { id: APP_ID, candidate_id: 'C1', role_id: 'R007', portfolio_urls: urls };
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: ['No portfolio links stored for this application', APP_ID] }]);
    browserNeverOpened();
  });

  it('checks in a fixed order: missing candidate/role beats "not enabled", which beats "no links"', async () => {
    db.app = { id: APP_ID, candidate_id: 'C1', role_id: 'R007', portfolio_urls: [] };
    db.role = { id: 'R007', portfolio_analysis_enabled: false };
    await run(1);
    expect(failMessages()).toEqual(['Portfolio review is not enabled for this role']);

    query.mockClear();
    db.candidate = null;
    await run(1);
    expect(failMessages()).toEqual(['Candidate or role not found']);
  });

  it('these gating failures are final even on an early attempt: nothing is thrown and nothing is retried', async () => {
    db.role = { id: 'R007', portfolio_analysis_enabled: false };
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(releases()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — the browser/capture step', () => {
  it('opens the browser waiting at most BUSY_WAIT_MS, and captures every stored link with a deadline of start + 195s', async () => {
    const links = [LINK, LINK2];
    db.app = { id: APP_ID, candidate_id: 'C1', role_id: 'R007', portfolio_urls: links };
    captures(cap('blocked', { accessNote: 'n' }), cap('blocked', { link: LINK2, accessNote: 'm' }));
    await run(1);
    expect(browser.withBrowser).toHaveBeenCalledTimes(1);
    expect(browser.withBrowser).toHaveBeenCalledWith(expect.any(Function), { maxWaitMs: BUSY_WAIT_MS });
    expect(capturePortfolios).toHaveBeenCalledTimes(1);
    const [b, passedLinks, deadline] = vi.mocked(capturePortfolios).mock.calls[0];
    expect(b).toBe(FAKE_BROWSER);
    expect(passedLinks).toBe(links);                       // the stored array itself, untouched
    expect(deadline).toBe(T0 + 270_000 - 75_000);          // TOTAL_BUDGET_MS - ANALYSIS_RESERVE_MS
  });

  it('a non-transient error from the browser step is recorded at once, even on attempt 1, with the "Could not start the browser" prefix', async () => {
    browser.withBrowser.mockRejectedValue(new Error('chromium binary is corrupt'));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: [`Could not start the browser — chromium binary is corrupt. Use Re-run to retry.`, APP_ID] }]);
    expect(releases()).toEqual([]);
    nothingApplied();
  });

  it('a non-Error rejection is stringified into the recorded message', async () => {
    browser.withBrowser.mockRejectedValue('boom');
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Could not start the browser — boom. Use Re-run to retry.']);
  });

  it('ODDITY: an exception thrown by capturePortfolios itself is also labelled "Could not start the browser"', async () => {
    vi.mocked(capturePortfolios).mockRejectedValue(new Error('page crashed'));
    await expect(run(MAX_ATTEMPTS)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Could not start the browser — page crashed. Use Re-run to retry.']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — every capture failed on our side (settleFailure)', () => {
  const TIMEOUT_MSG = 'Could not open the portfolio (timeout)';

  it.each([1, 2])('attempt %i, transient: puts the job back to pending and RE-THROWS so the queue redelivers', async (attempt) => {
    captures(cap('error', { accessNote: 'timeout' }));
    await expect(run(attempt)).rejects.toThrowError(new Error(TIMEOUT_MSG));
    expectHandedBack();
    expect(analyzePortfolios).not.toHaveBeenCalled();
  });

  it.each([MAX_ATTEMPTS, MAX_ATTEMPTS + 1, undefined])('attempt %s (last, past the last, or a direct run), transient: records failed with the Re-run hint instead of throwing', async (attempt) => {
    captures(cap('error', { accessNote: 'timeout' }));
    const r = await run(attempt);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: [`Portfolio capture failed — ${TIMEOUT_MSG}. Use Re-run to retry.`, APP_ID] }]);
    expect(releases()).toEqual([]);
    nothingApplied();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a NON-transient capture error is recorded immediately, even on attempt 1 (not retried)', async () => {
    captures(cap('error', { accessNote: 'No page content could be read' }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Portfolio capture failed — Could not open the portfolio (No page content could be read). Use Re-run to retry.']);
    expect(releases()).toEqual([]);
  });

  it('ODDITY: "Time budget exhausted…" is not matched as transient, so that case is recorded failed on attempt 1 rather than retried with a fresh budget', async () => {
    captures(cap('error', { accessNote: 'Time budget exhausted before this portfolio could be opened' }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(releases()).toEqual([]);
    expect(failMessages()).toEqual(['Portfolio capture failed — Could not open the portfolio (Time budget exhausted before this portfolio could be opened). Use Re-run to retry.']);
  });

  it('a missing accessNote reads "unknown error" (and is not transient)', async () => {
    captures(cap('error'));
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Portfolio capture failed — Could not open the portfolio (unknown error). Use Re-run to retry.']);
  });

  it('quotes the FIRST errored link\'s note only', async () => {
    captures(cap('error', { accessNote: 'first note' }), cap('error', { link: LINK2, accessNote: 'second note' }));
    await run(MAX_ATTEMPTS);
    expect(failMessages()).toEqual(['Portfolio capture failed — Could not open the portfolio (first note). Use Re-run to retry.']);
  });

  it.each([
    ['blocked', cap('blocked', { link: LINK2, accessNote: 'private' })],
    ['skipped', cap('skipped', { link: LINK2, accessNote: 'a deck' })],
  ])('an errored link plus a %s link (nothing ok) is still a failure on our side, never "inaccessible"', async (_n, other) => {
    captures(other, cap('error', { accessNote: 'No page content could be read' }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    nothingApplied();
    expect(analyzePortfolios).not.toHaveBeenCalled();
  });

  it('ODDITY (incidental): the early-attempt re-throw is caught by the outer catch, logged, and settled a second time — so the hand-back UPDATE is issued twice', async () => {
    captures(cap('error', { accessNote: 'timeout' }));
    await expect(run(1)).rejects.toThrowError(new Error(TIMEOUT_MSG));
    expect(releases().length).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[Portfolio] Analysis failed for', APP_ID, expect.any(Error));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — nothing to review: only blocked / skipped links', () => {
  const BLOCKED_NOTE = 'Portfolio is private or requires access';
  const SKIPPED_NOTE = 'File / slide-deck link — not opened automatically; review manually';
  const UNREACHABLE = 'The portfolio link(s) in the resume are private, dead or otherwise unreachable for an outside viewer.';
  const FILE_SUMMARY = 'The only portfolio link is a file or slide deck, which is not opened automatically. Review it manually.';
  const FILE_FLAG = 'Portfolio is a PDF / slide-deck link that was not reviewed automatically — review it manually';

  it('a single blocked link: status inaccessible, score 1, the full synthetic analysis, and no model call', async () => {
    captures(cap('blocked', { accessNote: BLOCKED_NOTE }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'inaccessible' });
    const flag = `Portfolio link not reviewable — ${BLOCKED_NOTE}`;
    expect(applied()).toEqual({
      status: 'inaccessible', score: 1, note: 'Portfolio link not reachable',
      oneLiner: UNREACHABLE, redFlags: [flag], message: BLOCKED_NOTE,
      analysis: {
        version: 1, analyzedAt: NOW, model: 'none',
        portfolios: [{
          url: LINK.url, platform: 'custom', isPortfolio: true, belongsToCandidate: null,
          accessible: false, accessKind: 'blocked', accessNote: BLOCKED_NOTE,
          pagesReviewed: 0, pageTitles: [], signals: signals(),
        }],
        criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
        modelScore: 0, checklistScore: 0, score: 1, scoreNote: 'Portfolio link not reachable',
        highlights: [], redFlags: [flag], summary: UNREACHABLE,
      },
    });
    expect(analyzePortfolios).not.toHaveBeenCalled();
    // run.ts itself writes nothing but the claim: the outcome (status, score, message) is scoring's job
    expect(writes().map(w => w.sql)).toEqual([SQL_CLAIM]);
  });

  it('only file/deck links: status is still inaccessible but score 3 with the file-specific note, flag and summary', async () => {
    captures(cap('skipped', { accessNote: SKIPPED_NOTE }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'inaccessible' });
    const out = applied();
    expect(out).toMatchObject({
      status: 'inaccessible', score: 3, note: 'Portfolio is a file/deck link',
      oneLiner: FILE_SUMMARY, redFlags: [FILE_FLAG], message: SKIPPED_NOTE,
    });
    expect(out.analysis).toMatchObject({
      model: 'none', modelScore: 0, checklistScore: 0, score: 3, scoreNote: 'Portfolio is a file/deck link',
      redFlags: [FILE_FLAG], summary: FILE_SUMMARY, highlights: [], criteria: [],
    });
    expect(out.analysis?.portfolios[0]).toMatchObject({ accessible: false, accessKind: 'skipped', accessNote: SKIPPED_NOTE, belongsToCandidate: null, isPortfolio: true });
  });

  it('several file links: still the file case, notes joined with "; "', async () => {
    captures(cap('skipped', { accessNote: 'deck one' }), cap('skipped', { link: LINK2, accessNote: 'deck two' }));
    await run(1);
    expect(applied()).toMatchObject({ score: 3, note: 'Portfolio is a file/deck link', message: 'deck one; deck two' });
  });

  it('a blocked link together with a file link is NOT the file case: score 1, blocked notes listed before file notes whatever the capture order', async () => {
    captures(cap('skipped', { link: LINK2, accessNote: SKIPPED_NOTE }), cap('blocked', { accessNote: BLOCKED_NOTE }));
    await run(1);
    const why = `${BLOCKED_NOTE}; ${SKIPPED_NOTE}`;
    expect(applied()).toMatchObject({
      status: 'inaccessible', score: 1, note: 'Portfolio link not reachable', oneLiner: UNREACHABLE,
      redFlags: [`Portfolio link not reviewable — ${why}`], message: why,
    });
    const portfolios = applied().analysis!.portfolios;
    expect(portfolios.map(p => p.accessKind)).toEqual(['skipped', 'blocked']);   // portfolios stay in capture order
  });

  it('ODDITY: a blocked link with no note gives a red flag ending in "— " and no message', async () => {
    captures(cap('blocked'));
    await run(1);
    const out = applied();
    expect(out.redFlags).toEqual(['Portfolio link not reviewable — ']);
    expect(out.message).toBeUndefined();
    expect(out.score).toBe(1);
  });

  it('a file link with no note: the file case, no message', async () => {
    captures(cap('skipped'));
    await run(1);
    const out = applied();
    expect(out).toMatchObject({ score: 3, note: 'Portfolio is a file/deck link', redFlags: [FILE_FLAG] });
    expect(out.message).toBeUndefined();
  });

  it('describes each capture with its page count and at most the first six page titles', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({ url: `${LINK.url}/${i}`, title: `P${i}`, text: '', shots: [] }));
    captures(cap('blocked', { accessNote: 'late wall', pages }));
    await run(1);
    expect(applied().analysis!.portfolios[0]).toMatchObject({ pagesReviewed: 8, pageTitles: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] });
  });

  it('works on any attempt number: an inaccessible verdict is never retried or released', async () => {
    captures(cap('blocked', { accessNote: BLOCKED_NOTE }));
    for (const attempt of [1, 2, MAX_ATTEMPTS, undefined]) {
      query.mockClear();
      vi.mocked(applyPortfolioOutcome).mockClear();
      await expect(run(attempt)).resolves.toEqual({ ran: true, status: 'inaccessible' });
      expect(releases()).toEqual([]);
      expect(failures()).toEqual([]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — a readable portfolio was captured and analysed', () => {
  it('calls the analysis with candidate, role, EVERY capture (not only the ok ones) and a deadline of start + 270s', async () => {
    const caps = [cap('ok'), cap('blocked', { link: LINK2, accessNote: 'private' })];
    captures(...caps);
    await run(1);
    expect(analyzePortfolios).toHaveBeenCalledTimes(1);
    expect(analyzePortfolios).toHaveBeenCalledWith(CANDIDATE, ROLE, caps, { deadline: T0 + 270_000 });
  });

  it('a reviewed real portfolio: status completed, with the analysis\'s own score, note, summary and red flags — and nothing else written by run.ts', async () => {
    const a = analysisOf();
    analysis(a);
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'completed' });
    const out = applied();
    expect(out).toEqual({ status: 'completed', score: 7, note: 'Strong portfolio', oneLiner: 'A summary.', redFlags: ['rf'], analysis: a, message: undefined });
    expect(out.analysis).toBe(a);                            // the very object the model step returned
    expect(a.score).toBe(7);                                 // completed is never clamped
    expect(writes().map(w => w.sql)).toEqual([SQL_CLAIM]);
  });

  it.each([0, 5, 10])('the completed score is passed through as-is (%i)', async (score) => {
    analysis(analysisOf({ score }));
    await run(1);
    expect(applied().score).toBe(score);
  });

  it.each([true, null])('belongsToCandidate = %s counts as a real portfolio (only an explicit false does not)', async (belongs) => {
    analysis(analysisOf({ portfolios: [reviewed({ belongsToCandidate: belongs })] }));
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'completed' });
  });

  it('one real portfolio among unusable ones is enough to complete', async () => {
    analysis(analysisOf({ portfolios: [
      reviewed({ isPortfolio: false }),
      reviewed({ belongsToCandidate: false }),
      reviewed({ url: LINK2.url }),
    ] }));
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'completed' });
  });

  it('completes without a message when only blocked / skipped links sit beside the ok one', async () => {
    captures(cap('ok'), cap('blocked', { link: LINK2, accessNote: 'private' }), cap('skipped', { accessNote: 'deck' }));
    await run(1);
    expect(applied().message).toBeUndefined();
  });

  it('when some links ERRORED but one was reviewed: completed, with "N of M portfolio links could not be opened (first note)."', async () => {
    captures(
      cap('ok'),
      cap('error', { link: LINK2, accessNote: 'first error note' }),
      cap('error', { accessNote: 'second error note' }),
      cap('blocked', { accessNote: 'private' }),
    );
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'completed' });
    expect(applied().message).toBe('2 of 4 portfolio links could not be opened (first error note).');
    expect(releases()).toEqual([]);
    expect(failures()).toEqual([]);
  });

  it('ODDITY: an errored link with no accessNote prints "(undefined)" in the message', async () => {
    captures(cap('ok'), cap('error', { link: LINK2 }));
    await run(1);
    expect(applied().message).toBe('1 of 2 portfolio links could not be opened (undefined).');
  });

  it.each([1, 2, MAX_ATTEMPTS, undefined])('attempt %s: a completed review never depends on the attempt number', async (attempt) => {
    await expect(run(attempt)).resolves.toEqual({ ran: true, status: 'completed' });
    expect(releases()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — the model found no usable portfolio', () => {
  const NOT_REAL: Array<[string, PortfolioReviewed[]]> = [
    ['not a portfolio (isPortfolio false)', [reviewed({ isPortfolio: false })]],
    ['not the candidate\'s (belongsToCandidate false)', [reviewed({ belongsToCandidate: false })]],
    ['not accessible', [reviewed({ accessible: false })]],
    ['no portfolios at all', []],
  ];

  it.each(NOT_REAL)('%s, no link errored: no_portfolio with the fixed note and message', async (_n, portfolios) => {
    const a = analysisOf({ portfolios, score: 6 });
    analysis(a);
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'no_portfolio' });
    expect(applied()).toEqual({
      status: 'no_portfolio', score: 1, note: 'No usable portfolio found',
      oneLiner: 'A summary.', redFlags: ['rf'], analysis: a,
      message: 'The links in the resume were not a design portfolio belonging to the candidate.',
    });
  });

  it.each([[6, 1], [2, 1], [1, 1], [0, 0]])('the score is capped with min(score, 1): %i -> %i — and the analysis object itself is mutated', async (before, after) => {
    const a = analysisOf({ portfolios: [reviewed({ isPortfolio: false })], score: before });
    analysis(a);
    await run(1);
    expect(applied().score).toBe(after);
    expect(a.score).toBe(after);
    expect(applied().analysis).toBe(a);
  });

  it('an empty summary falls back to the fixed one-liner', async () => {
    analysis(analysisOf({ portfolios: [reviewed({ isPortfolio: false })], summary: '' }));
    await run(1);
    expect(applied().oneLiner).toBe('No usable design portfolio was found behind the links in the resume.');
  });

  it('blocked / skipped links beside the ok one do not stop it from settling as no_portfolio', async () => {
    captures(cap('ok'), cap('blocked', { link: LINK2, accessNote: 'private' }), cap('skipped', { accessNote: 'deck' }));
    analysis(analysisOf({ portfolios: [reviewed({ isPortfolio: false })] }));
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'no_portfolio' });
  });

  describe('but a link ALSO errored on our side — "Inconclusive review"', () => {
    const noReal = () => analysis(analysisOf({ portfolios: [reviewed({ isPortfolio: false })], score: 6 }));

    it('last attempt: recorded failed (not held against the candidate), naming how many links errored and the first note', async () => {
      captures(cap('ok'), cap('error', { link: LINK2, accessNote: 'No page content could be read' }), cap('error', { accessNote: 'ignored second' }));
      noReal();
      const r = await run(MAX_ATTEMPTS);
      expect(r).toEqual({ ran: true, status: 'failed' });
      expect(failMessages()).toEqual(['Inconclusive review — 2 link(s) could not be opened (No page content could be read) and the rest were not a usable portfolio. Use Re-run to retry.']);
      nothingApplied();
    });

    it('a note that reads as transient (…timeout…) on an early attempt: handed back and re-thrown', async () => {
      const note = 'Capture failed (Navigation timeout of 25000 ms exceeded)';
      captures(cap('ok'), cap('error', { link: LINK2, accessNote: note }));
      noReal();
      await expect(run(1)).rejects.toThrowError(new Error(`1 link(s) could not be opened (${note}) and the rest were not a usable portfolio`));
      expectHandedBack();
    });

    it('ODDITY: whether it is retried depends on the free text of the note — a non-matching one is recorded failed even on attempt 1', async () => {
      captures(cap('ok'), cap('error', { link: LINK2, accessNote: 'Time budget exhausted before this portfolio could be opened' }));
      noReal();
      await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
      expect(releases()).toEqual([]);
      expect(failMessages()).toEqual(['Inconclusive review — 1 link(s) could not be opened (Time budget exhausted before this portfolio could be opened) and the rest were not a usable portfolio. Use Re-run to retry.']);
    });

    it('never scores anything on this path', async () => {
      captures(cap('ok'), cap('error', { link: LINK2, accessNote: 'No page content could be read' }));
      noReal();
      await run(MAX_ATTEMPTS);
      nothingApplied();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — the model step throws', () => {
  it('a non-transient error is recorded at once as "Analysis failed — …", even on attempt 1', async () => {
    vi.mocked(analyzePortfolios).mockRejectedValue(new Error('Model returned invalid JSON'));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failures()).toEqual([{ sql: SQL_FAIL, params: ['Analysis failed — Model returned invalid JSON. Use Re-run to retry.', APP_ID] }]);
    expect(releases()).toEqual([]);
    nothingApplied();
  });

  it.each([1, 2])('attempt %i, a rate-limited / overloaded model (HTTP 529): hands the job back and re-throws the ORIGINAL error', async (attempt) => {
    const err = Object.assign(new Error('Overloaded'), { status: 529 });
    vi.mocked(analyzePortfolios).mockRejectedValue(err);
    await expect(run(attempt)).rejects.toBe(err);
    expectHandedBack();
  });

  it('last attempt, same transient error: recorded failed with the Re-run hint', async () => {
    vi.mocked(analyzePortfolios).mockRejectedValue(Object.assign(new Error('Overloaded'), { status: 529 }));
    const r = await run(MAX_ATTEMPTS);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — Overloaded. Use Re-run to retry.']);
    expect(releases()).toEqual([]);
  });

  it('ODDITY: a transient NON-Error rejection (a plain object with a status) is released, wrapped into a fresh Error — which is no longer transient — and so ends up recorded failed (not re-thrown) even on attempt 1', async () => {
    vi.mocked(analyzePortfolios).mockRejectedValue({ status: 429, toString: () => 'slow down' });
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    // order matters: first handed back (inner settle), then recorded failed (outer catch, on the wrapped Error)
    expect(writes().map(w => w.sql)).toEqual([SQL_CLAIM, SQL_RELEASE, SQL_FAIL]);
    expect(failMessages()).toEqual(['Analysis failed — slow down. Use Re-run to retry.']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    nothingApplied();
  });

  it('ODDITY: a plain object without a custom toString loses its message when wrapped — "[object Object]" is what gets recorded', async () => {
    vi.mocked(analyzePortfolios).mockRejectedValue({ status: 429, message: 'rate limited' });
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — [object Object]. Use Re-run to retry.']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — unexpected exceptions (the outer catch)', () => {
  it('a failure while scoring is recorded as "Analysis failed — …" and logged', async () => {
    vi.mocked(applyPortfolioOutcome).mockRejectedValue(new Error('deadlock detected'));
    const r = await run(MAX_ATTEMPTS);
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — deadlock detected. Use Re-run to retry.']);
    expect(errorSpy).toHaveBeenCalledWith('[Portfolio] Analysis failed for', APP_ID, expect.any(Error));
  });

  it('a non-transient scoring failure is recorded even on attempt 1 (no retry)', async () => {
    vi.mocked(applyPortfolioOutcome).mockRejectedValue(new Error('deadlock detected'));
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(releases()).toEqual([]);
  });

  it('a transient scoring/database failure (ECONNRESET) on attempt 1 hands the job back and re-throws', async () => {
    const err = new Error('read ECONNRESET');
    vi.mocked(applyPortfolioOutcome).mockRejectedValue(err);
    await expect(run(1)).rejects.toBe(err);
    expect(releases().length).toBeGreaterThan(0);
    expect(failures()).toEqual([]);
  });

  it('a failing lookup is handled the same way', async () => {
    queryOne.mockRejectedValue(new Error('connection terminated unexpectedly'));
    await expect(run(MAX_ATTEMPTS)).resolves.toEqual({ ran: true, status: 'failed' });
    expect(failMessages()).toEqual(['Analysis failed — connection terminated unexpectedly. Use Re-run to retry.']);
    browserNeverOpened();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — recording a failure', () => {
  it('stores at most 500 characters of the message (the Re-run hint is the first thing cut off)', async () => {
    const long = 'x'.repeat(800);
    vi.mocked(analyzePortfolios).mockRejectedValue(new Error(long));
    await run(MAX_ATTEMPTS);
    const [msg] = failMessages();
    expect(msg).toHaveLength(500);
    expect(msg).toBe(`Analysis failed — ${long}. Use Re-run to retry.`.slice(0, 500));
    expect(msg.endsWith('Use Re-run to retry.')).toBe(false);
  });

  it('a failing "record failed" write is swallowed — the run still reports failed', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/RETURNING id/.test(sql)) return [{ id: APP_ID }];
      throw new Error('db is down');
    });
    db.role = { id: 'R007', portfolio_analysis_enabled: false };
    await expect(run(1)).resolves.toEqual({ ran: true, status: 'failed' });
  });

  it('a failing hand-back write is swallowed — the ORIGINAL error is still what the queue sees', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/RETURNING id/.test(sql)) return [{ id: APP_ID }];
      throw new Error('db is down');
    });
    captures(cap('error', { accessNote: 'timeout' }));
    await expect(run(1)).rejects.toThrowError(new Error('Could not open the portfolio (timeout)'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('isTransient', () => {
  const withStatus = (status: unknown, message = 'plain failure') => Object.assign(new Error(message), { status });

  it('BrowserBusyError is transient', () => {
    expect(isTransient(new BrowserBusyError())).toBe(true);
  });

  it('...but only by class: a plain Error carrying the same words is not', () => {
    expect(isTransient(new Error('Another portfolio review is using the browser on this instance'))).toBe(false);
  });

  it.each([408, 409, 425, 429, 500, 502, 503, 504, 529])('HTTP status %i is transient whatever the message says', (status) => {
    expect(isTransient(withStatus(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 413, 422, 501, 505, 530])('HTTP status %i with an unremarkable message is not transient', (status) => {
    expect(isTransient(withStatus(status))).toBe(false);
  });

  it('a status outside the list does not veto a transient message', () => {
    expect(isTransient(withStatus(400, 'rate limit exceeded'))).toBe(true);
  });

  it('a status that is not a number is ignored (falls through to the message)', () => {
    expect(isTransient(withStatus('429', 'nope'))).toBe(false);
    expect(isTransient(withStatus('429', 'overloaded'))).toBe(true);
    expect(isTransient(withStatus(0))).toBe(false);
  });

  it('plain objects are inspected the same way as Errors', () => {
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ message: 'ECONNRESET' })).toBe(true);
  });

  it.each([
    'timeout',
    'Timeout',
    'timed out',
    'Request timed out.',
    'time out',
    'timedout',
    'Navigation timeout of 25000 ms exceeded',
    'connect ETIMEDOUT 10.0.0.1:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'fetch failed',
    'Failed to launch the browser process',
    'Protocol error (Page.captureScreenshot): Target closed',
    'Overloaded',
    'overloaded_error',
    'rate limit exceeded',
    'rate_limit_error',
    'Rate-limited',
    'ratelimit',
  ])('message %j is transient', (message) => {
    expect(isTransient(new Error(message))).toBe(true);
  });

  it.each([
    '',
    'Something unexpected',
    'Could not parse model JSON',
    'invalid_request_error: prompt is too long',
    'Portfolio is private or requires access',
    'No page content could be read',
    'Link not safe or not resolvable (nope)',
    'Time budget exhausted before this portfolio could be opened',
    'Time budget exceeded while loading the site',
    'time  out',
  ])('message %j is not transient', (message) => {
    expect(isTransient(new Error(message))).toBe(false);
  });

  it.each([null, undefined, 0, '', {}, new Error()])('%j carries nothing to inspect: not transient', (value) => {
    expect(isTransient(value)).toBe(false);
  });

  it('ODDITY: a bare string is never inspected, so a thrown "timeout" string is not transient', () => {
    expect(isTransient('timeout')).toBe(false);
    expect(isTransient('rate limit')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A bot check we cannot pass is neutral: the dimension is not applied (designer path)
// ════════════════════════════════════════════════════════════════════════════
describe('runPortfolioAnalysis — every link sits behind a bot check (unreviewable)', () => {
  const WALL_NOTE = 'Site is protected by a bot check (Cloudflare/captcha) - cannot be opened automatically';
  const walled = (over: Partial<CapturedPortfolio> = {}) => cap('unreviewable', { accessNote: WALL_NOTE, ...over });

  it('a single walled link: status unreviewable, no score, no flag, the note as the message — and no model call', async () => {
    captures(walled());
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'unreviewable' });
    // exactly these keys: no analysis is stored, nothing is scored, nothing is held against the candidate
    expect(applied()).toStrictEqual({ status: 'unreviewable', score: null, note: '', redFlags: [], message: WALL_NOTE });
    expect(analyzePortfolios).not.toHaveBeenCalled();
    expect(writes().map(w => w.sql)).toEqual([SQL_CLAIM]);
  });

  it('is recorded with no fold-policy argument: it is the designer path (the marketing dispatch passes its own)', async () => {
    captures(walled());
    await run(1);
    expect(vi.mocked(applyPortfolioOutcome).mock.calls[0]).toHaveLength(2);
  });

  it('several walled links: the notes are joined with "; "', async () => {
    captures(walled({ accessNote: 'first wall' }), walled({ link: LINK2, accessNote: 'second wall' }));
    await run(1);
    expect(applied().message).toBe('first wall; second wall');
  });

  it('a walled link without a note records no message (not an empty string)', async () => {
    captures(cap('unreviewable'));
    await run(1);
    const out = applied();
    expect(out.status).toBe('unreviewable');
    expect(out.message).toBeUndefined();
  });

  it('notes missing on some links are skipped when joining', async () => {
    captures(cap('unreviewable'), walled({ link: LINK2, accessNote: 'only note' }));
    await run(1);
    expect(applied().message).toBe('only note');
  });

  it.each([1, 2, MAX_ATTEMPTS, undefined])('attempt %s: never retried, released or recorded as failed — a wall would be met again', async (attempt) => {
    captures(walled());
    await expect(run(attempt)).resolves.toEqual({ ran: true, status: 'unreviewable' });
    expect(releases()).toEqual([]);
    expect(failures()).toEqual([]);
  });
});

describe('runPortfolioAnalysis — an unreviewable link next to other outcomes', () => {
  const WALL_NOTE = 'Site is protected by a bot check (Cloudflare/captcha) - cannot be opened automatically';
  const BLOCKED_NOTE = 'Portfolio is private or requires access';
  const SKIPPED_NOTE = 'File / slide-deck link — not opened automatically; review manually';
  const walled = (over: Partial<CapturedPortfolio> = {}) => cap('unreviewable', { accessNote: WALL_NOTE, ...over });

  it('beside a BLOCKED link: still the legacy inaccessible verdict (score 1); only the blocked note is held against them', async () => {
    captures(walled(), cap('blocked', { link: LINK2, accessNote: BLOCKED_NOTE }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'inaccessible' });
    expect(applied()).toMatchObject({
      status: 'inaccessible', score: 1, note: 'Portfolio link not reachable',
      redFlags: [`Portfolio link not reviewable — ${BLOCKED_NOTE}`], message: BLOCKED_NOTE,
    });
    // ...but the walled link is still listed, truthfully, in what was reviewed
    expect(applied().analysis!.portfolios.map(p => p.accessKind)).toEqual(['unreviewable', 'blocked']);
    expect(applied().analysis!.portfolios[0]).toMatchObject({ accessible: false, accessNote: WALL_NOTE });
  });

  it('beside a file/deck link: still the legacy file verdict (score 3)', async () => {
    captures(walled(), cap('skipped', { link: LINK2, accessNote: SKIPPED_NOTE }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'inaccessible' });
    expect(applied()).toMatchObject({ status: 'inaccessible', score: 3, note: 'Portfolio is a file/deck link', message: SKIPPED_NOTE });
  });

  it.each([
    ['blocked', cap('blocked', { link: LINK2, accessNote: BLOCKED_NOTE })],
    ['skipped', cap('skipped', { link: LINK2, accessNote: SKIPPED_NOTE })],
    ['unreviewable', walled({ link: LINK2 })],
  ])('beside an ERRORED link (%s as the third): a failure on our side comes first, nothing is recorded as unreviewable', async (_n, third) => {
    captures(walled(), cap('error', { link: LINK2, accessNote: 'No page content could be read' }), third);
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'failed' });
    nothingApplied();
    expect(failMessages()).toEqual(['Portfolio capture failed — Could not open the portfolio (No page content could be read). Use Re-run to retry.']);
  });

  it('beside a READABLE portfolio: analysed as before — every capture goes to the model and the wall is not counted as an error', async () => {
    const caps = [cap('ok'), walled({ link: LINK2 })];
    captures(...caps);
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'completed' });
    expect(analyzePortfolios).toHaveBeenCalledWith(CANDIDATE, ROLE, caps, { deadline: T0 + 270_000 });
    expect(applied()).toMatchObject({ status: 'completed', score: 7 });
    expect(applied().message).toBeUndefined();   // "N links could not be opened" is for OUR failures only
  });

  it('beside a readable page that the model says is not a portfolio: still no_portfolio, never unreviewable', async () => {
    captures(cap('ok'), walled({ link: LINK2 }));
    analysis(analysisOf({ portfolios: [reviewed({ isPortfolio: false })], score: 6 }));
    const r = await run(1);
    expect(r).toEqual({ ran: true, status: 'no_portfolio' });
    expect(applied()).toMatchObject({ status: 'no_portfolio', score: 1, note: 'No usable portfolio found' });
  });
});
