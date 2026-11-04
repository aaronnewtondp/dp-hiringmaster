import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '../types/index.js';

// getCompBenchmark: a per-ROLE compensation benchmark. Order of preference (confirmed for item #26): a row of comp_benchmarks for the role's title whose
// experience range OVERLAPS the role's yoe_required; else the first row on file for that title (still grounded data); only with no usable row at all does it
// ask the model. The database and the Anthropic SDK are faked; the rows are synthetic.
const h = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: (...a: unknown[]) => h.query(...a), queryOne: vi.fn(), transaction: vi.fn(), pool: {} }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: h.create }; } }));

import { getCompBenchmark } from './compBenchmark.js';

type Row = {
  id: string; role_category: string; experience_range: string;
  internal_band_min: number | string | null; internal_band_max: number | string | null;
  market_band_min: number | string | null; market_band_max: number | string | null;
  currency: string; notes: string | null;
};
const row = (over: Partial<Row> = {}): Row => ({
  id: 'BEN001', role_category: 'Synthetic Role', experience_range: '5-7',
  internal_band_min: 20, internal_band_max: 30, market_band_min: 25, market_band_max: 40, currency: 'LPA', notes: null, ...over,
});
const role = (over: Record<string, unknown> = {}) => ({ title: 'Synthetic Role', yoe_required: '5-8', ...over }) as unknown as Role;
const aiReply = (obj: unknown) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });

beforeEach(() => {
  h.query.mockReset().mockResolvedValue([]);
  h.create.mockReset().mockResolvedValue(aiReply({ range_min: 18, range_max: 28, rationale: 'Synthetic rationale.' }));
});

