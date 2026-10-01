import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: vi.fn() }));
const send = vi.fn();
vi.mock('@vercel/queue', () => ({ send: (...a: unknown[]) => send(...a) }));

import { enqueuePortfolioAnalysis, markPortfolioGaveUp, portfolioNeedsReview, PORTFOLIO_TOPIC } from './enqueue.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

const sql = (call: number) => String(query.mock.calls[call][0]).replace(/\s+/g, ' ');

beforeEach(() => { query.mockReset().mockResolvedValue([]); send.mockReset().mockResolvedValue({ messageId: 'm1' }); });

describe('enqueuePortfolioAnalysis payload', () => {
  it('first send is exactly the original { applicationId } message with no options', async () => {
    await enqueuePortfolioAnalysis('A0611');
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: 'A0611' }, undefined);
  });

  it('a hand-back carries both counters and the delay', async () => {
    await enqueuePortfolioAnalysis('A0611', { busyRetries: 4, attemptsUsed: 2, delaySeconds: 75 });
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: 'A0611', busyRetries: 4, attemptsUsed: 2 }, { delaySeconds: 75 });
  });

  it('a send failure is reported, and the error note is written only while the review is still waiting', async () => {
    send.mockRejectedValue(new Error('queue down'));
    const r = await enqueuePortfolioAnalysis('A0611', { busyRetries: 1, delaySeconds: 60 });
    expect(r).toMatchObject({ enqueued: false, error: 'queue down' });
    expect(sql(0)).toMatch(/SET portfolio_analysis_error=\$1 WHERE id=\$2 AND portfolio_analysis_status='pending'/);
  });
});

describe('markPortfolioGaveUp only touches a review that is genuinely still waiting', () => {
  it("fails a 'pending' row or a 'running' row past the point a live worker could hold it — nothing else", async () => {
    await markPortfolioGaveUp('A0611', 'gave up');
    const s = sql(0);
    expect(s).toMatch(/SET portfolio_analysis_status='failed'/);
    expect(s).toMatch(/portfolio_analysis_status='pending'/);
    expect(s).toMatch(/portfolio_analysis_status='running' AND portfolio_started_at < NOW\(\) - \(\$3 \|\| ' seconds'\)::interval/);
    // the states it must never overwrite are simply not named as targets
    for (const settled of ['completed', 'inaccessible', 'no_portfolio']) expect(s).not.toContain(`'${settled}'`);
    expect(query.mock.calls[0][1]).toEqual(['gave up', 'A0611', String(STALE_RUNNING_SECONDS)]);
  });

  it('truncates a long message to the column budget', async () => {
    await markPortfolioGaveUp('A0611', 'x'.repeat(900));
    expect((query.mock.calls[0][1] as string[])[0].length).toBe(500);
  });
});

describe('portfolioNeedsReview', () => {
  it('is true when the database says the review is still waiting', async () => {
    query.mockResolvedValue([{ needs: true }]);
    expect(await portfolioNeedsReview('A0611')).toBe(true);
    expect(sql(0)).toMatch(/IN \('pending','failed'\)/);
    expect(sql(0)).toMatch(/'running' AND portfolio_started_at < NOW\(\)/);
  });

  it('is false when it has settled, a live worker holds it, or the application is gone', async () => {
    query.mockResolvedValue([{ needs: false }]);
    expect(await portfolioNeedsReview('A0611')).toBe(false);
    query.mockResolvedValue([]);
    expect(await portfolioNeedsReview('A9999')).toBe(false);
    query.mockResolvedValue([{ needs: null }]);       // a NULL status (never prepared) is not "needs a review"
    expect(await portfolioNeedsReview('A0001')).toBe(false);
  });
});
