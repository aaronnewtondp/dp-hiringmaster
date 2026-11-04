import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// POST /api/candidates/ingest: the Job Application Form's Apps Script webhook. Authenticated by its own shared secret (CANDIDATE_INGEST_SECRET,
// not the role-ingest one), not a JWT. Pinned here: the secret gate, e-mail dedup, the fill-null-only update of a repeat applicant, how the role is
// matched, the application that is created and the scoring that follows. The database, the scorer and the gender classifier are stubbed; everything
// else (the SQL text that matters, the parameter order, the response shapes) is the real route.
const h = vi.hoisted(() => ({ transaction: vi.fn(), clientQuery: vi.fn(), score: vi.fn(), classify: vi.fn() }));
vi.mock('../db/index.js', () => ({
  transaction: (fn: (c: unknown) => Promise<unknown>) => h.transaction(fn),
  query: vi.fn(), queryOne: vi.fn(), pool: {},
}));
vi.mock('../services/resumeIQTrigger.js', () => ({ runResumeIQScoring: (...a: unknown[]) => h.score(...a) }));
vi.mock('../utils/genderClassifier.js', () => ({ classifyGender: (...a: unknown[]) => h.classify(...a) }));

import router, { PROFILE_FIELDS, toNum, toStr } from './candidateIngest.js';

const SECRET = 'test-only-candidate-ingest-secret';
let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/candidates', router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/candidates`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function ingest(body: unknown, headers: Record<string, string> = { 'x-ingest-secret': SECRET }) {
  const res = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json: json as Record<string, any>, text };
}

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();

// What the stubbed database answers. Reset before every test.
const db = {
  existingCandidate: null as Record<string, unknown> | null,
  roles: [] as Array<{ id: string; title: string }>,
  existingApp: null as { id: string } | null,
};
const callsTo = (prefix: string) => h.clientQuery.mock.calls.filter(c => norm(c[0]).startsWith(prefix));
const insertCandidate = () => callsTo('INSERT INTO candidates')[0];
const updateCandidate = () => callsTo('UPDATE candidates')[0];
const insertApplication = () => callsTo('INSERT INTO applications')[0];

const FORM = { email: 'applicant@example.test', full_name: 'Synthetic Applicant' };

beforeEach(() => {
  vi.stubEnv('CANDIDATE_INGEST_SECRET', SECRET);
  vi.stubEnv('SOURCING_ENABLED', 'false');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db.existingCandidate = null; db.roles = []; db.existingApp = null;
  h.classify.mockReset().mockReturnValue(null);
  h.score.mockReset().mockResolvedValue({ scored: true });
  h.clientQuery.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = norm(sql);
    if (s.startsWith('SELECT * FROM candidates WHERE email')) return { rows: db.existingCandidate ? [db.existingCandidate] : [] };
    if (s.startsWith('INSERT INTO candidates')) return { rows: [{ id: 'C9001', email: params[1] }] };
    if (s.startsWith('UPDATE candidates')) return { rows: [{ id: (db.existingCandidate as { id: string }).id }] };
    if (s.startsWith('SELECT id, title FROM roles')) return { rows: db.roles };
    if (s.startsWith('SELECT id FROM applications')) return { rows: db.existingApp ? [db.existingApp] : [] };
    if (s.startsWith('INSERT INTO applications')) return { rows: [{ id: 'A9001', role_id: params[1] }] };
    return { rows: [] };
  });
  h.transaction.mockReset().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: h.clientQuery }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('toNum (a form number cell to a number, or null)', () => {
  it.each([[undefined], [null], [''], ['abc'], ['1,200'], ['12 lakh'], ['Infinity'], [NaN], ['--3']])('%j is null', raw => {
    expect(toNum(raw)).toBeNull();
  });
  it.each([
    [0, 0], ['0', 0], [12.5, 12.5], ['12.5', 12.5], ['-3', -3], [' 7 ', 7], ['1e3', 1000], [1200000, 1200000],
  ])('%j is %s', (raw, expected) => { expect(toNum(raw)).toBe(expected); });
  it('zero is a real number, not "missing" (a candidate with no variable pay says 0)', () => {
    expect(toNum(0)).toBe(0);
    expect(toNum('0')).toBe(0);
  });
});

