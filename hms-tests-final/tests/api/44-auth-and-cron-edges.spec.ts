// ─────────────────────────────────────────────────────────────────────────────
// Auth edge routes, the JWT gate and the cron secret gate.
//   routes/auth.ts (POST /login edges, POST /google, POST /logout), middleware/auth.ts authenticate(), routes/cron.ts verifyCron(),
//   server.ts (CORS lock, helmet, every router behind authenticate).
//
// Until now POST /auth/google, POST /auth/logout and the cron secret checks had only Vitest or no coverage, and no spec asserted that an
// expired, forged or tampered token is refused. Forged tokens are minted with node:crypto and the stack's public dev JWT secret
// (helpers/api-specs.ts); the first test is a POSITIVE CONTROL that proves the forging works, because every "refused" test below would
// otherwise pass vacuously against a backend that simply uses another secret.
//
// POST /api/cron/email-digest is NEVER called with the valid secret: it sends mail.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, CRON_SECRET, FRONTEND_BASE, USERS, authed, getSession, getToken, uid } from '../helpers/api';
import { DEV_JWT_SECRET, decodeJwtPayload, forgeToken, rawStatus, signJwt, unsignedToken, withTamperedPayload } from '../helpers/api-specs';
import { withDb } from '../helpers/db';

const HR = { email: USERS.hr.email, persona: 'hr_recruiter' as const, name: 'Aaron Newton' };

