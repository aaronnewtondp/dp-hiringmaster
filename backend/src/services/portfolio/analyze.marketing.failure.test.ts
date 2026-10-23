import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Acquired } from './acquire/types.js';
import type { PortfolioLink } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What HR reads in portfolio_analysis_error when the MODEL API fails. This runs the REAL path end to end: run.ts (claim, settleFailure,
// the stored "<prefix> — <message>. Use Re-run to retry."), the real run.marketing.ts and the REAL analyzer; only the database (a
// recording stub), the browser and the fetchers (no network) and the Anthropic SDK (a canned failure) are replaced.
//
// The second review (finding 22): the stored text read "Analysis failed — Analysis failed - the reviewer service rejected the request"
// for every status, including the 429/5xx that are OUR transient failures. It now reads once, and says what happened.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: (...a: unknown[]) => h.create(...a) };
  },
}));

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a), transaction: vi.fn() }));
vi.mock('./browser.js', async () => {
  const actual = await vi.importActual<typeof import('./browser.js')>('./browser.js');
  return { ...actual, isBrowserInUse: () => false, withBrowser: vi.fn() };
});
vi.mock('./capture.js', async () => {
  const actual = await vi.importActual<typeof import('./capture.js')>('./capture.js');
  return { ...actual, capturePortfolios: vi.fn() };
});
vi.mock('./analyze.js', () => ({ analyzePortfolios: vi.fn() }));
vi.mock('./acquire/index.js', async () => {
  const actual = await vi.importActual<typeof import('./acquire/index.js')>('./acquire/index.js');
  return { ...actual, acquireFetchItems: vi.fn() };
});
vi.mock('./acquire/fetchers.js', () => ({ defaultFetchers: {} }));
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: vi.fn() }));

import { acquireFetchItems } from './acquire/index.js';
import { MAX_ATTEMPTS, runPortfolioAnalysis } from './run.js';

const APP_ID = 'A0901';
const DOC: PortfolioLink = { url: 'https://drive.google.com/file/d/1AbCdEfGhIjK/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' };
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const SQL_FAIL = "UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 WHERE id=$2";
const SQL_RELEASE = "UPDATE applications SET portfolio_analysis_status='pending', portfolio_started_at=NULL WHERE id=$1 AND portfolio_analysis_status='running'";
const stored = () => query.mock.calls.filter(c => norm(c[0]) === SQL_FAIL).map(c => (c[1] as string[])[0]);
const released = () => query.mock.calls.filter(c => norm(c[0]) === SQL_RELEASE).length;

const opened = (): Acquired => ({
  ref: 'L1', link: DOC, outcome: 'ok', basis: 'artifact', media: [], facts: [], injectionHit: false,
  text: 'Brand playbook for a water utility. Concept and direction: Jonathan Whitfield. Five campaigns shown: Clean Water Week, Jal Diwas, Monsoon Ready.',
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.create.mockReset();
  query.mockReset().mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) ? [{ id: APP_ID }] : []));   // the claim succeeds
  queryOne.mockReset().mockImplementation(async (sql: string) => {
    if (/FROM applications/.test(sql)) return { id: APP_ID, candidate_id: 'C1', role_id: 'R019', portfolio_urls: [DOC], score_portfolio: null, screening_answers: [] };
    if (/FROM candidates/.test(sql)) return { id: 'C1', full_name: 'Jane Doe' };
    if (/FROM roles/.test(sql)) return { id: 'R019', title: 'Head of Marketing', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' };
    return null;
  });
  vi.mocked(acquireFetchItems).mockReset().mockResolvedValue([opened()]);
});
afterEach(() => { errorSpy.mockRestore(); });

describe('a failed model call, as HR reads it in the stored error', () => {
  it.each([429, 500, 503, 529])('status %s is OUR transient failure: "busy or unavailable", the prefix once, never "rejected the request"', async status => {
    h.create.mockRejectedValue(Object.assign(new Error(`${status} {"error":{"message":"rate limit for key sk-secret-123"}}`), { status }));
    await runPortfolioAnalysis(APP_ID, { attempt: MAX_ATTEMPTS });
    expect(stored()).toEqual(['Analysis failed — the reviewer service was busy or unavailable. Use Re-run to retry.']);
  });

  it.each([400, 401, 403, 404, 422])('status %s is a refused request: "could not process the request"', async status => {
    h.create.mockRejectedValue(Object.assign(new Error(`${status} {"error":{"message":"https://api.example/v1/secret?key=sk-secret-123"}}`), { status }));
    await runPortfolioAnalysis(APP_ID, { attempt: MAX_ATTEMPTS });
    expect(stored()).toEqual(['Analysis failed — the reviewer service could not process the request. Use Re-run to retry.']);
  });

  it('a timeout or a dropped connection (no status) reads as busy or unavailable', async () => {
    h.create.mockRejectedValue(new Error('Request timed out.'));
    await runPortfolioAnalysis(APP_ID, { attempt: MAX_ATTEMPTS });
    expect(stored()).toEqual(['Analysis failed — the reviewer service was busy or unavailable. Use Re-run to retry.']);
  });

  it('the stored text never carries a key, a URL or the API\'s own words, and never repeats the prefix', async () => {
    h.create.mockRejectedValue(Object.assign(new Error('400 {"error":{"message":"Bad request for https://api.example/v1?key=sk-secret-123 body: the candidate wrote ..."}}'), { status: 400 }));
    await runPortfolioAnalysis(APP_ID, { attempt: MAX_ATTEMPTS });
    const text = stored()[0] as string;
    expect(text).not.toMatch(/sk-secret|https?:|the candidate wrote|key=/);
    expect(text.match(/Analysis failed/g)).toHaveLength(1);
    expect(text).not.toMatch(/Analysis failed - /);
    expect(text.length).toBeLessThan(200);
  });

  it('on an early attempt a transient failure is handed back to the queue (nothing is stored), a refused request is stored at once', async () => {
    h.create.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    await expect(runPortfolioAnalysis(APP_ID, { attempt: 1 })).rejects.toMatchObject({ status: 529, message: 'the reviewer service was busy or unavailable' });
    expect(stored()).toEqual([]);
    expect(released()).toBeGreaterThanOrEqual(1);   // (run.ts's outer catch settles the rethrown error once more: a conditional UPDATE, harmless)
    h.create.mockRejectedValue(Object.assign(new Error('invalid'), { status: 400 }));
    await runPortfolioAnalysis(APP_ID, { attempt: 1 });
    expect(stored()).toEqual(['Analysis failed — the reviewer service could not process the request. Use Re-run to retry.']);
  });
});
