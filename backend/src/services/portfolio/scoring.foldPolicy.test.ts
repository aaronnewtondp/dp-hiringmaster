import { describe, it, expect, vi, beforeEach } from 'vitest';

// The fold-policy knob and the 'unreviewable' status in applyPortfolioOutcome (scoring.ts). The default
// ('always') behaviour is pinned by scoring.test.ts; this file covers only what the marketing review added.
// 'upside_only' used to leave score_avg / ai_fit_score / the summary and flags untouched when a score was below the
// candidate's own average. After a re-run that does WORSE than an earlier folded one that left the old, higher
// portfolio score inside the average (review finding 1.10), so that branch now puts everything back to the 8 base scores.
type Row = Record<string, unknown>;
interface Call { sql: string; params: unknown[] }

const txn = vi.fn();
vi.mock('../../db/index.js', () => ({ transaction: (...a: unknown[]) => txn(...a) }));

import { applyPortfolioOutcome } from './scoring.js';
import type { PortfolioOutcome } from './scoring.js';
import { computeAvg } from './rubric.js';
import { priorityBucketFromScore } from '../resumeIQ.js';
import { SLA_HOURS } from '../../types/index.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const APPLIED = 'UPDATE applications SET score_portfolio=$1, score_portfolio_note=$2, score_avg=$3';
const STATUS_ONLY =
  'UPDATE applications SET portfolio_analysis_status=$1, portfolio_analysis_error=$2, portfolio_analyzed_at=NOW() WHERE id=$3';

const COLS = ['score_technical', 'score_experience', 'score_industry_fit', 'score_culture_fit',
  'score_role_alignment', 'score_trajectory', 'score_leadership', 'score_communication'];
const baseRow = (n: number, over: Row = {}): Row => ({
  id: 'A0700', candidate_id: 'C0700', role_id: 'R019', stage: 'Applied and Screened',
  ...Object.fromEntries(COLS.map(c => [c, n])), score_summary: 'Base.', score_red_flags: [], ...over,
});
const outcome = (over: Partial<PortfolioOutcome> = {}): PortfolioOutcome =>
  ({ status: 'completed', score: 5, note: 'Thin on outcomes', oneLiner: 'Some campaigns.', redFlags: [], ...over });

let calls: Call[] = [];
let stored: Row | undefined;
const client = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql: norm(sql), params });
    return /FOR UPDATE/.test(sql) ? { rows: stored ? [stored] : [] } : { rows: [] };
  }),
};
async function apply(row: Row, out: PortfolioOutcome, opts?: { foldPolicy?: 'always' | 'upside_only' }) {
  stored = row; calls = [];
  const result = await applyPortfolioOutcome('A0700', out, opts);
  return { result, calls: [...calls] };
}
const find = (cs: Call[], prefix: string) => cs.find(c => c.sql.startsWith(prefix));

beforeEach(() => {
  calls = []; stored = undefined; client.query.mockClear(); txn.mockReset();
  txn.mockImplementation((fn: (c: typeof client) => unknown) => fn(client));
});