describe('toStr (a form text cell to trimmed text, or null)', () => {
  it.each([[undefined], [null], [''], ['   '], ['\t\n']])('%j is null', raw => { expect(toStr(raw)).toBeNull(); });
  it.each([['  hello  ', 'hello'], ['x', 'x'], [0, '0'], [false, 'false'], [42, '42']])('%j is %j', (raw, expected) => {
    expect(toStr(raw)).toBe(expected);
  });
});

describe('PROFILE_FIELDS (the columns a repeat applicant may fill in)', () => {
  it('is exactly the 14 profile columns, in this order', () => {
    expect([...PROFILE_FIELDS]).toEqual([
      'phone', 'linkedin_url', 'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc', 'notice_period_days',
      'current_company', 'current_industry', 'current_designation', 'current_location', 'years_of_experience', 'resume_drive_link', 'languages_known',
    ]);
  });
  it.each(['id', 'email', 'full_name', 'source', 'gender'])('never contains the identity or inferred column %s', col => {
    expect((PROFILE_FIELDS as readonly string[]).includes(col)).toBe(false);
  });
  it('every one is a column of the INSERT a new applicant gets (so the list and the SQL cannot drift apart)', async () => {
    await ingest(FORM);
    const sql = norm(insertCandidate()[0]);
    for (const f of PROFILE_FIELDS) expect(sql).toContain(f);
  });
});

