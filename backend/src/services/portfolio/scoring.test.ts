import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Characterization tests for applyPortfolioOutcome (scoring.ts): they pin what the
// function writes TODAY, so a refactor that lets a second review kind share this
// pipeline can be proven byte-identical for the designer role (R007).
//
// The database is a recording stub: transaction(fn) hands fn a fake client whose
// query(sql, params) logs every call and answers `SELECT ... FOR UPDATE` with the
// application row under test (everything else gets no rows). SQL is compared after
// collapsing whitespace, so only the statement itself is pinned, not its indentation.
type Row = Record<string, unknown>;
interface Call { sql: string; params: unknown[] }

const txn = vi.fn();
vi.mock('../../db/index.js', () => ({ transaction: (...a: unknown[]) => txn(...a) }));

import { applyPortfolioOutcome, FLAG_PREFIX, SUMMARY_MARK } from './scoring.js';
import type { PortfolioOutcome } from './scoring.js';
import { SLA_HOURS } from '../../types/index.js';
import { computeAvg } from './rubric.js';
import { priorityBucketFromScore } from '../resumeIQ.js';
import { jsonbSafeStringify } from './text.js';
import type { PortfolioAnalysisResult } from './types.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// The exact statements, whitespace-collapsed.
const SELECT_SQL = 'SELECT * FROM applications WHERE id=$1 FOR UPDATE';
const APPLIED_UPDATE_SQL =
  "UPDATE applications SET score_portfolio=$1, score_portfolio_note=$2, score_avg=$3, ai_fit_score=$4, ai_priority_bucket=$5, " +
  "score_summary=$6, score_red_flags=$7, sla_hours = CASE WHEN stage='Applied and Screened' THEN $8::int ELSE sla_hours END, " +
  'portfolio_analysis_status=$9, portfolio_analysis_error=$10, portfolio_analyzed_at=NOW() WHERE id=$11';
const STATUS_ONLY_UPDATE_SQL =
  'UPDATE applications SET portfolio_analysis_status=$1, portfolio_analysis_error=$2, portfolio_analyzed_at=NOW() WHERE id=$3';
const ANALYSIS_INSERT_SQL =
  'INSERT INTO portfolio_analyses (application_id, analysis) VALUES ($1, $2::jsonb) ' +
  'ON CONFLICT (application_id) DO UPDATE SET analysis=EXCLUDED.analysis, updated_at=NOW()';
const ACTIVITY_INSERT_SQL =
  'INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by_name) ' +
  "VALUES ($1,$2,$3,'Portfolio Review Completed',$4,$5,'System')";

const BASE_COLUMNS = [
  'score_technical', 'score_experience', 'score_industry_fit', 'score_culture_fit',
  'score_role_alignment', 'score_trajectory', 'score_leadership', 'score_communication',
] as const;

/** The 8 base scores, in the order scoring.ts reads them (sum 58). */
const BASE_SCORES = [8, 7, 6, 8, 7, 9, 5, 8];

/** An application that ResumeIQ already scored on the 8 base dimensions. */
function appRow(over: Row = {}): Row {
  const scores = Object.fromEntries(BASE_COLUMNS.map((c, i) => [c, BASE_SCORES[i]]));
  return {
    id: 'A0611', candidate_id: 'C0100', role_id: 'R007', stage: 'Applied and Screened',
    ...scores,
    score_summary: 'Solid designer.',
    score_red_flags: ['Short tenures'],
    ...over,
  };
}

/** Every base dimension at the same value (so avg = (8n + portfolio) / 9). */
const uniformBase = (n: number): Row => Object.fromEntries(BASE_COLUMNS.map(c => [c, n]));

function outcome(over: Partial<PortfolioOutcome> = {}): PortfolioOutcome {
  return { status: 'completed', score: 6, note: 'Clean case studies', oneLiner: 'Strong case studies.', redFlags: [], ...over };
}

const analysisFixture = (over: Partial<PortfolioAnalysisResult> = {}): PortfolioAnalysisResult => ({
  version: 1, analyzedAt: '2026-10-22T00:00:00.000Z', model: 'claude-sonnet-4-5',
  portfolios: [], criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
  modelScore: 7, checklistScore: 7, score: 7, scoreNote: 'ok', highlights: ['h1'], redFlags: [], summary: 'summary',
  ...over,
});