describe("foldPolicy 'upside_only' — a weak sample must never rank someone below having submitted nothing", () => {
  it('stores a score below the candidate\'s own average but keeps the average at the 8 base scores, with no mark of the review', async () => {
    const { result, calls: cs } = await apply(baseRow(8), outcome({ score: 5, redFlags: ['Thin on outcomes'] }), { foldPolicy: 'upside_only' });
    expect(result.avg).toBeNull();                         // nothing was folded in
    const u = find(cs, APPLIED);
    expect(u?.params).toEqual([
      5, 'Thin on outcomes', 8, 80, 'Strong Fit',            // score_portfolio + note, then the BASE-ONLY average and what derives from it
      'Base.', [],                                           // no ' Portfolio review: ' mark and no 'Portfolio: ' flag from this review
      SLA_HOURS.RESUME_REVIEW_HIGH_FIT,
      'completed', null, 'A0700',
    ]);
    const act = find(cs, 'INSERT INTO activity_log');
    expect(act?.params[3]).toBe("Portfolio 5/10 (completed) — below the candidate's own average, so not folded into the overall score");
  });

  it('folds a score at or above the candidate\'s own average as usual', async () => {
    for (const score of [8, 9, 10]) {                      // base average is 8.0 (all eight dimensions = 8)
      const { result, calls: cs } = await apply(baseRow(8), outcome({ score }), { foldPolicy: 'upside_only' });
      expect(result.avg).toBe(computeAvg([8, 8, 8, 8, 8, 8, 8, 8], score));
      expect(find(cs, APPLIED)?.params[5]).toBe('Base. Portfolio review: Some campaigns.');   // a folded score carries its mark
    }
  });

  it('treats the candidate\'s own average as the boundary: equal folds, one below does not', async () => {
    expect((await apply(baseRow(7), outcome({ score: 7 }), { foldPolicy: 'upside_only' })).result.avg).toBe(7);
    expect((await apply(baseRow(7), outcome({ score: 6 }), { foldPolicy: 'upside_only' })).result.avg).toBeNull();
  });

  it("is off unless asked for: the default and 'always' fold a low score exactly as before", async () => {
    const avg = computeAvg([8, 8, 8, 8, 8, 8, 8, 8], 2);
    expect((await apply(baseRow(8), outcome({ score: 2 }))).result.avg).toBe(avg);
    expect((await apply(baseRow(8), outcome({ score: 2 }), { foldPolicy: 'always' })).result.avg).toBe(avg);
  });

  it('does not change a null score or a missing base score (still status-only)', async () => {
    const nullScore = await apply(baseRow(8), outcome({ score: null, status: 'unreviewable' }), { foldPolicy: 'upside_only' });
    expect(nullScore.calls.some(c => c.sql === STATUS_ONLY)).toBe(true);
    const noBase = await apply(baseRow(8, { score_leadership: null }), outcome({ score: 3 }), { foldPolicy: 'upside_only' });
    expect(noBase.calls.some(c => c.sql === STATUS_ONLY)).toBe(true);
    expect(find(noBase.calls, APPLIED)).toBeUndefined();
  });
});