test.describe('the JWT gate (authenticate middleware)', () => {

  test('POSITIVE CONTROL: a token forged with the dev secret is accepted — so the refusals below are real', async ({ request }) => {
    const token = forgeToken(HR);
    const res = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status, `the backend must verify tokens with ${process.env.TEST_JWT_SECRET ? 'TEST_JWT_SECRET' : 'the dev JWT secret'}`).toBe(200);
    expect(res.body.user).toMatchObject({ email: HR.email, persona: 'hr_recruiter' });
  });

  test('a token signed with a different secret is refused: 401 "Invalid or expired token"', async ({ request }) => {
    const token = forgeToken(HR, { secret: `${DEV_JWT_SECRET}-not-the-secret` });
    const res = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  test('an expired token is refused (exp 10 seconds in the past, correct signature)', async ({ request }) => {
    const now = Math.floor(Date.now() / 1000);
    const token = forgeToken(HR, { iat: now - 3600, expiresInSec: 3600 - 10 });
    const res = await rawStatus(request, 'GET', '/api/roles', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  test('a token that is not valid yet (nbf in the future, correct signature) is refused', async ({ request }) => {
    const token = signJwt({ userId: 'u', email: HR.email, persona: HR.persona, name: HR.name, nbf: Math.floor(Date.now() / 1000) + 3600 });
    const res = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  test('an unsigned token (alg none, empty signature) is refused', async ({ request }) => {
    const token = unsignedToken({ userId: 'u', email: HR.email, persona: 'super_admin', name: HR.name, exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await rawStatus(request, 'GET', '/api/users', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  test('a real token whose payload was edited to claim super_admin keeps its old signature and is refused', async ({ request }) => {
    const real = await getToken(request, 'hr');
    const ok = await rawStatus(request, 'GET', '/api/users', { headers: { Authorization: `Bearer ${real}` } });
    expect(ok.status, 'control: the untouched HR token is not a super_admin').toBe(403);

    const tampered = withTamperedPayload(real, { persona: 'super_admin' });
    expect(decodeJwtPayload(tampered).persona).toBe('super_admin');
    const res = await rawStatus(request, 'GET', '/api/users', { headers: { Authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  test('a truncated, re-ordered or empty-segment token is refused', async ({ request }) => {
    const real = await getToken(request, 'hr');
    const [head, body, sig] = real.split('.');
    for (const bad of [`${head}.${body}`, `${body}.${head}.${sig}`, `${head}..${sig}`, real.slice(0, -4)]) {
      const res = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${bad}` } });
      expect(res.status, bad.slice(0, 24)).toBe(401);
    }
  });

  test('anything but "Bearer <token>" in Authorization is "No token provided" (Basic, bare Bearer, lower-case, empty token)', async ({ request }) => {
    const valid = forgeToken(HR);
    for (const header of [`Basic ${valid}`, 'Bearer', 'Bearer ', `bearer ${valid}`, valid]) {
      const res = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: header } });
      expect(res.status, JSON.stringify(header.slice(0, 20))).toBe(401);
      expect(res.body).toEqual({ error: 'No token provided' });
    }
  });

  test('every mounted API router refuses an anonymous request with 401 (nothing is open by accident)', async ({ request }) => {
    const paths = [
      '/api/roles', '/api/candidates', '/api/applications', '/api/interviews?application_id=A0001', '/api/dashboard', '/api/dashboard/pending',
      '/api/agencies', '/api/assignment-repo', '/api/ref-checks?application_id=A0001', '/api/eval-questions', '/api/comp-benchmarks',
      '/api/users', '/api/sourcing/status', '/api/auth/me',
    ];
    for (const p of paths) {
      const res = await rawStatus(request, 'GET', p);
      expect(res.status, `GET ${p} without a token`).toBe(401);
    }
  });

  test('the JWT carries exactly userId, email, persona and name (the HMS name, not a profile name) and lives 24 hours', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email, password: USERS.hr.password } });
    expect(res.status()).toBe(200);
    const { token, user } = await res.json();
    const payload = decodeJwtPayload(token);
    expect(Object.keys(payload).sort()).toEqual(['email', 'exp', 'iat', 'name', 'persona', 'userId']);
    expect(payload).toMatchObject({ userId: user.id, email: USERS.hr.email, persona: 'hr_recruiter', name: 'Aaron Newton' });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(24 * 3600);
  });
});

test.describe('POST /api/auth/login — edges', () => {

  test('an unknown e-mail and a wrong password answer identically (401, same body): no account enumeration', async ({ request }) => {
    const unknown = await request.post(`${BASE}/api/auth/login`, { data: { email: `nobody+${uid()}@digitalpaani.com`, password: 'password123' } });
    const wrong = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email, password: 'definitely-wrong' } });
    expect(unknown.status()).toBe(401);
    expect(wrong.status()).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'Invalid email or password' });
    expect(await wrong.json()).toEqual({ error: 'Invalid email or password' });
  });

  test('the e-mail is case-insensitive and the response carries the stored lower-case address and no password hash', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email.toUpperCase(), password: USERS.hr.password } });
    expect(res.status()).toBe(200);
    const { user } = await res.json();
    expect(user.email).toBe(USERS.hr.email);
    expect(JSON.stringify(user)).not.toMatch(/password|hash/i);
  });

  test('a Google-only account (no password) is told to use Google sign-in: 400, never a token', async ({ request }) => {
    const email = `google.only+${uid()}@digitalpaani.com`;
    await withDb(c => c.query(`INSERT INTO users (name, email, persona, auth_provider) VALUES ($1, $2, 'hiring_manager', 'google')`, ['Google Only Test', email]));
    try {
      const res = await request.post(`${BASE}/api/auth/login`, { data: { email, password: 'password123' } });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Google sign-in');
      expect(body.token).toBeUndefined();
    } finally {
      await withDb(c => c.query('DELETE FROM users WHERE email = $1', [email]));
    }
  });

  test('a deactivated account cannot sign in: 401 with the same message as an unknown e-mail', async ({ request }) => {
    const email = `inactive+${uid()}@digitalpaani.com`;
    // Clone the seeded password hash (password123) so the ONLY thing that differs from a working account is is_active.
    await withDb(c => c.query(
      `INSERT INTO users (name, email, persona, password_hash, is_active)
       SELECT 'Inactive Test', $1, 'hiring_manager', password_hash, false FROM users WHERE email = $2`, [email, USERS.hr.email]));
    try {
      const res = await request.post(`${BASE}/api/auth/login`, { data: { email, password: USERS.hr.password } });
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    } finally {
      await withDb(c => c.query('DELETE FROM users WHERE email = $1', [email]));
    }
  });
});

test.describe('POST /api/auth/google', () => {

  test('a missing or empty credential is 400 "credential required"', async ({ request }) => {
    for (const data of [{}, { credential: '' }, { credential: null }]) {
      const res = await request.post(`${BASE}/api/auth/google`, { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect(await res.json()).toEqual({ error: 'credential required' });
    }
  });

  test('a garbage credential never yields a token: 401 when Google OAuth is configured, 500 "not configured" when it is not', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/google`, { data: { credential: `not-a-google-id-token-${uid()}` } });
    const body = await res.json();
    expect(body.token).toBeUndefined();
    // GOOGLE_CLIENT_ID unset (the isolated stack, and any dev machine without OAuth): the route stops before talking to Google.
    // Set: Google's verifier rejects the string. Either way the pair status+message must agree, and nothing else is acceptable.
    if (res.status() === 500) expect(body).toEqual({ error: 'Google OAuth is not configured on this server' });
    else {
      expect(res.status()).toBe(401);
      expect(body).toEqual({ error: 'Invalid Google credential' });
    }
  });
});

test.describe('POST /api/auth/logout', () => {

  test('is public and answers 200 { message: "Logged out" } with or without a token', async ({ request }) => {
    const anon = await rawStatus(request, 'POST', '/api/auth/logout');
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ message: 'Logged out' });
    const withToken = await rawStatus(request, 'POST', '/api/auth/logout', { headers: { Authorization: `Bearer ${await getToken(request, 'hr')}` } });
    expect(withToken.status).toBe(200);
    expect(withToken.body).toEqual({ message: 'Logged out' });
  });

  test('TODAY: logout is stateless — the same token still works afterwards (it can only be discarded client-side, until it expires)', async ({ request }) => {
    const token = forgeToken(HR);
    const before = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);
    await rawStatus(request, 'POST', '/api/auth/logout', { headers: { Authorization: `Bearer ${token}` } });
    const after = await rawStatus(request, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(after.status).toBe(200);
  });
});

test.describe('cron routes — the CRON_SECRET gate', () => {
  // [method, path] pairs that exist. email-digest is only ever called WITHOUT the right secret.
  const GATED: Array<['POST' | 'GET', string]> = [
    ['POST', '/api/cron/sla-check'], ['POST', '/api/cron/email-digest'], ['POST', '/api/cron/sourcing-check'], ['GET', '/api/cron/sourcing-check'],
  ];

  test('POSITIVE CONTROL: the right secret opens the gate (sla-check answers 200 { ok: true })', async ({ request }) => {
    const res = await rawStatus(request, 'POST', '/api/cron/sla-check', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  for (const [method, p] of GATED) {
    test(`${method} ${p}: no secret, a wrong secret, a bare secret, a lower-case scheme and an HMS user token are all 401 "Unauthorized"`, async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const attempts: Array<[string, Record<string, string>]> = [
        ['no header', {}],
        ['wrong secret', { Authorization: 'Bearer definitely-not-the-cron-secret' }],
        ['secret without the Bearer scheme', { Authorization: CRON_SECRET }],
        ['lower-case bearer scheme', { Authorization: `bearer ${CRON_SECRET}` }],
        ['an HR user JWT', { Authorization: `Bearer ${hrToken}` }],
        ['the secret in x-ingest-secret', { 'x-ingest-secret': CRON_SECRET }],
      ];
      for (const [label, headers] of attempts) {
        const res = await rawStatus(request, method, p, { headers });
        expect(res.status, `${method} ${p} (${label})`).toBe(401);
        expect(res.body, label).toEqual({ error: 'Unauthorized' });
      }
    });
  }

  test('sla-check and email-digest are POST-only: a GET is Express\'s 404, even with the right secret (nothing runs)', async ({ request }) => {
    for (const p of ['/api/cron/sla-check', '/api/cron/email-digest']) {
      for (const headers of [{}, { Authorization: `Bearer ${CRON_SECRET}` }]) {
        const res = await rawStatus(request, 'GET', p, { headers });
        expect(res.status, `GET ${p}`).toBe(404);
      }
    }
  });

  test('TODAY: Vercel Cron issues GET, and one of the two scheduled paths answers 404, so the daily e-mail digest never fires', async ({ request }) => {
    // backend/vercel.json "crons". Vercel Cron calls each path with GET. sourcing-check accepts GET (401 without the secret = the
    // route exists and is gated); email-digest is registered with router.post only. Fixing the route (add router.get) flips this test.
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), '..', 'backend', 'vercel.json'), 'utf8'));
    const cronPaths: string[] = vercel.crons.map((c: { path: string }) => c.path);
    expect(cronPaths.sort()).toEqual(['/api/cron/email-digest', '/api/cron/sourcing-check']);

    const unreachableByGet: string[] = [];
    for (const p of cronPaths) {
      const res = await rawStatus(request, 'GET', p);
      if (res.status === 404) unreachableByGet.push(p);
      else expect(res.status, `GET ${p} should at least be gated`).toBe(401);
    }
    expect(unreachableByGet).toEqual(['/api/cron/email-digest']);
  });
});

test.describe('server-level protections (CORS lock, helmet)', () => {

  test('CORS allows only the configured frontend origin: a foreign origin gets no Access-Control-Allow-Origin', async ({ request }) => {
    const own = await rawStatus(request, 'GET', '/health', { headers: { Origin: FRONTEND_BASE } });
    expect(own.headers['access-control-allow-origin']).toBe(FRONTEND_BASE);
    expect(own.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await rawStatus(request, 'GET', '/health', { headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers['access-control-allow-origin']).not.toBe('*');
    expect(foreign.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  test('helmet is on: nosniff is set and the framework is not advertised', async ({ request }) => {
    const res = await rawStatus(request, 'GET', '/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
