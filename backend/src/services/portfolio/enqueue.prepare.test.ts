import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Characterization tests for preparePortfolioReview and the small row-state helpers in enqueue.ts
// (markPortfolioFailed / markPortfolioGaveUp / portfolioNeedsReview). They pin what the code does
// TODAY so the portfolio pipeline can be refactored to host a second review kind without changing
// anything R007 sees. enqueue.test.ts already covers the queue payload shape, the guard regexes of
// markPortfolioGaveUp and the true/false mapping of portfolioNeedsReview — this file does not repeat
// those cases; it adds the whole of preparePortfolioReview plus exact SQL / parameter pins.
const query = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: vi.fn(), transaction: vi.fn() }));
const applyPortfolioOutcome = vi.fn();
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: (...a: unknown[]) => applyPortfolioOutcome(...a) }));
const send = vi.fn();
vi.mock('@vercel/queue', () => ({ send: (...a: unknown[]) => send(...a) }));

import {
  PORTFOLIO_TOPIC, markPortfolioFailed, markPortfolioGaveUp, portfolioNeedsReview, preparePortfolioReview,
} from './enqueue.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';
import type { PortfolioLink } from './types.js';

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const sqlOf = (call: number) => norm(query.mock.calls[call][0]);
const paramsOf = (call: number) => query.mock.calls[call][1] as unknown[];
const STALE = String(STALE_RUNNING_SECONDS);

const LINK_A: PortfolioLink = { url: 'https://jane.design', host: 'jane.design', platform: 'custom' };
const LINK_B: PortfolioLink = { url: 'https://www.behance.net/jane', host: 'behance.net', platform: 'behance' };

// The conditional "reset to pending" UPDATE. The no-link variant renumbers the staleness parameter
// from $3 to $2 (it has no links parameter), the with-links variant keeps $3.
const NOT_RUNNING = (p: '$2' | '$3') =>
  `(portfolio_analysis_status IS DISTINCT FROM 'running' OR portfolio_started_at < NOW() - (${p} || ' seconds')::interval)`;
const RESET_NO_LINKS_SQL =
  `UPDATE applications SET portfolio_urls='[]'::jsonb, portfolio_analysis_status='pending', portfolio_analysis_error=NULL `
  + `WHERE id=$1 AND ${NOT_RUNNING('$2')} RETURNING id`;
const RESET_WITH_LINKS_SQL =
  `UPDATE applications SET portfolio_urls=$1::jsonb, portfolio_analysis_status='pending', portfolio_analysis_error=NULL `
  + `WHERE id=$2 AND ${NOT_RUNNING('$3')} RETURNING id`;

