import { describe, it, expect, vi, beforeEach } from 'vitest';

// run.ts with every external piece replaced: the database is a recording stub, the
// browser/capture/analysis/scoring modules are mocks. What is under test is the
// decision it makes when the instance's browser is taken.
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
import { BUSY_WAIT_MS, MAX_ATTEMPTS, runPortfolioAnalysis } from './run.js';

const sqls = () => query.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' '));
const wrote = (re: RegExp) => sqls().some(s => re.test(s));

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  browser.inUse.mockReset().mockReturnValue(false);
  browser.withBrowser.mockReset();
  query.mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) ? [{ id: 'A0611' }] : []));   // the claim succeeds
  queryOne.mockImplementation(async (sql: string) => {
    if (/FROM applications/.test(sql)) return { id: 'A0611', candidate_id: 'C1', role_id: 'R007', portfolio_urls: [{ url: 'https://x.example', host: 'x.example', platform: 'custom' }] };
    if (/FROM candidates/.test(sql)) return { id: 'C1', full_name: 'Test Candidate' };
    if (/FROM roles/.test(sql)) return { id: 'R007', portfolio_analysis_enabled: true };
    return null;
  });
});

describe('runPortfolioAnalysis when the browser is taken', () => {
  it('reports busy without touching the database at all if the browser is already in use', async () => {
    browser.inUse.mockReturnValue(true);
    const r = await runPortfolioAnalysis('A0611', { attempt: 1 });
    expect(r).toMatchObject({ ran: false, status: 'busy' });
    expect(query).not.toHaveBeenCalled();
    expect(browser.withBrowser).not.toHaveBeenCalled();
  });

  it('if it loses the race after claiming, puts the job back to pending and reports busy — it does not record a failure', async () => {
    browser.withBrowser.mockRejectedValue(new BrowserBusyError());
    const r = await runPortfolioAnalysis('A0611', { attempt: 1 });
    expect(r).toMatchObject({ ran: false, status: 'busy' });
    expect(wrote(/status='pending', portfolio_started_at=NULL/)).toBe(true);   // released
    expect(wrote(/status='failed'/)).toBe(false);
  });

  it('never burns a delivery attempt on it: busy is busy on the last attempt and on a direct run too', async () => {
    browser.withBrowser.mockRejectedValue(new BrowserBusyError());
    for (const attempt of [MAX_ATTEMPTS, undefined]) {
      query.mockClear();
      const r = await runPortfolioAnalysis('A0611', attempt === undefined ? {} : { attempt });
      expect(r.status).toBe('busy');
      expect(wrote(/status='failed'/)).toBe(false);
    }
  });

  it('waits only a few seconds for the browser (the occupant needs minutes — the caller retries later)', async () => {
    browser.withBrowser.mockRejectedValue(new BrowserBusyError());
    await runPortfolioAnalysis('A0611', { attempt: 1 });
    expect(browser.withBrowser).toHaveBeenCalledWith(expect.any(Function), { maxWaitMs: BUSY_WAIT_MS });
    expect(BUSY_WAIT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('other transient failures keep their existing behaviour', () => {
  it('on an early attempt: hands the job back and throws so the queue redelivers', async () => {
    browser.withBrowser.mockRejectedValue(new Error('Failed to launch the browser process'));
    await expect(runPortfolioAnalysis('A0611', { attempt: 1 })).rejects.toThrow(/Failed to launch/);
    expect(wrote(/status='pending', portfolio_started_at=NULL/)).toBe(true);
    expect(wrote(/status='failed'/)).toBe(false);
  });

  it('on the last attempt: records a failure with a Re-run hint instead of throwing', async () => {
    browser.withBrowser.mockRejectedValue(new Error('Failed to launch the browser process'));
    const r = await runPortfolioAnalysis('A0611', { attempt: MAX_ATTEMPTS });
    expect(r).toEqual({ ran: true, status: 'failed' });
    expect(wrote(/status='failed'/)).toBe(true);
  });
});