let calls: Call[] = [];
let stored: Row | undefined;
const client = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql: norm(sql), params });
    if (/FOR UPDATE/.test(sql)) return { rows: stored ? [stored] : [] };
    return { rows: [] };
  }),
};

async function apply(row: Row | undefined, out: PortfolioOutcome, id = 'A0611') {
  stored = row;
  calls = [];
  const result = await applyPortfolioOutcome(id, out);
  return { result, calls: [...calls] };
}

const byPrefix = (cs: Call[], re: RegExp) => cs.filter(c => re.test(c.sql));
const appliedUpdate = (cs: Call[]) => cs.find(c => c.sql === APPLIED_UPDATE_SQL);
const statusOnlyUpdate = (cs: Call[]) => cs.find(c => c.sql === STATUS_ONLY_UPDATE_SQL);
const activity = (cs: Call[]) => cs.find(c => c.sql === ACTIVITY_INSERT_SQL);

beforeEach(() => {
  calls = [];
  stored = undefined;
  client.query.mockClear();
  txn.mockReset();
  txn.mockImplementation((fn: (c: typeof client) => unknown) => fn(client));
});

describe('applyPortfolioOutcome — exported constants', () => {
  it('marks its additions to the summary and red flags with these exact strings', () => {
    expect(SUMMARY_MARK).toBe(' Portfolio review: ');
    expect(FLAG_PREFIX).toBe('Portfolio: ');
  });
});

