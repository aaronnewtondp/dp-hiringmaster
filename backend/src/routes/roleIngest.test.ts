import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// POST /api/roles/ingest: the Requisition Form's Apps Script webhook. Authenticated by a shared secret header, not a JWT. Pinned here: the secret
// gate (nothing touches the database without it), the dedup key, and how a form row becomes a Draft role. The database is answered from canned rows.
const h = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn(), found: null as null | { id: string; title: string } }));
vi.mock('../db/index.js', () => ({
  query: (...a: unknown[]) => h.query(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
  transaction: (fn: (c: unknown) => Promise<unknown>) => h.transaction(fn),
  pool: {},
}));

import router, { mapPriority, parseVacancyReason, parseNumOpenings, MAX_NUM_OPENINGS } from './roleIngest.js';

const SECRET = 'test-only-role-ingest-secret';
let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/roles', router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/roles`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function ingest(body: unknown, headers: Record<string, string> = { 'x-ingest-secret': SECRET }) {
  const res = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const insertCall = () => h.clientQuery.mock.calls.find(c => norm(c[0]).startsWith('INSERT INTO roles'))!;
const FORM = { timestamp: '2026-10-14 10:00:00', email: 'requester@example.test', job_title: 'Synthetic Role' };

beforeEach(() => {
  vi.stubEnv('ROLE_INGEST_SECRET', SECRET);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  h.found = null;
  h.query.mockReset().mockResolvedValue([]);
  h.queryOne.mockReset().mockResolvedValue(null);
  h.clientQuery.mockReset().mockImplementation(async (sql: string) => {
    if (norm(sql).startsWith('SELECT id, title FROM roles WHERE requisition_source_row')) return { rows: h.found ? [h.found] : [] };
    if (norm(sql).startsWith('INSERT INTO roles')) return { rows: [{ id: 'R007', title: 'Synthetic Role', status: 'Draft' }] };
    return { rows: [] };
  });
  h.transaction.mockReset().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: h.clientQuery }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('mapPriority (the form\'s priority text to P0-P3)', () => {
  it.each([
    ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3'],
    ['p0', 'P0'], ['p3', 'P3'], [' P2 ', 'P2'], ['\tp1\n', 'P1'],
  ])('%j is %s', (raw, expected) => { expect(mapPriority(raw)).toBe(expected); });

  it.each([
    [undefined], [''], ['   '], ['P4'], ['P9'], ['P'], ['0'], ['High'], ['P0 - urgent'], ['P 1'], ['P01'],
  ])('%j falls back to P1', raw => { expect(mapPriority(raw as string | undefined)).toBe('P1'); });
});

describe('parseVacancyReason ("Vacancy Caused Due To" is a multi-select joined with ", ")', () => {
  it.each([
    ['A, B', ['A', 'B']],
    ['Increased Work Load, Additional Assignments / Business Expansion', ['Increased Work Load', 'Additional Assignments / Business Expansion']],
    ['Single reason', ['Single reason']],
    ['  Padded  ', ['Padded']],
    [' A, B ', ['A', 'B']],
  ])('%j splits to %j', (raw, expected) => { expect(parseVacancyReason(raw)).toEqual(expected); });

  it.each([[''], ['   '], [undefined], [null], [0], [false]])('%j is null (nothing selected)', raw => {
    expect(parseVacancyReason(raw)).toBeNull();
  });

  it('only ", " (comma and space) separates reasons: a bare comma stays inside one reason', () => {
    expect(parseVacancyReason('Growth,Expansion')).toEqual(['Growth,Expansion']);
  });

  it('an array is passed through, each entry as a string', () => {
    expect(parseVacancyReason(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseVacancyReason([1, 2])).toEqual(['1', '2']);
    expect(parseVacancyReason([])).toEqual([]);
  });

  it('empty segments are kept as they come (no filtering): "A, , B" gives an empty middle entry', () => {
    expect(parseVacancyReason('A, , B')).toEqual(['A', '', 'B']);
  });
});

describe('the ingest secret', () => {
  it('no header: 401, and the database is never touched', async () => {
    const r = await ingest(FORM, {});
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'Invalid or missing ingest secret' });
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each(['', 'wrong', `${SECRET}x`, SECRET.toUpperCase(), SECRET.slice(0, -1)])('header %j: 401 and nothing runs', async value => {
    const r = await ingest(FORM, { 'x-ingest-secret': value });
    expect(r.status).toBe(401);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('the candidate-ingest secret is NOT accepted here', async () => {
    vi.stubEnv('CANDIDATE_INGEST_SECRET', 'other-secret');
    const r = await ingest(FORM, { 'x-ingest-secret': 'other-secret' });
    expect(r.status).toBe(401);
  });

  it.each(['undefined', 'null', ''])('with ROLE_INGEST_SECRET unset, a header of "%s" is still 401 (an unset secret never matches anything)', async value => {
    vi.stubEnv('ROLE_INGEST_SECRET', undefined as unknown as string);
    delete process.env.ROLE_INGEST_SECRET;
    const r = await ingest(FORM, { 'x-ingest-secret': value });
    expect(r.status).toBe(401);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('with ROLE_INGEST_SECRET unset, a request with NO header at all is still 401 (a missing header must never "equal" a missing secret)', async () => {
    vi.stubEnv('ROLE_INGEST_SECRET', undefined as unknown as string);
    delete process.env.ROLE_INGEST_SECRET;
    const r = await ingest(FORM, {});
    expect(r.status).toBe(401);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('the right secret is accepted', async () => {
    expect((await ingest(FORM)).status).toBe(201);
  });
});

describe('validation and dedup', () => {
  it('a missing job_title is a 400 and nothing is queried', async () => {
    const r = await ingest({ timestamp: 'x', email: 'a@example.test' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'job_title is required' });
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('dedups on "timestamp|email": the key is looked up inside the transaction, and a repeat answers 200 with the existing role and creates nothing', async () => {
    h.found = { id: 'R001', title: 'Synthetic Role' };
    const r = await ingest(FORM);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ message: 'Already ingested — skipped duplicate', role_id: 'R001' });
    const lookup = h.clientQuery.mock.calls.find(c => norm(c[0]).startsWith('SELECT id, title FROM roles'))!;
    expect(lookup[1]).toEqual(['2026-10-14 10:00:00|requester@example.test']);
    expect(h.clientQuery.mock.calls.some(c => norm(c[0]).startsWith('INSERT'))).toBe(false);
  });

  it('same-key posts are serialised: the advisory lock on the key is taken BEFORE the lookup and the insert', async () => {
    await ingest(FORM);
    const sqls = h.clientQuery.mock.calls.map(c => norm(c[0]));
    expect(sqls[0]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(h.clientQuery.mock.calls[0][1]).toEqual(['role-ingest:2026-10-14 10:00:00|requester@example.test']);
    expect(sqls[1]).toMatch(/^SELECT id, title FROM roles WHERE requisition_source_row/);
    expect(sqls[2]).toMatch(/^INSERT INTO roles/);
  });

  it('the key is stored on the new role so the next fire of the trigger finds it', async () => {
    await ingest(FORM);
    const params = insertCall()[1] as unknown[];
    expect(params[params.length - 1]).toBe('2026-10-14 10:00:00|requester@example.test');
  });

  it.each([
    ['neither field', {}],
    ['both empty', { timestamp: '', email: '' }],
    ['both blank', { timestamp: '  ', email: '\t' }],
    ['both null', { timestamp: null, email: null }],
  ])('a row with %s cannot be de-duplicated: 400, nothing is written and no transaction (no sequence value) is opened', async (_n, extra) => {
    const r = await ingest({ job_title: 'Synthetic Role', ...extra });
    expect(r.status).toBe(400);
    expect(String(r.json?.error)).toMatch(/de-duplicated/);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.clientQuery).not.toHaveBeenCalled();
  });

  it('a timestamp alone, or an e-mail alone, is enough to make a lookup key', async () => {
    await ingest({ job_title: 'R', timestamp: 'T1' });
    expect(h.clientQuery.mock.calls.find(c => norm(c[0]).startsWith('SELECT id, title'))![1]).toEqual(['T1|']);
    h.clientQuery.mockClear();
    await ingest({ job_title: 'R', email: 'a@example.test' });
    expect(h.clientQuery.mock.calls.find(c => norm(c[0]).startsWith('SELECT id, title'))![1]).toEqual(['|a@example.test']);
  });
});

describe('parseNumOpenings', () => {
  it.each([[undefined], [null], [''], ['   ']])('%j keeps the default of 1', raw => { expect(parseNumOpenings(raw)).toBe(1); });
  it.each([['3', 3], [' 4 ', 4], ['08', 8], [2, 2], ['1', 1], [String(MAX_NUM_OPENINGS), MAX_NUM_OPENINGS]])('%j is %s', (raw, n) => { expect(parseNumOpenings(raw)).toBe(n); });
  it.each([['abc'], ['0'], [0], ['-2'], [-2], ['1.5'], [1.5], ['3.9'], ['1e3'], ['0x10'], ['3 openings'], [NaN], [Infinity], [String(MAX_NUM_OPENINGS + 1)], ['99999999999999999999'], [true], [[3]], [{}]])('%j is invalid', raw => {
    expect(parseNumOpenings(raw)).toBeNull();
  });
});

describe('an invalid num_openings is refused BEFORE anything is written', () => {
  it.each(['abc', '0', '-2', '1.5', String(MAX_NUM_OPENINGS + 1)])('%j: 400, no transaction, so no sequence value is consumed', async bad => {
    const r = await ingest({ ...FORM, num_openings: bad });
    expect(r.status).toBe(400);
    expect(String(r.json?.error)).toMatch(/num_openings must be a whole number/);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.clientQuery).not.toHaveBeenCalled();
  });
});

describe('how a form row becomes a Draft role', () => {
  it('creates a Draft role, logs "Role Created" by System, and answers 201 with the role', async () => {
    const r = await ingest(FORM);
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ role: { id: 'R007', title: 'Synthetic Role', status: 'Draft' } });
    expect(norm(insertCall()[0])).toContain("'Draft'");
    const log = h.clientQuery.mock.calls.find(c => norm(c[0]).startsWith('INSERT INTO activity_log'))!;
    expect(log[1]).toEqual(['R007', 'Synthetic Role auto-created from Requisition Form submission']);
    expect(norm(log[0])).toContain("'Role Created'");
    expect(norm(log[0])).toContain("'System'");
  });

  it('does NOT set an open/start date (the aging clock starts at approval, not at the form)', async () => {
    await ingest(FORM);
    expect(norm(insertCall()[0])).not.toContain('start_date');
  });

  it('the role id is NOT built in the route: the INSERT leaves id out so the column default (format_seq_id, 4-digit pad) applies, like POST /roles', async () => {
    await ingest(FORM);
    const sql = norm(insertCall()[0]);
    expect(sql).toMatch(/^INSERT INTO roles \( title,/);
    expect(sql).not.toMatch(/\(\s*id\b/);
    expect(h.clientQuery.mock.calls.some(c => norm(c[0]).includes('nextval'))).toBe(false);
  });

  it('maps every form field to its column, in order', async () => {
    await ingest({
      timestamp: 'T', email: 'e@example.test', department: 'Engineering', hiring_manager: 'Test Manager', priority_level: 'p0',
      new_or_replacement: 'New', vacancy_reason: 'A, B', job_title: 'Synthetic Role', num_openings: '3', location: 'Pune',
      appointment_type: 'Full-time', qualification_required: 'B.Tech', must_have_skills: 'Must', nice_to_have_skills: 'Nice',
      yoe_required: '5-8', ctc_band: 'band', kpi_expectations: 'kpi', additional_remarks: 'remarks', target_closure_date: '2026-12-01',
    });
    expect(insertCall()[1]).toEqual([
      'Synthetic Role', 'Engineering', 'Test Manager', 'P0', 3, 'Pune',
      'New', ['A', 'B'], 'Full-time', 'B.Tech', 'Must', 'Nice', '5-8', 'band', 'kpi', 'remarks', '2026-12-01', 'T|e@example.test',
    ]);
  });

  it('every optional field that is absent is stored as null; priority defaults to P1 and openings to 1', async () => {
    await ingest({ job_title: 'Only A Title', timestamp: 'T' });
    expect(insertCall()[1]).toEqual(['Only A Title', null, null, 'P1', 1, null, null, null, null, null, null, null, null, null, null, null, null, 'T|']);
  });

  it('an empty-string field is stored as null, not as ""', async () => {
    await ingest({ ...FORM, job_title: 'T', department: '', location: '', must_have_skills: '', ctc_band: '' });
    const p = insertCall()[1] as unknown[];
    expect([p[1], p[5], p[10], p[13]]).toEqual([null, null, null, null]);
  });

  it('num_openings is read as a decimal integer ("08" is 8; a JSON number is accepted)', async () => {
    await ingest({ ...FORM, num_openings: '08' });
    expect((insertCall()[1] as unknown[])[4]).toBe(8);
    h.clientQuery.mockClear();
    await ingest({ ...FORM, num_openings: 5 });
    expect((insertCall()[1] as unknown[])[4]).toBe(5);
  });

  describe('the Hiring Manager field is stored canonically ("A, B"), whatever delimiter the form used', () => {
    it.each([
      ['Test One and Test Two', 'Test One, Test Two'],
      ['Test One & Test Two', 'Test One, Test Two'],
      ['Test One; Test Two', 'Test One, Test Two'],
      ['  Test   One  ', 'Test One'],
      ['A, B, and C', 'A, B, C'],
    ])('%j is stored as %j', async (typed, stored) => {
      await ingest({ ...FORM, job_title: 'T', hiring_manager: typed });
      expect((insertCall()[1] as unknown[])[2]).toBe(stored);
    });

    it.each([[''], ['   '], [undefined], [',;&']])('%j is stored as null (no Hiring Manager)', async typed => {
      await ingest({ ...FORM, job_title: 'T', hiring_manager: typed });
      expect((insertCall()[1] as unknown[])[2]).toBeNull();
    });
  });

  it('a priority the form sent in any case is normalised; an unknown one becomes P1', async () => {
    await ingest({ ...FORM, job_title: 'T', priority_level: ' p3 ' });
    expect((insertCall()[1] as unknown[])[3]).toBe('P3');
    h.clientQuery.mockClear();
    await ingest({ ...FORM, job_title: 'T', priority_level: 'Urgent' });
    expect((insertCall()[1] as unknown[])[3]).toBe('P1');
  });

  it('the role is created inside one transaction (id, role and activity row together)', async () => {
    await ingest(FORM);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    const sqls = h.clientQuery.mock.calls.map(c => norm(c[0]));
    expect(sqls[0]).toContain('pg_advisory_xact_lock');
    expect(sqls[1]).toMatch(/^SELECT id, title FROM roles/);
    expect(sqls[2]).toMatch(/^INSERT INTO roles/);
    expect(sqls[3]).toMatch(/^INSERT INTO activity_log/);
  });
});