describe('getCompBenchmark: which internal row is used', () => {
  it('looks rows up by the role title (as role_category), ordered by experience_range', async () => {
    await getCompBenchmark(role({ title: 'Some Title' }));
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toBe('SELECT * FROM comp_benchmarks WHERE role_category = $1 ORDER BY experience_range');
    expect(params).toEqual(['Some Title']);
  });

  it('a row whose range overlaps the role range is used, in preference to an earlier row that does not', async () => {
    h.query.mockResolvedValue([row({ id: 'BEN-A', experience_range: '1-3' }), row({ id: 'BEN-B', experience_range: '5-7' })]);
    const out = await getCompBenchmark(role({ yoe_required: '5-8' }));
    expect(out.benchmark_id).toBe('BEN-B');
    expect(out.source).toBe('internal_data');
  });

  it.each([
    // [role range, row range, matches?]  (overlap is inclusive at the ends; it is overlap, not containment)
    ['5-8', '5-7', true], ['5-8', '7-10', true], ['5-8', '8-12', true], ['5-8', '1-5', true], ['5-8', '6-7', true], ['5-8', '1-12', true],
    ['5-8', '9-12', false], ['5-8', '1-4', false], ['5-8', '0-2', false],
    ['5', '5', true], ['5', '3-7', true], ['5', '6-8', false],
    ['8-5', '6-7', true],
  ])('role %s vs row %s: overlap=%s', async (roleRange, rowRange, overlaps) => {
    h.query.mockResolvedValue([row({ id: 'FIRST', experience_range: '20-30' }), row({ id: 'TARGET', experience_range: rowRange })]);
    const out = await getCompBenchmark(role({ yoe_required: roleRange }));
    // FIRST never overlaps; when TARGET does not either, the fallback is rows[0] = FIRST.
    expect(out.benchmark_id).toBe(overlaps ? 'TARGET' : 'FIRST');
  });

  it('with several overlapping rows, the first in sort order wins', async () => {
    h.query.mockResolvedValue([row({ id: 'FIRST', experience_range: '4-6' }), row({ id: 'SECOND', experience_range: '5-7' })]);
    expect((await getCompBenchmark(role({ yoe_required: '5-8' }))).benchmark_id).toBe('FIRST');
  });

  it('numbers are read wherever they sit in the text ("5 to 8 yrs", "2.5-4", "10+")', async () => {
    h.query.mockResolvedValue([row({ id: 'FIRST', experience_range: '20-30' }), row({ id: 'DEC', experience_range: '2.5-4' }), row({ id: 'PLUS', experience_range: '10+' })]);
    expect((await getCompBenchmark(role({ yoe_required: '5 to 8 yrs' }))).benchmark_id).toBe('FIRST'); // 5-8 vs 2.5-4 / 10 / 20-30: none overlaps
    expect((await getCompBenchmark(role({ yoe_required: '3-4' }))).benchmark_id).toBe('DEC');
    expect((await getCompBenchmark(role({ yoe_required: '9 to 12 yrs' }))).benchmark_id).toBe('PLUS'); // 10+ reads as 10..10, inside 9-12
  });

  describe('no overlapping row: the first row on file is used (not the nearest one)', () => {
    it('roles range does not overlap any row', async () => {
      h.query.mockResolvedValue([row({ id: 'FIRST', experience_range: '1-3' }), row({ id: 'NEAREST', experience_range: '9-11' })]);
      const out = await getCompBenchmark(role({ yoe_required: '8' }));
      expect(out.benchmark_id).toBe('FIRST');
      expect(out.source).toBe('internal_data');
    });
    it.each([[null], [''], ['Fresher'], ['Any'], [undefined]])('the role has no usable yoe_required (%j)', async yoe => {
      h.query.mockResolvedValue([row({ id: 'FIRST', experience_range: '1-3' }), row({ id: 'SECOND', experience_range: '5-7' })]);
      expect((await getCompBenchmark(role({ yoe_required: yoe }))).benchmark_id).toBe('FIRST');
    });
    it('a row whose range has no numbers never matches by overlap, but can still be the first-row fallback', async () => {
      h.query.mockResolvedValue([row({ id: 'ANY', experience_range: 'Any' }), row({ id: 'REAL', experience_range: '5-7' })]);
      expect((await getCompBenchmark(role({ yoe_required: '5-8' }))).benchmark_id).toBe('REAL');
      expect((await getCompBenchmark(role({ yoe_required: '40-50' }))).benchmark_id).toBe('ANY');
    });
  });

  it('no AI call is made when an internal row is usable', async () => {
    h.query.mockResolvedValue([row()]);
    await getCompBenchmark(role());
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('getCompBenchmark: the band taken from the row', () => {
  it('internal bands are preferred over market bands', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: 20, internal_band_max: 30, market_band_min: 25, market_band_max: 40 })]);
    const out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max]).toEqual([20, 30]);
  });

  it('each end falls back to its own market end independently', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: null, internal_band_max: 30, market_band_min: 25, market_band_max: 40 })]);
    let out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max]).toEqual([25, 30]);
    h.query.mockResolvedValue([row({ internal_band_min: 20, internal_band_max: null, market_band_min: 25, market_band_max: 40 })]);
    out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max]).toEqual([20, 40]);
  });

  it('market bands alone are used when there are no internal ones', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: null, internal_band_max: null, market_band_min: 25, market_band_max: 40 })]);
    const out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max]).toEqual([25, 40]);
    expect(out.source).toBe('internal_data');
  });

  it('a zero internal figure is a real figure (it is not replaced by the market one)', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: 0, internal_band_max: 30, market_band_min: 25, market_band_max: 40 })]);
    expect((await getCompBenchmark(role())).range_min).toBe(0);
  });

  it('numeric columns that come back from Postgres as strings are returned as numbers', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: '12.50', internal_band_max: '18.00' })]);
    const out = await getCompBenchmark(role());
    expect(out.range_min).toBe(12.5);
    expect(out.range_max).toBe(18);
    expect(typeof out.range_min).toBe('number');
  });

  it('the currency is the row\'s and the benchmark id is returned', async () => {
    h.query.mockResolvedValue([row({ id: 'BEN042', currency: 'INR LPA' })]);
    const out = await getCompBenchmark(role());
    expect(out.currency).toBe('INR LPA');
    expect(out.benchmark_id).toBe('BEN042');
  });

  it('the rationale names the benchmark, category and range, and appends the notes only when there are some', async () => {
    h.query.mockResolvedValue([row({ id: 'BEN007', role_category: 'Synthetic Role', experience_range: '5-7', notes: 'Reviewed in Q3' })]);
    expect((await getCompBenchmark(role())).rationale).toBe('Based on internal benchmark BEN007 (Synthetic Role, 5-7) — Reviewed in Q3.');
    h.query.mockResolvedValue([row({ id: 'BEN007', notes: null })]);
    expect((await getCompBenchmark(role())).rationale).toBe('Based on internal benchmark BEN007 (Synthetic Role, 5-7).');
    h.query.mockResolvedValue([row({ id: 'BEN007', notes: '' })]);
    expect((await getCompBenchmark(role())).rationale).toBe('Based on internal benchmark BEN007 (Synthetic Role, 5-7).');
  });
});