beforeEach(() => {
  query.mockReset().mockResolvedValue([{ id: 'A0611' }]);     // by default the reset claims the row
  applyPortfolioOutcome.mockReset().mockResolvedValue({ avg: null });
  send.mockReset().mockResolvedValue({ messageId: 'm1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the queue topic', () => {
  it('is portfolio-analysis', () => {
    expect(PORTFOLIO_TOPIC).toBe('portfolio-analysis');
  });
});

describe('preparePortfolioReview — the resume has no portfolio link', () => {
  it('readable resume: resets the row conditionally in SQL, then records "no portfolio" as a 0 with a red flag', async () => {
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead: true });

    // exactly one statement: the conditional reset (portfolio_urls emptied, status pending, error cleared)
    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toBe(RESET_NO_LINKS_SQL);
    expect(paramsOf(0)).toEqual(['A0611', STALE]);

    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    const [id, outcome] = applyPortfolioOutcome.mock.calls[0];
    expect(id).toBe('A0611');
    expect(outcome).toStrictEqual({
      status: 'no_portfolio',
      score: 0,
      note: 'No portfolio link in resume',
      oneLiner: 'No portfolio link was found in the resume, so the portfolio could not be reviewed.',
      redFlags: ['No portfolio link found in the resume'],
    });

    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('unreadable resume: the dimension is not applied at all (score null) and the reason is stored as the message', async () => {
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead: false });

    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    expect(applyPortfolioOutcome.mock.calls[0][0]).toBe('A0611');
    expect(applyPortfolioOutcome.mock.calls[0][1]).toStrictEqual({
      status: 'no_portfolio',
      score: null,
      note: '',
      redFlags: [],
      message: 'The resume could not be read, so no portfolio link could be extracted.',
    });
    // no oneLiner key on this branch, and nothing is queued
    expect('oneLiner' in applyPortfolioOutcome.mock.calls[0][1]).toBe(false);
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('settles the outcome only AFTER the reset has claimed the row', async () => {
    await preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead: true });
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(applyPortfolioOutcome.mock.invocationCallOrder[0]);
  });

  it("a review a live worker holds (reset returns no row) is 'busy': nothing is written and no outcome is applied", async () => {
    query.mockResolvedValue([]);
    for (const resumeRead of [true, false]) {
      applyPortfolioOutcome.mockClear();
      const r = await preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead });
      expect(r).toStrictEqual({ status: 'busy', links: [], queued: false });
      expect(applyPortfolioOutcome).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);     // one reset attempt per call, no follow-up writes
  });

  it('a database failure on the reset propagates (the trigger turns it into "the 8-dimension score stands")', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead: true })).rejects.toThrow('db down');
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('a failure while applying the outcome propagates as well', async () => {
    applyPortfolioOutcome.mockRejectedValue(new Error('Application not found'));
    await expect(preparePortfolioReview({ applicationId: 'A0611', links: [], resumeRead: true })).rejects.toThrow('Application not found');
  });
});