describe("foldPolicy 'upside_only' — a re-run that does worse must not leave the earlier, higher score inside the average (finding 1.10)", () => {
  // Eight base scores of 6 (average 6.0). An earlier run folded a 9 in: (48 + 9) / 9 = 6.3.
  const FOLDED_AT_9 = {
    score_avg: 6.3, ai_fit_score: 63, score_portfolio: 9, ai_priority_bucket: 'Review',
    score_summary: 'Base. Portfolio review: Great campaigns.',
    score_red_flags: ['Short tenures', 'Portfolio: Thin outcomes'],
  };

  it('puts the average back to the base-only value and removes the stale summary mark and portfolio flags', async () => {
    expect(computeAvg([6, 6, 6, 6, 6, 6, 6, 6], 9)).toBe(6.3);   // the premise: the row really holds that earlier fold
    const { result, calls: cs } = await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 3, redFlags: ['New concern'] }), { foldPolicy: 'upside_only' });

    expect(result.avg).toBeNull();
    const u = find(cs, APPLIED);
    expect(u).toBeDefined();
    const [score, note, avg, fit, bucket, summary, flags, sla, status, error, id] = u!.params;
    expect([score, note]).toEqual([3, 'Thin on outcomes']);                 // the new review is still the one shown
    expect(avg).toBe(computeAvg([6, 6, 6, 6, 6, 6, 6, 6]));                  // 6, not 6.3 and not (48 + 3) / 9 = 5.7
    expect(avg).toBe(6);
    expect(fit).toBe(60);
    expect(bucket).toBe(priorityBucketFromScore(6));
    expect(summary).toBe('Base.');                                           // ' Portfolio review: Great campaigns.' is gone
    expect(flags).toEqual(['Short tenures']);                                // only OUR flag was removed; the new review adds none
    expect(sla).toBe(SLA_HOURS.RESUME_REVIEW_NORMAL);
    expect([status, error, id]).toEqual(['completed', null, 'A0700']);
    expect(find(cs, 'INSERT INTO activity_log')?.params[3])
      .toBe("Portfolio 3/10 (completed) — below the candidate's own average, so not folded into the overall score");
  });

  it('is the average the "always" policy would have written for the base scores alone', async () => {
    // Same statement, same shape: only the portfolio term is missing.
    const rebased = find((await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 3 }), { foldPolicy: 'upside_only' })).calls, APPLIED)!.params;
    const noReview = find((await apply(baseRow(6), outcome({ score: 6 }), { foldPolicy: 'always' })).calls, APPLIED)!.params;
    // base average 6.0; 'always' with a 6 folds (48 + 6) / 9 = 6.0 as well, so avg, fit, bucket and SLA must agree.
    expect([rebased[2], rebased[3], rebased[4], rebased[7]]).toEqual([noReview[2], noReview[3], noReview[4], noReview[7]]);
  });

  it('writes the same values however many times it is repeated (the base scores are the only input)', async () => {
    const first = find((await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 3 }), { foldPolicy: 'upside_only' })).calls, APPLIED)!.params;
    const again = find((await apply(baseRow(6, {
      ...FOLDED_AT_9, score_avg: first[2], ai_fit_score: first[3], score_portfolio: first[0], score_summary: first[5], score_red_flags: first[6],
    }), outcome({ score: 3 }), { foldPolicy: 'upside_only' })).calls, APPLIED)!.params;
    expect(again).toEqual(first);
  });

  it('a row that was never folded keeps its own summary and flags, with the average at the base scores', async () => {
    const { calls: cs } = await apply(baseRow(6, { score_summary: 'A solid marketer. Strong on copy.', score_red_flags: ['Short tenures'] }), outcome({ score: 2 }), { foldPolicy: 'upside_only' });
    const p = find(cs, APPLIED)!.params;
    expect([p[2], p[5], p[6]]).toEqual([6, 'A solid marketer. Strong on copy.', ['Short tenures']]);
  });

  it('only the summary text from the mark onwards is dropped, and only our own flag prefix', async () => {
    const { calls: cs } = await apply(baseRow(6, {
      score_summary: 'Base one. Base two. Portfolio review: Great. Portfolio review: and again',
      score_red_flags: ['Portfolio: first', 'Portfolio review concern raised by the base review', 'Portfolio: second'],
    }), outcome({ score: 1 }), { foldPolicy: 'upside_only' });
    const p = find(cs, APPLIED)!.params;
    expect(p[5]).toBe('Base one. Base two.');
    expect(p[6]).toEqual(['Portfolio review concern raised by the base review']);
  });

  it('a high-fit candidate keeps the faster SLA after a weak re-run (the SLA follows the base-only average)', async () => {
    const { calls: cs } = await apply(
      baseRow(9, { score_avg: 9.1, ai_fit_score: 91, score_portfolio: 10, score_summary: 'Base. Portfolio review: Superb.', score_red_flags: [] }),
      outcome({ score: 2 }), { foldPolicy: 'upside_only' },
    );
    const p = find(cs, APPLIED)!.params;
    expect([p[2], p[3], p[4], p[7]]).toEqual([9, 90, priorityBucketFromScore(9), SLA_HOURS.RESUME_REVIEW_HIGH_FIT]);
  });

  it('the stage guard that lets only a candidate still at Applied and Screened change sla_hours is still in the statement', async () => {
    const u = find((await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 3 }), { foldPolicy: 'upside_only' })).calls, APPLIED)!;
    expect(u.sql).toContain("sla_hours = CASE WHEN stage='Applied and Screened' THEN $8::int ELSE sla_hours END");
  });

  it("a score that IS folded (at or above the average) still replaces the mark and flags of the earlier run, as before", async () => {
    const { calls: cs } = await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 8, oneLiner: 'Better now.', redFlags: ['Fresh'] }), { foldPolicy: 'upside_only' });
    const p = find(cs, APPLIED)!.params;
    expect([p[2], p[5], p[6]]).toEqual([computeAvg([6, 6, 6, 6, 6, 6, 6, 6], 8), 'Base. Portfolio review: Better now.', ['Short tenures', 'Portfolio: Fresh']]);
  });

  it("the default policy is untouched: the same weak re-run under 'always' folds the 3 in", async () => {
    const { result, calls: cs } = await apply(baseRow(6, FOLDED_AT_9), outcome({ score: 3 }));
    expect(result.avg).toBe(computeAvg([6, 6, 6, 6, 6, 6, 6, 6], 3));          // 5.7
    expect(find(cs, APPLIED)?.params[5]).toBe('Base. Portfolio review: Some campaigns.');
  });
});

describe("the 'unreviewable' status", () => {
  it('is recorded like any other not-scored outcome: status and reason only, the average untouched', async () => {
    const { result, calls: cs } = await apply(baseRow(8), {
      status: 'unreviewable', score: null, note: '', redFlags: [], message: 'Links are on Instagram and LinkedIn, which cannot be opened automatically.',
    });
    expect(result.avg).toBeNull();
    expect(cs.find(c => c.sql === STATUS_ONLY)?.params).toEqual(['unreviewable', 'Links are on Instagram and LinkedIn, which cannot be opened automatically.', 'A0700']);
    expect(find(cs, APPLIED)).toBeUndefined();
    expect(find(cs, 'INSERT INTO activity_log')?.params[3]).toBe('Portfolio review: unreviewable');
  });
});
