import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The full_name rule on POST /api/candidates and PATCH /api/candidates/:id (utils/candidateName.ts): cleaned, and a name over the cap is a 400
// before any write. The real router, authenticate and requireHR run; the database and scoring are replaced.
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
vi.mock('../services/resumeIQTrigger.js', () => ({ runResumeIQScoring: vi.fn() }));

import candidatesRouter from './candidates.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, TEST_JWT_SECRET, buildApp, setEnv } from '../test/routeHarness.js';
import { FULL_NAME_MAX_CHARS } from '../utils/candidateName.js';

const api = new ApiClient(buildApp(app => app.use('/api/candidates', candidatesRouter)));
let restoreEnv: () => void = () => undefined;

const SQL = {
  existing: /^SELECT \* FROM candidates WHERE id = \$1$/,
  insert: /^INSERT INTO candidates \(/,
  update: /^UPDATE candidates SET (.+) WHERE id = \$(\d+) RETURNING \*$/,
};
const EXISTING = { id: 'C1001', full_name: 'Old Name', source: null, sourced_by_agency_id: null };

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.restoreAllMocks(); });

describe('POST /api/candidates', () => {
  beforeEach(() => { fakeDb.when(SQL.insert, params => [{ id: 'C9001', full_name: params[0] }]); });

  it('stores the cleaned name (whitespace collapsed) and creates the candidate', async () => {
    const res = await api.post('/api/candidates', { as: 'hr_recruiter', body: { full_name: '  Neha   Sharma ' } });
    expect(res.status).toBe(201);
    expect(fakeDb.one(SQL.insert).params[0]).toBe('Neha Sharma');
  });
  it('accepts a name of exactly the cap', async () => {
    const res = await api.post('/api/candidates', { as: 'hr_recruiter', body: { full_name: 'a'.repeat(FULL_NAME_MAX_CHARS) } });
    expect(res.status).toBe(201);
  });
  it('a name over the cap is a 400 and nothing is written', async () => {
    const res = await api.post('/api/candidates', { as: 'hr_recruiter', body: { full_name: 'a'.repeat(FULL_NAME_MAX_CHARS + 1) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(FULL_NAME_MAX_CHARS));
    expect(fakeDb.writes()).toEqual([]);
    expect(fakeDb.tx.started).toBe(0);
  });
  it.each([undefined, '', '   ', ' ', 42, { a: 1 }])('%j is "full_name required" (400), nothing written', async v => {
    const res = await api.post('/api/candidates', { as: 'hr_recruiter', body: { full_name: v } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'full_name required' });
    expect(fakeDb.writes()).toEqual([]);
  });
  it('a Hiring Manager is still refused before the name is looked at', async () => {
    const res = await api.post('/api/candidates', { as: 'hiring_manager', body: { full_name: 'x'.repeat(5000) } });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/candidates/:id', () => {
  beforeEach(() => {
    fakeDb.whenOne(SQL.existing, EXISTING);
    fakeDb.when(SQL.update, params => [{ ...EXISTING, full_name: params[0] }]);
  });

  it('a name over the cap is a 400 and nothing is written', async () => {
    const res = await api.patch('/api/candidates/C1001', { as: 'hr_recruiter', body: { full_name: 'b'.repeat(FULL_NAME_MAX_CHARS + 1) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(FULL_NAME_MAX_CHARS));
    expect(fakeDb.writes()).toEqual([]);
  });
  it.each(['', '   '])('%j is "full_name cannot be empty" (400)', async v => {
    const res = await api.patch('/api/candidates/C1001', { as: 'hr_recruiter', body: { full_name: v } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'full_name cannot be empty' });
    expect(fakeDb.writes()).toEqual([]);
  });
  it('writes (and logs) the cleaned name', async () => {
    const res = await api.patch('/api/candidates/C1001', { as: 'hr_recruiter', body: { full_name: '  New   Name ' } });
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.update).params[0]).toBe('New Name');
    const log = fakeDb.find(/^INSERT INTO candidate_edit_log/)[0];
    expect(log.params).toEqual(['C1001', 'full_name', 'Old Name', 'New Name', expect.any(String)]);
  });
  it('a re-spelling that cleans to the stored name is "No changes detected"', async () => {
    const res = await api.patch('/api/candidates/C1001', { as: 'hr_recruiter', body: { full_name: ' Old   Name ' } });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('No changes detected');
    expect(fakeDb.writes()).toEqual([]);
  });
  it('a PATCH that does not mention full_name is not affected', async () => {
    const res = await api.patch('/api/candidates/C1001', { as: 'hr_recruiter', body: { current_company: 'Acme' } });
    expect(res.status).toBe(200);
  });
});
