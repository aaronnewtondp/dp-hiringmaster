// ─────────────────────────────────────────────────────────────────────────────
// The production smoke accounts are READ-ONLY (middleware/auth.ts authenticate()): any authenticated request from an e-mail on
// `hms-smoke.invalid` whose method is not GET / HEAD / OPTIONS is answered 403 {"error":"Smoke-test accounts are read-only"}, whatever the
// persona. This is the control that makes `npm run test:prod` safe to point at production, and the README says it was "checked live" — but
// until now only Vitest (middleware/auth.test.ts) exercised it, never a running server.
//
// Two ways in, neither needing a real smoke account to exist:
//   1. FORGED tokens (node:crypto + the stack's public dev JWT secret, helpers/api-specs.ts) for any smoke address and persona — the guard
//      reads the token's e-mail, so this is exactly what it sees in production.
//   2. A REAL account: a throw-away user on the smoke domain cloned from a seeded password hash, signed in through POST /api/auth/login.
// Every write below targets an id that does not exist (or a unique marker the test then proves was never written), so a regression of
// the guard answers 404/400 instead of damaging data. Real SMOKE_* credentials, when configured, get one extra test at the end.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { BASE, SMOKE_USERS, USERS, getSession, uid } from '../helpers/api';
import { forgeToken, rawStatus, type ForgedUser } from '../helpers/api-specs';
import { withDb } from '../helpers/db';

const READ_ONLY = { error: 'Smoke-test accounts are read-only' };
const PERSONAS: ForgedUser['persona'][] = ['leadership', 'hiring_manager', 'hr_recruiter', 'super_admin'];
const bearer = (email: string, persona: ForgedUser['persona']) => ({ Authorization: `Bearer ${forgeToken({ email, persona })}` });

type Write = [method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: object];
const writes = (marker: string): Write[] => [
  ['POST',   '/api/roles', { title: `Smoke guard role ${marker}`, priority: 'P3' }],
  ['POST',   '/api/candidates', { full_name: `Smoke Guard ${marker}` }],
  ['POST',   '/api/agencies', { name: `Smoke guard agency ${marker}` }],
  ['POST',   '/api/interviews', { application_id: `A-NOPE-${marker}`, round_name: 'x' }],
  ['POST',   '/api/users', { name: 'x', email: `x+${marker}@digitalpaani.com`, persona: 'hiring_manager' }],
  ['PATCH',  `/api/roles/R-NOPE-${marker}`, { title: 'x' }],
  ['PATCH',  `/api/candidates/C-NOPE-${marker}`, { full_name: 'x' }],
  ['PUT',    '/api/sourcing/settings', { qualified_rule: 'either' }],
  ['DELETE', `/api/roles/R-NOPE-${marker}`],
  ['DELETE', `/api/candidates/C-NOPE-${marker}`],
  ['POST',   `/api/applications/A-NOPE-${marker}/stage`, { new_stage: 'Interview Round 1' }],
  ['POST',   `/api/applications/A-NOPE-${marker}/retry-scoring`, {}],
];

