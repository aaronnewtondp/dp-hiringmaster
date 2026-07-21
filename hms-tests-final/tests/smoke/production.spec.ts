/**
 * Production smoke tests — safe to run against the live Vercel deployment.
 *
 * Run locally:   npm run test:smoke
 * Run against production:   npm run test:prod
 *
 * These tests:
 * - Use minimal auth requests (rely on global-setup token cache)
 * - Do NOT write or delete data
 * - Verify the critical path: health → auth → roles → dashboard
 */
import { test, expect } from '@playwright/test';
import { BASE, USERS, getToken, authed } from '../helpers/api';

// ─── Phase 3/4 ingestion webhooks — auth-rejection paths ONLY ─────────────────
// These routes have no JWT/authenticate middleware (Apps Script can't hold a
// user session) and are guarded solely by a shared secret — perfect smoke
// candidates since a wrong/missing secret is guaranteed to 401 without ever
// touching the database, safe to run against production on every check.
test('POST /api/roles/ingest — wrong secret returns 401 (never reaches the DB)', async ({ request }) => {
  const res = await request.post(`${BASE}/api/roles/ingest`, {
    headers: { 'x-ingest-secret': 'definitely-not-the-real-secret' },
    data: { job_title: 'Smoke Test Role — should never be created' },
  });
  expect(res.status()).toBe(401);
});

test('POST /api/roles/ingest — missing secret header returns 401', async ({ request }) => {
  const res = await request.post(`${BASE}/api/roles/ingest`, {
    data: { job_title: 'Smoke Test Role — should never be created' },
  });
  expect(res.status()).toBe(401);
});

test('POST /api/candidates/ingest — wrong secret returns 401 (never reaches the DB)', async ({ request }) => {
  const res = await request.post(`${BASE}/api/candidates/ingest`, {
    headers: { 'x-ingest-secret': 'definitely-not-the-real-secret' },
    data: { email: 'smoke-test@example.com', full_name: 'Smoke Test — should never be created' },
  });
  expect(res.status()).toBe(401);
});

test('POST /api/candidates/ingest — missing secret header returns 401', async ({ request }) => {
  const res = await request.post(`${BASE}/api/candidates/ingest`, {
    data: { email: 'smoke-test@example.com', full_name: 'Smoke Test — should never be created' },
  });
  expect(res.status()).toBe(401);
});

// ─── Phase 4 candidate-role linking — auth-rejection path only ───────────────
// authenticate() runs before the route handler, so a request with no token
// 401s before any candidate/role lookup — safe against production regardless
// of what real IDs currently exist.
test('POST /api/candidates/:id/applications — no token returns 401 (never reaches the DB)', async ({ request }) => {
  const res = await request.post(`${BASE}/api/candidates/C0001/applications`, {
    data: { role_id: 'R001' },
  });
  expect(res.status()).toBe(401);
});

test('GET /health — server is running', async ({ request }) => {
  const res  = await request.get(`${BASE}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('POST /api/auth/login — valid credentials return token', async ({ request }) => {
  const res  = await request.post(`${BASE}/api/auth/login`, {
    data: { email: USERS.hr.email, password: 'password123' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.token).toBeTruthy();
  expect(body.user.persona).toBe(USERS.hr.persona);
});

test('POST /api/auth/login — wrong password returns 401', async ({ request }) => {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email: USERS.hr.email, password: 'definitelyWrong999' },
  });
  expect(res.status()).toBe(401);
});

test('GET /api/auth/me — valid token returns user profile', async ({ request }) => {
  const token = await getToken(request, 'hr');
  const res   = await request.get(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.user.email).toBe(USERS.hr.email);
});

test('GET /api/auth/me — no token returns 401', async ({ request }) => {
  const res = await request.get(`${BASE}/api/auth/me`);
  expect(res.status()).toBe(401);
});

test('GET /api/roles — returns seeded roles (≥7)', async ({ request }) => {
  const token = await getToken(request, 'hr');
  const res   = await authed(request, token).get('/api/roles');
  expect(res.status()).toBe(200);
  const { roles } = await res.json();
  expect(roles.length).toBeGreaterThanOrEqual(7);
});

test('GET /api/roles — HM response strips ctc_band', async ({ request }) => {
  const token = await getToken(request, 'hm_alex');
  const { roles } = await (await authed(request, token).get('/api/roles')).json();
  for (const r of roles) expect(r.ctc_band).toBeUndefined();
});

test('GET /api/dashboard — returns expected metric keys', async ({ request }) => {
  const token = await getToken(request, 'hr');
  const res   = await authed(request, token).get('/api/dashboard');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.metrics).toHaveProperty('open_roles_count');
  expect(body).toHaveProperty('hiring_funnel');
  expect(body).toHaveProperty('aging_roles');
  expect(body).toHaveProperty('pending_actions_by_owner');
});

test('GET /api/agencies — HR can access, HM cannot', async ({ request }) => {
  const hrToken = await getToken(request, 'hr');
  const hmToken = await getToken(request, 'hm_alex');
  expect((await authed(request, hrToken).get('/api/agencies')).status()).toBe(200);
  expect((await authed(request, hmToken).get('/api/agencies')).status()).toBe(403);
});

test('GET /api/eval-questions — returns seeded questions', async ({ request }) => {
  const token = await getToken(request, 'hr');
  const { questions } = await (await authed(request, token).get('/api/eval-questions')).json();
  expect(questions.length).toBeGreaterThanOrEqual(13);
});

test('GET /api/comp-benchmarks — HR sees data, HM blocked', async ({ request }) => {
  const hrToken = await getToken(request, 'hr');
  const hmToken = await getToken(request, 'hm_alex');
  expect((await authed(request, hrToken).get('/api/comp-benchmarks')).status()).toBe(200);
  expect((await authed(request, hmToken).get('/api/comp-benchmarks')).status()).toBe(403);
});