describe('applyPortfolioOutcome — when the dimension is applied (score set, all 8 base scores present)', () => {
  it('runs in one transaction: lock the row, update it, log the event — in that order', async () => {
    const { calls: cs } = await apply(appRow(), outcome());
    expect(txn).toHaveBeenCalledTimes(1);
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, APPLIED_UPDATE_SQL, ACTIVITY_INSERT_SQL]);
    expect(cs[0].params).toEqual(['A0611']);
  });

  it('writes the UPDATE with every parameter in exactly this order', async () => {
    const note = 'abcdefghij'.repeat(15);                      // 150 chars -> sliced to 120
    const { calls: cs } = await apply(appRow(), outcome({
      score: 6, note, oneLiner: 'Strong case studies.', redFlags: ['Thin mobile layouts'], message: 'one site was slow',
    }));
    const avg = computeAvg(BASE_SCORES, 6);
    expect(avg).toBe(7.1);                                       // (58 + 6) / 9
    expect(appliedUpdate(cs)!.params).toEqual([
      6,                                                         // $1 score_portfolio
      'abcdefghij'.repeat(12),                                   // $2 score_portfolio_note, first 120 chars
      7.1,                                                       // $3 score_avg
      71,                                                        // $4 ai_fit_score = round(avg * 10)
      'Review',                                                  // $5 ai_priority_bucket
      'Solid designer. Portfolio review: Strong case studies.',  // $6 score_summary
      ['Short tenures', 'Portfolio: Thin mobile layouts'],       // $7 score_red_flags
      SLA_HOURS.RESUME_REVIEW_NORMAL,                            // $8 sla_hours (avg < 8)
      'completed',                                               // $9 portfolio_analysis_status
      'one site was slow',                                       // $10 portfolio_analysis_error (the message)
      'A0611',                                                   // $11 application id
    ]);
  });

  it('computes the average from the 8 stored base scores plus THIS run\'s score, never from the stored average', async () => {
    // A previous run left a (wrong, much higher) score_avg / score_portfolio on the row.
    const { calls: cs } = await apply(appRow({ score_avg: 9.9, ai_fit_score: 99, score_portfolio: 10 }), outcome({ score: 6 }));
    const p = appliedUpdate(cs)!.params;
    expect(p[2]).toBe(computeAvg(BASE_SCORES, 6));
    expect(p[2]).toBe(7.1);
    expect(p[3]).toBe(71);
  });

  it('the average is the mean of 9 dimensions (8 base + portfolio) rounded to one decimal', async () => {
    const hi = await apply(appRow(), outcome({ score: 10 }));
    expect(appliedUpdate(hi.calls)!.params[2]).toBe(7.6);        // 68 / 9 = 7.555…
    const lo = await apply(appRow(), outcome({ score: 0 }));
    expect(appliedUpdate(lo.calls)!.params[2]).toBe(6.4);        // 58 / 9 = 6.444…
  });

  it('treats a portfolio score of 0 as a real score (it is applied, not skipped as falsy)', async () => {
    const { result, calls: cs } = await apply(appRow(), outcome({ status: 'no_portfolio', score: 0, note: 'No portfolio link', oneLiner: undefined }));
    expect(result).toEqual({ avg: 6.4 });
    expect(appliedUpdate(cs)!.params.slice(0, 5)).toEqual([0, 'No portfolio link', 6.4, 64, 'Review']);
    expect(statusOnlyUpdate(cs)).toBeUndefined();
    expect(activity(cs)!.params[3]).toBe('Portfolio 0/10 (no_portfolio) — overall score now 6.4/10');
  });

  it('a base score of 0 counts as present (only null/undefined means missing)', async () => {
    const { result, calls: cs } = await apply(appRow({ score_leadership: 0 }), outcome({ score: 6 }));
    expect(result).toEqual({ avg: computeAvg([8, 7, 6, 8, 7, 9, 0, 8], 6) });
    expect(appliedUpdate(cs)).toBeDefined();
  });

  it('applies the dimension whatever the status is, e.g. an inaccessible portfolio held against the candidate', async () => {
    const { calls: cs } = await apply(appRow(), outcome({
      status: 'inaccessible', score: 0, note: 'Link is dead', oneLiner: 'Portfolio link could not be opened.',
      message: 'https://x.example returned 404', redFlags: ['Portfolio link is dead'],
    }));
    const p = appliedUpdate(cs)!.params;
    expect(p[0]).toBe(0);
    expect(p[5]).toBe('Solid designer. Portfolio review: Portfolio link could not be opened.');
    expect(p[6]).toEqual(['Short tenures', 'Portfolio: Portfolio link is dead']);
    expect(p[8]).toBe('inaccessible');
    expect(p[9]).toBe('https://x.example returned 404');
  });

  it('stores the status message as-is: missing -> null, empty string stays an empty string', async () => {
    const none = await apply(appRow(), outcome({ message: undefined }));
    expect(appliedUpdate(none.calls)!.params[9]).toBeNull();
    const empty = await apply(appRow(), outcome({ message: '' }));
    expect(appliedUpdate(empty.calls)!.params[9]).toBe('');
  });

  it('keeps a note of 120 characters or fewer untouched and cuts at exactly 120', async () => {
    const short = await apply(appRow(), outcome({ note: 'x'.repeat(120) }));
    expect(appliedUpdate(short.calls)!.params[1]).toBe('x'.repeat(120));
    const long = await apply(appRow(), outcome({ note: 'y'.repeat(121) }));
    expect(appliedUpdate(long.calls)!.params[1]).toBe('y'.repeat(120));
    const none = await apply(appRow(), outcome({ note: '' }));
    expect(appliedUpdate(none.calls)!.params[1]).toBe('');
  });

  describe('ai_fit_score and ai_priority_bucket follow the new average', () => {
    // avg = (8 * base + portfolio) / 9, so each pair lands exactly on a bucket edge.
    it.each([
      // base, portfolio, avg, ai_fit_score, bucket
      [8, 8, 8.0, 80, 'Strong Fit'],
      [8, 7, 7.9, 79, 'Review'],
      [6, 6, 6.0, 60, 'Review'],
      [6, 5, 5.9, 59, 'Low Priority'],
      [4, 4, 4.0, 40, 'Low Priority'],
      [4, 3, 3.9, 39, 'Reject'],
      [0, 0, 0.0, 0, 'Reject'],
      [10, 10, 10.0, 100, 'Strong Fit'],
    ])('base %i + portfolio %i -> avg %f, ai_fit_score %i, %s', async (base, portfolio, avg, fit, bucket) => {
      const { result, calls: cs } = await apply(appRow(uniformBase(base)), outcome({ score: portfolio }));
      const p = appliedUpdate(cs)!.params;
      expect(p[2]).toBe(avg);
      expect(p[3]).toBe(fit);
      expect(p[4]).toBe(bucket);
      expect(p[4]).toBe(priorityBucketFromScore(avg));
      expect(result).toEqual({ avg });
    });
  });

  describe('sla_hours', () => {
    const saved = { high: SLA_HOURS.RESUME_REVIEW_HIGH_FIT, normal: SLA_HOURS.RESUME_REVIEW_NORMAL };
    // Today both constants are 48, which makes the branch invisible by value — so give
    // them distinct values for these tests (restored afterwards).
    beforeEach(() => { SLA_HOURS.RESUME_REVIEW_HIGH_FIT = 11; SLA_HOURS.RESUME_REVIEW_NORMAL = 22; });
    afterEach(() => { SLA_HOURS.RESUME_REVIEW_HIGH_FIT = saved.high; SLA_HOURS.RESUME_REVIEW_NORMAL = saved.normal; });

    it('picks RESUME_REVIEW_HIGH_FIT when the new average is 8 or more', async () => {
      const { calls: cs } = await apply(appRow(uniformBase(8)), outcome({ score: 8 }));       // avg 8.0
      expect(appliedUpdate(cs)!.params[7]).toBe(11);
    });

    it('picks RESUME_REVIEW_NORMAL when the new average is below 8', async () => {
      const { calls: cs } = await apply(appRow(uniformBase(8)), outcome({ score: 7 }));       // avg 7.9
      expect(appliedUpdate(cs)!.params[7]).toBe(22);
    });

    it('is decided from the average alone in JS: the same value is passed whatever the stage (the SQL CASE applies it only at Applied and Screened)', async () => {
      const early = await apply(appRow({ ...uniformBase(8), stage: 'Applied and Screened' }), outcome({ score: 8 }));
      const later = await apply(appRow({ ...uniformBase(8), stage: 'Interview Round 1' }), outcome({ score: 8 }));
      expect(appliedUpdate(early.calls)!.params[7]).toBe(11);
      expect(appliedUpdate(later.calls)!.params[7]).toBe(11);
      expect(appliedUpdate(later.calls)!.sql).toContain("sla_hours = CASE WHEN stage='Applied and Screened' THEN $8::int ELSE sla_hours END");
    });
  });

  it('with the real constants the parameter is the named constant for each side of the 8.0 line', async () => {
    const high = await apply(appRow(uniformBase(8)), outcome({ score: 8 }));
    expect(appliedUpdate(high.calls)!.params[7]).toBe(SLA_HOURS.RESUME_REVIEW_HIGH_FIT);
    const normal = await apply(appRow(uniformBase(8)), outcome({ score: 7 }));
    expect(appliedUpdate(normal.calls)!.params[7]).toBe(SLA_HOURS.RESUME_REVIEW_NORMAL);
  });
});