describe('the ingest secret', () => {
  it('no header: 401, and the database is never touched', async () => {
    const r = await ingest(FORM, {});
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'Invalid or missing ingest secret' });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.score).not.toHaveBeenCalled();
  });

  it.each(['', 'wrong', `${SECRET}x`, SECRET.toUpperCase(), SECRET.slice(1)])('header %j: 401 and nothing runs', async value => {
    const r = await ingest(FORM, { 'x-ingest-secret': value });
    expect(r.status).toBe(401);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('the ROLE ingest secret is NOT accepted here (two separate secrets)', async () => {
    vi.stubEnv('ROLE_INGEST_SECRET', 'the-role-secret');
    const r = await ingest(FORM, { 'x-ingest-secret': 'the-role-secret' });
    expect(r.status).toBe(401);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each(['undefined', 'null', ''])('with CANDIDATE_INGEST_SECRET unset, a header of "%s" is still 401 (an unset secret never matches anything)', async value => {
    delete process.env.CANDIDATE_INGEST_SECRET;
    const r = await ingest(FORM, { 'x-ingest-secret': value });
    expect(r.status).toBe(401);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('with CANDIDATE_INGEST_SECRET unset, a request with NO header at all is still 401 (a missing header must never "equal" a missing secret)', async () => {
    delete process.env.CANDIDATE_INGEST_SECRET;
    const r = await ingest(FORM, {});
    expect(r.status).toBe(401);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('with the secret set to an empty string, an empty header is still rejected', async () => {
    vi.stubEnv('CANDIDATE_INGEST_SECRET', '');
    const r = await ingest(FORM, { 'x-ingest-secret': '' });
    expect(r.status).toBe(401);
  });

  it('the right secret is accepted', async () => {
    expect((await ingest(FORM)).status).toBe(201);
  });
});

describe('validation', () => {
  it.each([
    [{ full_name: 'Synthetic Applicant' }],
    [{ email: 'a@example.test' }],
    [{ email: '', full_name: 'X' }],
    [{ email: 'a@example.test', full_name: '' }],
    [{}],
  ])('%j is a 400 "email and full_name are required" and nothing runs', async body => {
    const r = await ingest(body);
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'email and full_name are required' });
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe('a new applicant', () => {
  it('is inserted with the e-mail trimmed and lower-cased, and the lookup uses the same normalised e-mail', async () => {
    await ingest({ email: '  Mixed.Case@Example.TEST ', full_name: 'Synthetic Applicant' });
    expect(callsTo('SELECT * FROM candidates WHERE email')[0][1]).toEqual(['mixed.case@example.test']);
    expect((insertCandidate()[1] as unknown[])[1]).toBe('mixed.case@example.test');
  });

  it('maps every form field to its column, in order; the source is hard-coded to LinkedIn and gender comes from the classifier', async () => {
    h.classify.mockReturnValue('F');
    await ingest({
      ...FORM, phone: ' 9000000000 ', linkedin_url: 'https://example.test/in/x', current_ctc_fixed: '1200000', current_ctc_variable: '0',
      current_esops: '5000', expected_ctc: 1500000, notice_period_days: '30', current_company: 'Example Co', current_industry: 'Water',
      current_designation: 'Engineer', current_location: 'Pune', years_of_experience: '6.5', resume_drive_link: 'https://drive.example.test/f/1',
      languages_known: 'English, Hindi',
    });
    const [sql, params] = insertCandidate();
    expect(norm(sql)).toContain("'LinkedIn'");
    expect(params).toEqual([
      'Synthetic Applicant', 'applicant@example.test', '9000000000', 'https://example.test/in/x', 1200000, 0, 5000, 1500000,
      30, 'Example Co', 'Water', 'Engineer', 'Pune', 6.5, 'https://drive.example.test/f/1', 'English, Hindi', 'F',
    ]);
  });

  it('every absent or blank optional field is stored as null (not "" and not NaN)', async () => {
    await ingest({ ...FORM, phone: '', current_ctc_fixed: '', expected_ctc: 'n/a', notice_period_days: undefined, current_company: '   ' });
    const p = insertCandidate()[1] as unknown[];
    expect(p.slice(2, 16)).toEqual(new Array(14).fill(null));
  });

  it('full_name is stored as typed (not trimmed here) and is what the gender classifier reads', async () => {
    await ingest({ email: 'a@example.test', full_name: 'Synthetic  Applicant' });
    expect((insertCandidate()[1] as unknown[])[0]).toBe('Synthetic  Applicant');
    expect(h.classify).toHaveBeenCalledWith('Synthetic  Applicant');
  });

  it('an unknown name (classifier says null) is stored with gender null, never guessed', async () => {
    h.classify.mockReturnValue(null);
    await ingest(FORM);
    expect((insertCandidate()[1] as unknown[])[16]).toBeNull();
  });

  it('no UPDATE runs for a new applicant, and without a role the answer is 201 with no application and no scoring', async () => {
    const r = await ingest(FORM);
    expect(r.status).toBe(201);
    expect(updateCandidate()).toBeUndefined();
    expect(r.json.application).toBeNull();
    expect(r.json.candidate).toEqual({ id: 'C9001', email: 'applicant@example.test' });
    expect(r.json.resumeiq).toBeUndefined();
    expect(h.score).not.toHaveBeenCalled();
    expect(callsTo('SELECT id, title FROM roles')).toHaveLength(0);
  });
});

describe('a repeat applicant: fill-null-only', () => {
  const EXISTING = { id: 'C0100', email: 'applicant@example.test', source: 'Naukri', gender: 'M' } as Record<string, unknown>;
  const setOf = () => {
    const [sql, params] = updateCandidate();
    const m = /SET (.*) WHERE id = \$(\d+)/.exec(norm(sql))!;
    return { clauses: m[1].split(', '), idParam: Number(m[2]), params: params as unknown[] };
  };

  it('updates the existing row (no second candidate is inserted) and the id is the LAST parameter', async () => {
    db.existingCandidate = { ...EXISTING };
    await ingest(FORM);
    expect(insertCandidate()).toBeUndefined();
    const { idParam, params } = setOf();
    expect(params[params.length - 1]).toBe('C0100');
    expect(idParam).toBe(params.length);
  });

  it('a profile field that is already filled is NOT overwritten; a null one is filled', async () => {
    db.existingCandidate = { ...EXISTING, phone: 'HR-corrected', expected_ctc: null, current_company: 'Kept Co' };
    await ingest({ ...FORM, phone: 'from-form', expected_ctc: 900000, current_company: 'Other Co' });
    const { clauses, params } = setOf();
    expect(clauses).toContain('expected_ctc = $2');
    expect(clauses.some(c => c.startsWith('phone'))).toBe(false);
    expect(clauses.some(c => c.startsWith('current_company'))).toBe(false);
    expect(params).toContain(900000);
    expect(params).not.toContain('from-form');
    expect(params).not.toContain('Other Co');
  });

  it('a zero or an empty string already on file counts as filled (only null/undefined is filled in)', async () => {
    db.existingCandidate = { ...EXISTING, current_ctc_variable: 0, phone: '', languages_known: null };
    await ingest({ ...FORM, current_ctc_variable: 500, phone: '9111111111', languages_known: 'Hindi' });
    const { clauses } = setOf();
    expect(clauses.some(c => c.startsWith('current_ctc_variable'))).toBe(false);
    expect(clauses.some(c => c.startsWith('phone'))).toBe(false);
    expect(clauses.some(c => c.startsWith('languages_known'))).toBe(true);
  });

  it('a null field with nothing submitted for it gets no clause (null is never written over null)', async () => {
    db.existingCandidate = { ...EXISTING, phone: null, linkedin_url: undefined };
    await ingest(FORM);
    const { clauses } = setOf();
    expect(clauses.some(c => c.startsWith('phone') || c.startsWith('linkedin_url'))).toBe(false);
  });

  it('full_name IS refreshed on every repeat submission (always the first clause), the one field the header comment excludes from fill-null-only', async () => {
    db.existingCandidate = { ...EXISTING };
    await ingest({ email: 'applicant@example.test', full_name: 'Renamed Applicant' });
    const { clauses, params } = setOf();
    expect(clauses[0]).toBe('full_name = $1');
    expect(params[0]).toBe('Renamed Applicant');
  });

  it('a repeat applicant with nothing new still gets exactly the full_name update', async () => {
    db.existingCandidate = { ...EXISTING };
    await ingest(FORM);
    expect(setOf().clauses).toEqual(['full_name = $1']);
  });

  it('source is filled with LinkedIn only while it is null; an existing source is kept', async () => {
    db.existingCandidate = { ...EXISTING, source: null };
    await ingest(FORM);
    expect(setOf().clauses.some(c => c.startsWith('source'))).toBe(true);
    expect(setOf().params).toContain('LinkedIn');

    h.clientQuery.mockClear();
    db.existingCandidate = { ...EXISTING, source: 'Naukri' };
    await ingest(FORM);
    expect(setOf().clauses.some(c => c.startsWith('source'))).toBe(false);
  });

  it('gender is filled only while null, from the (refreshed) name, and only when the classifier is sure', async () => {
    db.existingCandidate = { ...EXISTING, gender: null };
    h.classify.mockReturnValue('F');
    await ingest({ email: 'applicant@example.test', full_name: 'Renamed Applicant' });
    expect(h.classify).toHaveBeenCalledWith('Renamed Applicant');
    expect(setOf().clauses.some(c => c.startsWith('gender'))).toBe(true);
    expect(setOf().params).toContain('F');

    h.clientQuery.mockClear();
    h.classify.mockReturnValue(null);
    await ingest(FORM);
    expect(setOf().clauses.some(c => c.startsWith('gender'))).toBe(false);
  });

  it('an existing gender (an HR correction included) is never overwritten and the classifier is not even asked', async () => {
    db.existingCandidate = { ...EXISTING, gender: 'M' };
    h.classify.mockReturnValue('F');
    await ingest(FORM);
    expect(setOf().clauses.some(c => c.startsWith('gender'))).toBe(false);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('placeholders are numbered without gaps whichever clauses are present', async () => {
    db.existingCandidate = { ...EXISTING, source: null, gender: null, phone: null, notice_period_days: null };
    h.classify.mockReturnValue('M');
    await ingest({ ...FORM, phone: '9222222222', notice_period_days: '15' });
    const { clauses, params, idParam } = setOf();
    const nums = clauses.map(c => Number(/\$(\d+)/.exec(c)![1]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    expect(idParam).toBe(nums.length + 1);
    expect(params).toHaveLength(nums.length + 1);
  });
});

describe('matching the applicant to a role', () => {
  const ROLE = { id: 'R900', title: 'Synthetic Role' };

  it('looks the role up by the trimmed text, ignoring closed roles, case, runs of spaces and dash style', async () => {
    db.roles = [ROLE];
    await ingest({ ...FORM, role_applied_for: '  Synthetic Role  ' });
    const [sql, params] = callsTo('SELECT id, title FROM roles')[0];
    expect(params).toEqual(['Synthetic Role']);
    const s = norm(sql);
    expect(s).toContain("translate(trim(title), '–—', '--')");
    expect(s).toContain("translate(trim($1), '–—', '--')");
    expect(s).toContain("regexp_replace(");
    expect(s).toMatch(/lower\(.*\) = lower\(.*\)/);
    expect(s).toContain("status NOT IN ('Closed – Filled', 'Closed – Cancelled')");
  });

  it('a blank role answer does no lookup at all', async () => {
    await ingest({ ...FORM, role_applied_for: '   ' });
    expect(callsTo('SELECT id, title FROM roles')).toHaveLength(0);
    expect(h.score).not.toHaveBeenCalled();
  });

  it('no open role matches: a warning naming the text, an "Unmatched Role" activity row for HR, no application, no scoring, still 201', async () => {
    db.roles = [];
    const r = await ingest({ ...FORM, role_applied_for: 'Nonexistent Role' });
    expect(r.status).toBe(201);
    expect(r.json.warning).toBe('No open role matched "Nonexistent Role"');
    expect(r.json.application).toBeNull();
    expect(insertApplication()).toBeUndefined();
    const log = callsTo('INSERT INTO activity_log')[0];
    expect(norm(log[0])).toContain("'Unmatched Role — Manual Reconciliation'");
    expect(log[1]).toEqual(['C9001', 'Nonexistent Role', 'System']);
    expect(h.score).not.toHaveBeenCalled();
  });

  it('two roles match: it refuses to guess ("ambiguous"), same reconciliation row, no application', async () => {
    db.roles = [ROLE, { id: 'R901', title: 'Synthetic Role' }];
    const r = await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(r.status).toBe(201);
    expect(r.json.warning).toBe('Multiple roles matched "Synthetic Role" — ambiguous');
    expect(insertApplication()).toBeUndefined();
    expect(callsTo('INSERT INTO activity_log')).toHaveLength(1);
    expect(h.score).not.toHaveBeenCalled();
  });
});

describe('the application created for a matched role', () => {
  const ROLE = { id: 'R900', title: 'Synthetic Role' };
  beforeEach(() => { db.roles = [ROLE]; });

  it('starts at "Applied and Screened", Active, screening status New, 48h SLA, channel "Job Application Form"', async () => {
    const r = await ingest({ ...FORM, role_applied_for: 'Synthetic Role', preferred_location: ' Pune ', qualifications_note: 'B.Tech' });
    expect(r.status).toBe(201);
    const [sql, params] = insertApplication();
    const s = norm(sql);
    expect(s).toContain("'Job Application Form'");
    expect(s).toContain("'Applied and Screened','Active','New',NOW(),48");
    expect(params.slice(0, 4)).toEqual(['C9001', 'R900', 'Pune', 'B.Tech']);
    expect(r.json.application).toEqual({ id: 'A9001', role_id: 'R900' });
  });

  it('writes an "Application Created" activity row by System, tied to the application, candidate and role', async () => {
    await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    const log = callsTo('INSERT INTO activity_log')[0];
    expect(norm(log[0])).toContain("'Application Created'");
    expect(log[1]).toEqual(['A9001', 'C9001', 'R900', 'System']);
  });

  it('scores the new application, awaited, and returns the result with the response', async () => {
    h.score.mockResolvedValue({ scored: true });
    const r = await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(h.score).toHaveBeenCalledTimes(1);
    expect(h.score).toHaveBeenCalledWith('A9001');
    expect(r.json.resumeiq).toEqual({ scored: true });
  });

  it('a scoring failure is reported in the response, never a failed request (the application stays created)', async () => {
    h.score.mockResolvedValue({ scored: false, error: 'synthetic scoring failure' });
    const r = await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(r.status).toBe(201);
    expect(r.json.resumeiq).toEqual({ scored: false, error: 'synthetic scoring failure' });
    expect(r.json.application.id).toBe('A9001');
  });

  it('a second submission for the same role answers 200 "Already ingested" with the existing application, creates nothing and does not score', async () => {
    db.existingApp = { id: 'A0042' };
    const r = await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ message: 'Already ingested — skipped duplicate', application_id: 'A0042' });
    expect(callsTo('SELECT id FROM applications')[0][1]).toEqual(['C9001', 'R900']);
    expect(insertApplication()).toBeUndefined();
    expect(h.score).not.toHaveBeenCalled();
  });

  it('the candidate row is still created or refreshed on that duplicate (only the application is skipped)', async () => {
    db.existingApp = { id: 'A0042' };
    await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(insertCandidate()).toBeDefined();
  });

  describe('screening_answers: only well-formed {question, answer} string pairs are kept', () => {
    const stored = () => JSON.parse(insertApplication()[1][4] as string);
    it('keeps every well-formed pair, in order', async () => {
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', screening_answers: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] });
      expect(stored()).toEqual([{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }]);
    });
    it('drops entries whose question or answer is missing or not a string, and non-object entries', async () => {
      await ingest({
        ...FORM, role_applied_for: 'Synthetic Role',
        screening_answers: [
          { question: 'Q1', answer: 'kept' }, { question: 'Q2' }, { answer: 'A3' }, { question: 5, answer: 'A4' }, { question: 'Q5', answer: 6 },
          { question: 'Q6', answer: null }, null, 'a string', 7, [], { question: 'Q7', answer: '' },
        ],
      });
      expect(stored()).toEqual([{ question: 'Q1', answer: 'kept' }, { question: 'Q7', answer: '' }]);
    });
    it.each([[undefined], [null], ['not an array'], [{ question: 'Q', answer: 'A' }], [42]])('a non-array value (%j) is stored as an empty list', async value => {
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', screening_answers: value });
      expect(stored()).toEqual([]);
    });
    it('extra keys on an entry are not stored', async () => {
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', screening_answers: [{ question: 'Q', answer: 'A', injected: 'x' }] });
      // The filter keeps the original object (it only tests the two keys), so this pins the CURRENT pass-through of extra keys.
      expect(stored()).toEqual([{ question: 'Q', answer: 'A', injected: 'x' }]);
    });
  });

  describe('sub_source (sourcing attribution) is written only while the sourcing module is on', () => {
    it('off: NULL, whatever the form said', async () => {
      vi.stubEnv('SOURCING_ENABLED', 'false');
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', source_tag: 'Naukri' });
      expect(insertApplication()[1][5]).toBeNull();
    });
    it.each(['', 'TRUE', '1', 'yes'])('SOURCING_ENABLED=%j is off (only the exact word "true" turns it on)', async v => {
      vi.stubEnv('SOURCING_ENABLED', v);
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', source_tag: 'Naukri' });
      expect(insertApplication()[1][5]).toBeNull();
    });
    it.each([
      ['Naukri/IIMJobs', 'Naukri/IIMjobs'], ['Linkedin', 'LinkedIn'], ['DigitalPaani HR Outreach', 'Direct Outreach'],
      ['Hiring Agency', 'Agency'], ['DigitalPaani Employee Referral', 'Internal Referral'],
    ])('on: the form answer %j is stored as the channel %j', async (tag, channel) => {
      vi.stubEnv('SOURCING_ENABLED', 'true');
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', source_tag: tag });
      expect(insertApplication()[1][5]).toBe(channel);
    });
    it('on: a missing tag is stored as the untagged marker and an unknown one as Other (never free text)', async () => {
      vi.stubEnv('SOURCING_ENABLED', 'true');
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
      const untagged = insertApplication()[1][5];
      expect(untagged).toEqual(expect.any(String));
      h.clientQuery.mockClear();
      await ingest({ ...FORM, role_applied_for: 'Synthetic Role', source_tag: 'A free text answer' });
      const other = insertApplication()[1][5];
      expect(other).not.toBe('A free text answer');
      expect(other).not.toBe(untagged);
    });
  });
});

describe('the whole ingest runs in one transaction', () => {
  it('candidate, role lookup, application and activity rows all go through the same client, in that order', async () => {
    db.roles = [{ id: 'R900', title: 'Synthetic Role' }];
    await ingest({ ...FORM, role_applied_for: 'Synthetic Role' });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    const order = h.clientQuery.mock.calls.map(c => norm(c[0]).split(' ').slice(0, 3).join(' '));
    expect(order).toEqual([
      'SELECT * FROM', 'INSERT INTO candidates', 'SELECT id, title', 'SELECT id FROM', 'INSERT INTO applications', 'INSERT INTO activity_log',
    ]);
  });
});