describe('preparePortfolioReview — links were found', () => {
  it("stores the links as JSON, resets to 'pending', and queues the application id only", async () => {
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });

    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toBe(RESET_WITH_LINKS_SQL);
    expect(paramsOf(0)).toEqual([JSON.stringify([LINK_A]), 'A0611', STALE]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: 'A0611' }, undefined);

    expect(r).toStrictEqual({ status: 'pending', links: [LINK_A], queued: true });
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('keeps the links in the order given (JSON.stringify of the whole array) and returns the same links', async () => {
    const links = [LINK_A, LINK_B];
    const r = await preparePortfolioReview({ applicationId: 'A0611', links, resumeRead: true });
    expect(paramsOf(0)[0]).toBe(JSON.stringify([LINK_A, LINK_B]));
    expect(r.links).toBe(links);
  });

  it('whether the resume was readable makes no difference once a link exists', async () => {
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: false });
    expect(r).toStrictEqual({ status: 'pending', links: [LINK_A], queued: true });
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: 'A0611' }, undefined);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('queues only AFTER the reset has claimed the row', async () => {
    await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it("a review a live worker holds (reset returns no row) is 'busy': the links are returned, nothing is queued or applied", async () => {
    query.mockResolvedValue([]);
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A, LINK_B], resumeRead: true });
    expect(r).toStrictEqual({ status: 'busy', links: [LINK_A, LINK_B], queued: false });
    expect(send).not.toHaveBeenCalled();
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("a failed hand-off to the queue: still 'pending', queued false, and the visible note is written only while the row is pending", async () => {
    send.mockRejectedValue(new Error('queue down'));
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });

    expect(r).toStrictEqual({ status: 'pending', links: [LINK_A], queued: false });
    expect(query).toHaveBeenCalledTimes(2);       // reset, then the note
    expect(sqlOf(1)).toBe(
      `UPDATE applications SET portfolio_analysis_error=$1 WHERE id=$2 AND portfolio_analysis_status='pending'`,
    );
    expect(paramsOf(1)).toEqual(['Could not be queued (queue down). Use Re-run to retry.', 'A0611']);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('truncates the queue error to 300 characters before it is shown', async () => {
    send.mockRejectedValue(new Error('x'.repeat(900)));
    await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });
    expect(paramsOf(1)[0]).toBe(`Could not be queued (${'x'.repeat(300)}). Use Re-run to retry.`);
  });

  it('a failure writing that note is swallowed — the caller still gets the pending/not-queued answer', async () => {
    send.mockRejectedValue(new Error('queue down'));
    query.mockResolvedValueOnce([{ id: 'A0611' }]).mockRejectedValueOnce(new Error('db hiccup'));
    const r = await preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });
    expect(r).toStrictEqual({ status: 'pending', links: [LINK_A], queued: false });
  });

  it('a queue that never answers is abandoned after 8 seconds and treated like any other send failure', async () => {
    vi.useFakeTimers();
    try {
      send.mockReturnValue(new Promise(() => {}));            // never settles
      const pending = preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true });
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(8000);
      const r = await pending;
      expect(r).toStrictEqual({ status: 'pending', links: [LINK_A], queued: false });
      expect(paramsOf(1)[0]).toBe('Could not be queued (queue did not respond within 8s). Use Re-run to retry.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a database failure on the reset propagates and nothing is queued', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(preparePortfolioReview({ applicationId: 'A0611', links: [LINK_A], resumeRead: true })).rejects.toThrow('db down');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('markPortfolioFailed (a failure that is ours, so it can be re-run)', () => {
  it("fails any row except one a live worker is 'running' — and nothing else about its status is checked", async () => {
    await markPortfolioFailed('A0611', 'The resume\'s links could not be read. Use Re-run to retry.');
    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toBe(
      `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 `
      + `WHERE id=$2 AND portfolio_analysis_status IS DISTINCT FROM 'running'`,
    );
    expect(paramsOf(0)).toEqual(['The resume\'s links could not be read. Use Re-run to retry.', 'A0611']);
    // unlike markPortfolioGaveUp, it has no 'pending' / stale-running clause and takes no staleness parameter
    expect(sqlOf(0)).not.toContain("'pending'");
    expect(paramsOf(0)).toHaveLength(2);
  });

  it('truncates a long message to 500 characters', async () => {
    await markPortfolioFailed('A0611', 'y'.repeat(900));
    expect((paramsOf(0)[0] as string).length).toBe(500);
  });

  it('never throws, even if the database does', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(markPortfolioFailed('A0611', 'boom')).resolves.toBeUndefined();
  });
});

describe('markPortfolioGaveUp — exact statement', () => {
  it('pins the full SQL and parameter order (enqueue.test.ts pins the guards by regex)', async () => {
    await markPortfolioGaveUp('A0611', 'gave up');
    expect(sqlOf(0)).toBe(
      `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 `
      + `WHERE id=$2 AND ( portfolio_analysis_status='pending' `
      + `OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($3 || ' seconds')::interval) )`,
    );
    expect(paramsOf(0)).toEqual(['gave up', 'A0611', STALE]);
  });

  it('never throws, even if the database does', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(markPortfolioGaveUp('A0611', 'gave up')).resolves.toBeUndefined();
  });
});

describe('portfolioNeedsReview — exact statement', () => {
  it('pins the full SQL and parameter order (enqueue.test.ts pins the true/false mapping)', async () => {
    query.mockResolvedValue([{ needs: true }]);
    await portfolioNeedsReview('A0611');
    expect(sqlOf(0)).toBe(
      `SELECT (portfolio_analysis_status IN ('pending','failed') `
      + `OR (portfolio_analysis_status='running' AND portfolio_started_at < NOW() - ($2 || ' seconds')::interval)) AS needs `
      + `FROM applications WHERE id=$1`,
    );
    expect(paramsOf(0)).toEqual(['A0611', STALE]);
  });

  it('only a real boolean true counts (a truthy non-boolean does not)', async () => {
    query.mockResolvedValue([{ needs: 't' }]);
    expect(await portfolioNeedsReview('A0611')).toBe(false);
    query.mockResolvedValue([{ needs: 1 }]);
    expect(await portfolioNeedsReview('A0611')).toBe(false);
  });

  it('unlike the two writers, a database failure propagates to the caller', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(portfolioNeedsReview('A0611')).rejects.toThrow('db down');
  });
});