describe('applyPortfolioOutcome — summary strip-and-rewrite', () => {
  const summaryOf = (cs: Call[]) => appliedUpdate(cs)!.params[5];

  it('appends the one-liner to the base summary after the " Portfolio review: " mark', async () => {
    const { calls: cs } = await apply(appRow({ score_summary: 'Solid designer.' }), outcome({ oneLiner: 'Strong case studies.' }));
    expect(summaryOf(cs)).toBe('Solid designer. Portfolio review: Strong case studies.');
  });

  it('cuts an earlier portfolio sentence at the mark before appending the new one', async () => {
    const { calls: cs } = await apply(
      appRow({ score_summary: 'Solid designer. Portfolio review: old verdict about a different run.' }),
      outcome({ oneLiner: 'New verdict.' }),
    );
    expect(summaryOf(cs)).toBe('Solid designer. Portfolio review: New verdict.');
  });

  it('cuts at the FIRST mark, discarding everything after it', async () => {
    const { calls: cs } = await apply(
      appRow({ score_summary: 'Base. Portfolio review: one. Portfolio review: two.' }),
      outcome({ oneLiner: 'Three.' }),
    );
    expect(summaryOf(cs)).toBe('Base. Portfolio review: Three.');
  });

  it('running twice does not double-append: the second run rewrites the first run\'s output identically', async () => {
    const first = await apply(appRow({ score_summary: 'Solid designer.' }), outcome({ oneLiner: 'Strong case studies.', redFlags: ['Thin mobile layouts'] }));
    const p1 = appliedUpdate(first.calls)!.params;
    // Feed what run 1 wrote back in as the row's stored state, then apply the same outcome again.
    const second = await apply(
      appRow({ score_summary: p1[5], score_red_flags: p1[6], score_avg: p1[2], score_portfolio: p1[0], ai_fit_score: p1[3] }),
      outcome({ oneLiner: 'Strong case studies.', redFlags: ['Thin mobile layouts'] }),
    );
    expect(appliedUpdate(second.calls)!.params).toEqual(p1);
    expect(summaryOf(second.calls)).toBe('Solid designer. Portfolio review: Strong case studies.');
  });

  it('a re-run with a different one-liner replaces (not stacks) the previous one', async () => {
    const first = await apply(appRow(), outcome({ oneLiner: 'First verdict.' }));
    const second = await apply(appRow({ score_summary: summaryOf(first.calls) }), outcome({ oneLiner: 'Second verdict.' }));
    expect(summaryOf(second.calls)).toBe('Solid designer. Portfolio review: Second verdict.');
  });

  it('with no one-liner keeps only the base summary (and still strips an old portfolio sentence)', async () => {
    const plain = await apply(appRow({ score_summary: 'Solid designer.' }), outcome({ oneLiner: undefined }));
    expect(summaryOf(plain.calls)).toBe('Solid designer.');
    const stripped = await apply(appRow({ score_summary: 'Solid designer. Portfolio review: stale' }), outcome({ oneLiner: undefined }));
    expect(summaryOf(stripped.calls)).toBe('Solid designer.');
  });

  it('an empty-string one-liner counts as no one-liner', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ oneLiner: '' }));
    expect(summaryOf(cs)).toBe('Solid designer.');
  });

  it('trims the base summary (only the base — the one-liner is appended verbatim)', async () => {
    const { calls: cs } = await apply(appRow({ score_summary: '  Solid designer.  ' }), outcome({ oneLiner: ' padded one-liner ' }));
    expect(summaryOf(cs)).toBe('Solid designer. Portfolio review:  padded one-liner ');
  });

  it('matches the mark exactly, spaces included: "Portfolio review:" glued to the text is not cut', async () => {
    const noLeadingSpace = await apply(appRow({ score_summary: 'Portfolio review: stray' }), outcome({ oneLiner: 'New.' }));
    expect(summaryOf(noLeadingSpace.calls)).toBe('Portfolio review: stray Portfolio review: New.');
    const noTrailingSpace = await apply(appRow({ score_summary: 'Base. Portfolio review:stray' }), outcome({ oneLiner: 'New.' }));
    expect(summaryOf(noTrailingSpace.calls)).toBe('Base. Portfolio review:stray Portfolio review: New.');
  });

  it('a summary that is only a portfolio sentence leaves an empty base', async () => {
    const { calls: cs } = await apply(appRow({ score_summary: ' Portfolio review: only this' }), outcome({ oneLiner: undefined }));
    expect(summaryOf(cs)).toBe('');
  });

  it('a missing/null stored summary is treated as an empty base (leading space in front of the mark — see oddities)', async () => {
    const nul = await apply(appRow({ score_summary: null }), outcome({ oneLiner: 'Only this.' }));
    expect(summaryOf(nul.calls)).toBe(' Portfolio review: Only this.');
    const none = await apply(appRow({ score_summary: undefined }), outcome({ oneLiner: undefined }));
    expect(summaryOf(none.calls)).toBe('');
  });
});