describe('getCompBenchmark: the model is the last resort', () => {
  it('no rows at all: one model call (claude-sonnet-4-5, 512 tokens) and an ai_estimate result without a benchmark id', async () => {
    const out = await getCompBenchmark(role());
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0].model).toBe('claude-sonnet-4-5');
    expect(h.create.mock.calls[0][0].max_tokens).toBe(512);
    expect(out).toEqual({ source: 'ai_estimate', range_min: 18, range_max: 28, currency: 'LPA', rationale: 'Synthetic rationale.' });
    expect('benchmark_id' in out).toBe(false);
  });

  it('a matched row with NO usable band (both internal and market null on a side) drops to the model, even if another row has figures', async () => {
    h.query.mockResolvedValue([
      row({ id: 'EMPTY', experience_range: '5-7', internal_band_min: null, internal_band_max: null, market_band_min: null, market_band_max: null }),
      row({ id: 'GOOD', experience_range: '5-8' }),
    ]);
    const out = await getCompBenchmark(role({ yoe_required: '5-8' }));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('ai_estimate');
  });

  it('a matched row with only one end available anywhere (min but no max) also drops to the model', async () => {
    h.query.mockResolvedValue([row({ internal_band_min: 20, internal_band_max: null, market_band_min: null, market_band_max: null })]);
    expect((await getCompBenchmark(role())).source).toBe('ai_estimate');
  });

  it('the prompt carries the role fields, with "Not specified" for the empty ones, and asks for JSON only', async () => {
    await getCompBenchmark(role({ title: 'Prompt Title', department: 'Engineering', yoe_required: '3-5', must_have_skills: 'MUST-SENTINEL', kpi_expectations: 'KPI-SENTINEL' }));
    const p = h.create.mock.calls[0][0].messages[0].content as string;
    expect(p).toContain('ROLE: Prompt Title');
    expect(p).toContain('DEPARTMENT: Engineering');
    expect(p).toContain('EXPERIENCE REQUIRED: 3-5');
    expect(p).toContain('MUST-HAVE SKILLS: MUST-SENTINEL');
    expect(p).toContain('KEY RESPONSIBILITIES: KPI-SENTINEL');
    expect(p).toContain('Return ONLY valid JSON, no markdown, no code fences');
    expect(p).toContain('INR LPA');

    h.create.mockClear();
    await getCompBenchmark(role({ title: 'Bare', yoe_required: null }));
    const bare = h.create.mock.calls[0][0].messages[0].content as string;
    expect(bare).toContain('DEPARTMENT: Not specified');
    expect(bare).toContain('EXPERIENCE REQUIRED: Not specified');
    expect(bare).toContain('MUST-HAVE SKILLS: Not specified');
    expect(bare).toContain('KEY RESPONSIBILITIES: Not specified');
  });

  it('the prompt contains no candidate data (this benchmark is per role; there is no candidate in it)', async () => {
    await getCompBenchmark(role());
    const p = h.create.mock.calls[0][0].messages[0].content as string;
    expect(p).not.toMatch(/candidate/i);
  });

  it.each([
    ['a ```json fence', '```json\n{"range_min": 10, "range_max": 15, "rationale": "r"}\n```'],
    ['a bare fence', '```\n{"range_min": 10, "range_max": 15, "rationale": "r"}\n```'],
    ['plain JSON', '{"range_min": 10, "range_max": 15, "rationale": "r"}'],
  ])('%s around the reply is stripped', async (_n, text) => {
    h.create.mockResolvedValue(aiReply(text));
    const out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max, out.rationale]).toEqual([10, 15, 'r']);
  });

  it('string numbers in the reply become numbers; the currency is always the literal "LPA"', async () => {
    h.create.mockResolvedValue(aiReply({ range_min: '12', range_max: '20.5', rationale: 'r', currency: 'USD' }));
    const out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max, out.currency]).toEqual([12, 20.5, 'LPA']);
  });

  it.each([[undefined], ['']])('a missing or empty rationale (%j) gets the default sentence', async rationale => {
    h.create.mockResolvedValue(aiReply({ range_min: 1, range_max: 2, rationale }));
    expect((await getCompBenchmark(role())).rationale).toBe('AI-estimated range — no internal benchmark data available for this role.');
  });

  it('a reply that is not JSON rejects with a SyntaxError (there is no fallback range)', async () => {
    h.create.mockResolvedValue(aiReply('I cannot estimate this.'));
    await expect(getCompBenchmark(role())).rejects.toThrow(SyntaxError);
  });

  it('CURRENT BEHAVIOUR: a reply with no text block parses as "{}" and returns NaN bounds (no validation of the model range)', async () => {
    h.create.mockResolvedValue({ content: [] });
    const out = await getCompBenchmark(role());
    expect(out.source).toBe('ai_estimate');
    expect(Number.isNaN(out.range_min)).toBe(true);
    expect(Number.isNaN(out.range_max)).toBe(true);
  });

  it('CURRENT BEHAVIOUR: an inverted model range (max below min) is returned as given', async () => {
    h.create.mockResolvedValue(aiReply({ range_min: 30, range_max: 10, rationale: 'r' }));
    const out = await getCompBenchmark(role());
    expect([out.range_min, out.range_max]).toEqual([30, 10]);
  });

  it('an SDK error is not swallowed', async () => {
    h.create.mockRejectedValue(new Error('synthetic API failure'));
    await expect(getCompBenchmark(role())).rejects.toThrow('synthetic API failure');
  });

  it('a database error is not swallowed and the model is not asked', async () => {
    h.query.mockRejectedValue(new Error('synthetic db failure'));
    await expect(getCompBenchmark(role())).rejects.toThrow('synthetic db failure');
    expect(h.create).not.toHaveBeenCalled();
  });
});