test.describe('smoke accounts are read-only (forged tokens)', () => {

  test('every write method answers 403 "Smoke-test accounts are read-only", whatever the persona, and nothing is written', async ({ request }) => {
    const marker = uid();
    for (const persona of PERSONAS) {
      const headers = bearer(`smoke.${persona}+${marker}@hms-smoke.invalid`, persona);
      for (const [method, path, data] of writes(marker)) {
        const res = await rawStatus(request, method, path, { headers, data });
        expect(res.status, `${persona}: ${method} ${path}`).toBe(403);
        expect(res.body, `${persona}: ${method} ${path}`).toEqual(READ_ONLY);
      }
    }
    // The three writes that would have left a trace if the guard had let them through.
    const traces = await withDb(async c => ({
      roles: (await c.query('SELECT count(*)::int AS n FROM roles WHERE title = $1', [`Smoke guard role ${marker}`])).rows[0].n,
      candidates: (await c.query('SELECT count(*)::int AS n FROM candidates WHERE full_name = $1', [`Smoke Guard ${marker}`])).rows[0].n,
      agencies: (await c.query('SELECT count(*)::int AS n FROM agencies WHERE name = $1', [`Smoke guard agency ${marker}`])).rows[0].n,
    }));
    expect(traces).toEqual({ roles: 0, candidates: 0, agencies: 0 });
  });

  test('the guard outranks the route: a smoke token with persona super_admin is 403 read-only on /api/users, not a 400/201', async ({ request }) => {
    const res = await rawStatus(request, 'POST', '/api/users', {
      headers: bearer(`smoke.sa+${uid()}@hms-smoke.invalid`, 'super_admin'),
      data: { name: 'Should Not Exist', email: `should.not.exist+${uid()}@digitalpaani.com`, persona: 'leadership' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(READ_ONLY);
  });

  test('GET, HEAD and OPTIONS are allowed for a smoke account (it can read what its persona may read)', async ({ request }) => {
    const leadership = bearer(`smoke.read+${uid()}@hms-smoke.invalid`, 'leadership');
    for (const p of ['/api/auth/me', '/api/roles', '/api/candidates?limit=1', '/api/applications?limit=1', '/api/agencies', '/api/interviews?application_id=A-NOPE']) {
      const res = await rawStatus(request, 'GET', p, { headers: leadership });
      expect(res.status, `GET ${p}`).toBe(200);
    }
    expect((await rawStatus(request, 'HEAD', '/api/roles', { headers: leadership })).status).toBe(200);
    // A CORS preflight is answered by the cors middleware before authentication: allowed, never the read-only 403.
    const options = await rawStatus(request, 'OPTIONS', '/api/roles', { headers: leadership });
    expect(options.status).toBeLessThan(300);

    // A Hiring Manager smoke account reads through the same gate (and stays a Hiring Manager: no HR-only list).
    const hm = bearer(`smoke.hm+${uid()}@hms-smoke.invalid`, 'hiring_manager');
    expect((await rawStatus(request, 'GET', '/api/roles', { headers: hm })).status).toBe(200);
    expect((await rawStatus(request, 'GET', '/api/agencies', { headers: hm })).status).toBe(403);
  });

  test('the two public POSTs stay open to a smoke address (they never pass authenticate): logout, and login (which fails on credentials, not on the guard)', async ({ request }) => {
    const headers = bearer(`smoke.public+${uid()}@hms-smoke.invalid`, 'leadership');
    const logout = await rawStatus(request, 'POST', '/api/auth/logout', { headers });
    expect(logout.status).toBe(200);
    const login = await rawStatus(request, 'POST', '/api/auth/login', { data: { email: `nobody+${uid()}@hms-smoke.invalid`, password: 'x' } });
    expect(login.status).toBe(401);
    expect(login.body).toEqual({ error: 'Invalid email or password' });
  });

  test('the domain match is case- and whitespace-insensitive: an upper-case or padded smoke address is still read-only', async ({ request }) => {
    for (const email of [`SMOKE.${uid()}@HMS-SMOKE.INVALID`, `  smoke.${uid()}@hms-smoke.invalid  `, `Smoke+Tag.${uid()}@Hms-Smoke.Invalid`]) {
      const res = await rawStatus(request, 'PATCH', `/api/roles/R-NOPE-${uid()}`, { headers: bearer(email, 'hr_recruiter'), data: { title: 'x' } });
      expect(res.status, JSON.stringify(email)).toBe(403);
      expect(res.body).toEqual(READ_ONLY);
    }
  });

  test('only the exact smoke domain is read-only: look-alike addresses reach the route (control: an HR token gets the route\'s own 404)', async ({ request }) => {
    const control = await rawStatus(request, 'PATCH', `/api/roles/R-NOPE-${uid()}`, { headers: bearer(USERS.hr.email, 'hr_recruiter'), data: { title: 'x' } });
    expect(control.status).toBe(404);
    expect(control.body).toEqual({ error: 'Role not found' });

    const lookalikes = [
      `smoke@hms-smoke.invalid.example.com`,       // the smoke domain as a prefix of a real one
      `smoke@sub.hms-smoke.invalid`,               // a sub-domain is not the reserved domain
      `hms-smoke.invalid@digitalpaani.com`,        // the domain name only in the local part
      `smoke@hms-smoke.invalidx`,
      `smoke@not-hms-smoke.invalid`,
    ];
    for (const email of lookalikes) {
      const res = await rawStatus(request, 'PATCH', `/api/roles/R-NOPE-${uid()}`, { headers: bearer(email, 'hr_recruiter'), data: { title: 'x' } });
      expect(res.status, email).toBe(404);
    }
  });
});

test.describe('smoke accounts are read-only (a real account signed in through /api/auth/login)', () => {
  const email = `smoke.guard+${uid()}@hms-smoke.invalid`;

  test.beforeAll(async () => {
    // Same bcrypt hash as the seeded users (password123): the only thing that makes this account special is its e-mail domain.
    await withDb(c => c.query(
      `INSERT INTO users (name, email, persona, password_hash) SELECT 'Smoke Guard Test', $1, 'leadership', password_hash FROM users WHERE email = $2`,
      [email, USERS.hr.email]));
  });
  test.afterAll(async () => {
    await withDb(c => c.query('DELETE FROM users WHERE email = $1', [email]));
  });

  test('signs in, reads (200), and every write is refused with 403 — the guard is on the real session, not only on forged tokens', async ({ request }) => {
    const login = await request.post(`${BASE}/api/auth/login`, { data: { email, password: USERS.hr.password } });
    expect(login.status()).toBe(200);
    const { token, user } = await login.json();
    expect(user).toMatchObject({ email, persona: 'leadership' });
    const headers = { Authorization: `Bearer ${token}` };

    for (const p of ['/api/auth/me', '/api/dashboard', '/api/roles', '/api/candidates?limit=1']) {
      expect((await rawStatus(request, 'GET', p, { headers })).status, `GET ${p}`).toBe(200);
    }
    const marker = uid();
    for (const [method, path, data] of writes(marker)) {
      const res = await rawStatus(request, method, path, { headers, data });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toEqual(READ_ONLY);
    }
    // A normal HR user is NOT subject to it (control: the same kind of request is allowed through to the route).
    const hr = await getSession(request, 'hr');
    const ok = await rawStatus(request, 'PATCH', `/api/roles/R-NOPE-${marker}`, { headers: { Authorization: `Bearer ${hr.token}` }, data: { title: 'x' } });
    expect(ok.status).toBe(404);
  });
});

test.describe('smoke accounts are read-only (the configured SMOKE_* credentials)', () => {

  test('when SMOKE_LEADERSHIP_* and SMOKE_HM_* exist in this database, both are read-only on a real login', async ({ request }) => {
    test.skip(!SMOKE_USERS.smoke_lead.email || !SMOKE_USERS.smoke_hm.email, 'SMOKE_* credentials are not configured (hms-tests-final/.env.smoke.local)');
    for (const account of [SMOKE_USERS.smoke_lead, SMOKE_USERS.smoke_hm]) {
      const login = await request.post(`${BASE}/api/auth/login`, { data: { email: account.email, password: account.password } });
      test.skip(login.status() !== 200, `${account.email} does not exist in this database (node scripts/smoke-accounts.mjs creates it)`);
      const { token } = await login.json();
      const headers = { Authorization: `Bearer ${token}` };
      expect((await rawStatus(request, 'GET', '/api/roles', { headers })).status).toBe(200);
      const res = await rawStatus(request, 'PATCH', `/api/roles/R-NOPE-${uid()}`, { headers, data: { title: 'x' } });
      expect(res.status, account.email).toBe(403);
      expect(res.body).toEqual(READ_ONLY);
    }
  });
});