describe('applyPortfolioOutcome — red flags', () => {
  const flagsOf = (cs: Call[]) => appliedUpdate(cs)!.params[6];

  it('removes earlier "Portfolio: " flags, keeps the others in order, appends the new ones prefixed', async () => {
    const { calls: cs } = await apply(
      appRow({ score_red_flags: ['Short tenures', 'Portfolio: stale flag', 'Employment gap', 'Portfolio: another stale flag'] }),
      outcome({ redFlags: ['Thin mobile layouts', 'No case study depth'] }),
    );
    expect(flagsOf(cs)).toEqual(['Short tenures', 'Employment gap', 'Portfolio: Thin mobile layouts', 'Portfolio: No case study depth']);
  });

  it('adds at most 3 new flags (the first 3), each with the "Portfolio: " prefix', async () => {
    const { calls: cs } = await apply(appRow({ score_red_flags: [] }), outcome({ redFlags: ['one', 'two', 'three', 'four', 'five'] }));
    expect(flagsOf(cs)).toEqual(['Portfolio: one', 'Portfolio: two', 'Portfolio: three']);
  });

  it('the cap applies to the new flags only — kept flags are never trimmed', async () => {
    const kept = ['a', 'b', 'c', 'd', 'e'];
    const { calls: cs } = await apply(appRow({ score_red_flags: kept }), outcome({ redFlags: ['x', 'y', 'z', 'w'] }));
    expect(flagsOf(cs)).toEqual([...kept, 'Portfolio: x', 'Portfolio: y', 'Portfolio: z']);
  });

  it('a null stored flag list is treated as empty', async () => {
    const { calls: cs } = await apply(appRow({ score_red_flags: null }), outcome({ redFlags: ['only'] }));
    expect(flagsOf(cs)).toEqual(['Portfolio: only']);
  });

  it('with no new flags and nothing stored, writes an empty array', async () => {
    const { calls: cs } = await apply(appRow({ score_red_flags: [] }), outcome({ redFlags: [] }));
    expect(flagsOf(cs)).toEqual([]);
  });

  it('with no new flags, earlier portfolio flags are still dropped and the rest kept', async () => {
    const { calls: cs } = await apply(appRow({ score_red_flags: ['Portfolio: stale', 'Gap'] }), outcome({ redFlags: [] }));
    expect(flagsOf(cs)).toEqual(['Gap']);
  });

  it('only the exact, case-sensitive prefix "Portfolio: " marks a flag as ours', async () => {
    const { calls: cs } = await apply(
      appRow({ score_red_flags: ['portfolio: lower case', 'Portfolio:no space', 'Portfolio - dash', 'Portfolio: ours'] }),
      outcome({ redFlags: [] }),
    );
    expect(flagsOf(cs)).toEqual(['portfolio: lower case', 'Portfolio:no space', 'Portfolio - dash']);
  });

  it('new flags are not de-duplicated, and are prefixed even if they already start with the prefix', async () => {
    const { calls: cs } = await apply(appRow({ score_red_flags: [] }), outcome({ redFlags: ['same', 'same', 'Portfolio: already'] }));
    expect(flagsOf(cs)).toEqual(['Portfolio: same', 'Portfolio: same', 'Portfolio: Portfolio: already']);
  });

  it('is stable across re-runs: applying the same outcome to its own output gives the same flags', async () => {
    const o = outcome({ redFlags: ['Thin mobile layouts', 'Broken links'] });
    const first = await apply(appRow(), o);
    const second = await apply(appRow({ score_red_flags: flagsOf(first.calls) }), o);
    expect(flagsOf(second.calls)).toEqual(['Short tenures', 'Portfolio: Thin mobile layouts', 'Portfolio: Broken links']);
    expect(flagsOf(second.calls)).toEqual(flagsOf(first.calls));
  });
});

describe('applyPortfolioOutcome — dimension not applied (score null)', () => {
  it('writes only status, error and the analysed-at stamp: no average, no portfolio score, no summary or flags', async () => {
    const { calls: cs } = await apply(
      appRow({ score_avg: 7.2, ai_fit_score: 72 }),
      outcome({ status: 'no_portfolio', score: null, note: '', oneLiner: 'ignored', redFlags: ['ignored'], message: 'Resume could not be read' }),
    );
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, STATUS_ONLY_UPDATE_SQL, ACTIVITY_INSERT_SQL]);
    expect(statusOnlyUpdate(cs)!.params).toEqual(['no_portfolio', 'Resume could not be read', 'A0611']);
    expect(cs.some(c => /score_avg|score_portfolio|ai_fit_score|score_summary|score_red_flags|sla_hours/.test(c.sql))).toBe(false);
    expect(appliedUpdate(cs)).toBeUndefined();
  });

  it('stores a null error when there is no message', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ status: 'inaccessible', score: null, message: undefined }));
    expect(statusOnlyUpdate(cs)!.params).toEqual(['inaccessible', null, 'A0611']);
  });

  it('returns avg null even when the application already has a stored average', async () => {
    const { result } = await apply(appRow({ score_avg: 7.2 }), outcome({ score: null }));
    expect(result).toEqual({ avg: null });
  });

  it('logs "Portfolio review: <status>" without a score', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ status: 'no_portfolio', score: null }));
    expect(activity(cs)!.params).toEqual(['A0611', 'C0100', 'R007', 'Portfolio review: no_portfolio', 'no_portfolio']);
  });
});

describe('applyPortfolioOutcome — a base score is missing', () => {
  it.each(BASE_COLUMNS)('a null %s with a score set behaves like the not-applied branch', async (missing) => {
    const { result, calls: cs } = await apply(
      appRow({ [missing]: null }),
      outcome({ status: 'completed', score: 6, message: 'note for HR', redFlags: ['would be a flag'] }),
    );
    expect(result).toEqual({ avg: null });
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, STATUS_ONLY_UPDATE_SQL, ACTIVITY_INSERT_SQL]);
    expect(statusOnlyUpdate(cs)!.params).toEqual(['completed', 'note for HR', 'A0611']);
    expect(appliedUpdate(cs)).toBeUndefined();
  });

  it('an absent (undefined) base column counts as missing too', async () => {
    const row = appRow();
    delete row.score_communication;
    const { result, calls: cs } = await apply(row, outcome({ score: 6 }));
    expect(result).toEqual({ avg: null });
    expect(statusOnlyUpdate(cs)).toBeDefined();
  });

  it('the review is still stored, and the activity log says no score even though one was supplied (see oddities)', async () => {
    const analysis = analysisFixture({ score: 7 });
    const { calls: cs } = await apply(appRow({ score_technical: null }), outcome({ status: 'completed', score: 7, analysis }));
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, STATUS_ONLY_UPDATE_SQL, ANALYSIS_INSERT_SQL, ACTIVITY_INSERT_SQL]);
    expect(activity(cs)!.params[3]).toBe('Portfolio review: completed');
    expect(activity(cs)!.params[4]).toBe('completed');
  });

  it('a base score that is entirely absent (never ResumeIQ-scored) is not applied either', async () => {
    const bare: Row = { id: 'A0611', candidate_id: 'C0100', role_id: 'R007', stage: 'Applied and Screened' };
    const { result, calls: cs } = await apply(bare, outcome({ score: 9 }));
    expect(result).toEqual({ avg: null });
    expect(statusOnlyUpdate(cs)).toBeDefined();
  });
});

describe('applyPortfolioOutcome — the stored review (portfolio_analyses)', () => {
  it('upserts the analysis as a JSON string, after the application UPDATE and before the activity row', async () => {
    const analysis = analysisFixture();
    const { calls: cs } = await apply(appRow(), outcome({ analysis }));
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, APPLIED_UPDATE_SQL, ANALYSIS_INSERT_SQL, ACTIVITY_INSERT_SQL]);
    const ins = byPrefix(cs, /^INSERT INTO portfolio_analyses/)[0];
    expect(ins.params).toEqual(['A0611', JSON.stringify(analysis)]);
    expect(typeof ins.params[1]).toBe('string');
    expect(ins.params[1]).toBe(jsonbSafeStringify(analysis));
  });

  it('is also stored when the dimension is not applied (score null)', async () => {
    const analysis = analysisFixture();
    const { calls: cs } = await apply(appRow(), outcome({ status: 'inaccessible', score: null, analysis }));
    expect(cs.map(c => c.sql)).toEqual([SELECT_SQL, STATUS_ONLY_UPDATE_SQL, ANALYSIS_INSERT_SQL, ACTIVITY_INSERT_SQL]);
  });

  it('replaces lone surrogates in any string with U+FFFD, so PostgreSQL jsonb accepts it', async () => {
    const cut = ('x'.repeat(199) + '😀').slice(0, 200);                // ends on a lone high surrogate
    const analysis = analysisFixture({
      summary: cut,
      highlights: ['fine 😀 emoji', cut],
      scoreNote: '\uDE00 leading low surrogate',
    });
    const { calls: cs } = await apply(appRow(), outcome({ analysis }));
    const json = byPrefix(cs, /^INSERT INTO portfolio_analyses/)[0].params[1] as string;
    expect(json).not.toMatch(/\\ud[89ab]/i);                          // no escaped lone high surrogate
    expect(json).not.toMatch(/\\ud[c-f]/i);                           // …nor a lone low one
    const parsed = JSON.parse(json) as PortfolioAnalysisResult;
    expect(parsed.summary).toBe('x'.repeat(199) + '�');
    expect(parsed.highlights).toEqual(['fine 😀 emoji', 'x'.repeat(199) + '�']);   // a complete pair is untouched
    expect(parsed.scoreNote).toBe('� leading low surrogate');
    expect(json).not.toBe(JSON.stringify(analysis));                   // plain JSON.stringify would have emitted the escape
  });

  it('writes no portfolio_analyses row when there is no analysis', async () => {
    const applied = await apply(appRow(), outcome({ analysis: undefined }));
    expect(byPrefix(applied.calls, /portfolio_analyses/)).toHaveLength(0);
    const notApplied = await apply(appRow(), outcome({ score: null, analysis: undefined }));
    expect(byPrefix(notApplied.calls, /portfolio_analyses/)).toHaveLength(0);
  });
});

describe('applyPortfolioOutcome — the activity_log row', () => {
  it('logs a scored review as "Portfolio N/10 (status) — overall score now X/10", with the status as new_value', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ status: 'completed', score: 6 }));
    expect(activity(cs)!.params).toEqual([
      'A0611', 'C0100', 'R007',
      'Portfolio 6/10 (completed) — overall score now 7.1/10',
      'completed',
    ]);
  });

  it('uses the portfolio score as supplied and the average as a plain number (8.0 prints as "8")', async () => {
    const { calls: cs } = await apply(appRow(uniformBase(8)), outcome({ status: 'completed', score: 8 }));
    expect(activity(cs)!.params[3]).toBe('Portfolio 8/10 (completed) — overall score now 8/10');
  });

  it('the detail contains an em dash (U+2014), not a hyphen', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ score: 6 }));
    expect(activity(cs)!.params[3]).toContain('—');
  });

  it('logs an unscored review as "Portfolio review: status", with the status as new_value', async () => {
    const { calls: cs } = await apply(appRow(), outcome({ status: 'inaccessible', score: null }));
    expect(activity(cs)!.params).toEqual(['A0611', 'C0100', 'R007', 'Portfolio review: inaccessible', 'inaccessible']);
  });

  it('takes candidate_id and role_id from the locked application row, and the id from the argument', async () => {
    const { calls: cs } = await apply(appRow({ id: 'A0999', candidate_id: 'C7777', role_id: 'R019' }), outcome({ score: 6 }), 'A0999');
    expect(activity(cs)!.params.slice(0, 3)).toEqual(['A0999', 'C7777', 'R019']);
    expect(cs[0].params).toEqual(['A0999']);
  });

  it('is always written exactly once, as a System event named "Portfolio Review Completed"', async () => {
    for (const out of [outcome(), outcome({ score: null }), outcome({ status: 'no_portfolio', score: 0 })]) {
      const { calls: cs } = await apply(appRow(), out);
      const rows = byPrefix(cs, /^INSERT INTO activity_log/);
      expect(rows).toHaveLength(1);
      expect(rows[0].sql).toBe(ACTIVITY_INSERT_SQL);
      expect(rows[0].sql).toContain("'Portfolio Review Completed'");
      expect(rows[0].sql).toContain("'System'");
    }
  });
});

describe('applyPortfolioOutcome — application not found', () => {
  it('throws "Application not found" after only the locking SELECT, writing nothing', async () => {
    stored = undefined;
    calls = [];
    await expect(applyPortfolioOutcome('A9999', outcome({ analysis: analysisFixture() }))).rejects.toThrow('Application not found');
    expect(calls.map(c => c.sql)).toEqual([SELECT_SQL]);
    expect(calls[0].params).toEqual(['A9999']);
  });
});

describe('applyPortfolioOutcome — return value', () => {
  it('returns { avg } with the new average when the dimension was applied', async () => {
    const { result } = await apply(appRow(), outcome({ score: 6 }));
    expect(result).toEqual({ avg: 7.1 });
  });

  it('returns { avg: null } when it was not applied', async () => {
    const { result } = await apply(appRow(), outcome({ score: null }));
    expect(result).toEqual({ avg: null });
  });

  it('the returned avg is exactly the value written to score_avg', async () => {
    const { result, calls: cs } = await apply(appRow(), outcome({ score: 9 }));
    expect(result.avg).toBe(appliedUpdate(cs)!.params[2]);
  });

  it('propagates the transaction result (and any failure inside it)', async () => {
    txn.mockImplementation(async () => ({ avg: 4.2 }));
    expect(await applyPortfolioOutcome('A0611', outcome())).toEqual({ avg: 4.2 });
    txn.mockImplementation(async () => { throw new Error('deadlock detected'); });
    await expect(applyPortfolioOutcome('A0611', outcome())).rejects.toThrow('deadlock detected');
  });
});
