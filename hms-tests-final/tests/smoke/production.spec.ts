/**
 * Production smoke tests — safe to run against the live Vercel deployment.
 *
 * Run locally:   npm run test:smoke
 * Run against production:   npm run test:prod
 *
 * These tests:
 * - Sign in as the two dedicated READ-ONLY smoke accounts (leadership + hiring_manager, on the reserved domain
 *   hms-smoke.invalid; credentials in .env.smoke.local — see helpers/smoke-env.ts and the README). Production accounts are
 *   Google-only, so the seeded users cannot sign in there. The backend itself refuses every non-GET request from these accounts.
 * - Only READ. They never create, change or delete anything, and they never print candidate data (assertions are on shape and
 *   status, traces/videos/screenshots are off for this project).
 * - Verify the critical path: health → auth → roles → dashboard → the main list endpoints, for both personas.
 */
import { test, expect } from '@playwright/test';
import { BASE, SMOKE_USERS, getToken, authed } from '../helpers/api';

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
    data: { email: SMOKE_USERS.smoke_lead.email, password: SMOKE_USERS.smoke_lead.password },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.token).toBeTruthy();
  expect(body.user.persona).toBe('leadership');
});

test('POST /api/auth/login — wrong password returns 401', async ({ request }) => {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email: SMOKE_USERS.smoke_lead.email, password: 'definitelyWrong999' },
  });
  expect(res.status()).toBe(401);
});

test('GET /api/auth/me — valid token returns user profile', async ({ request }) => {
  const token = await getToken(request, 'smoke_lead');
  const res   = await request.get(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.user.email).toBe(SMOKE_USERS.smoke_lead.email);
});

test('GET /api/auth/me — no token returns 401', async ({ request }) => {
  const res = await request.get(`${BASE}/api/auth/me`);
  expect(res.status()).toBe(401);
});

test('GET /api/roles — returns the roles (≥7)', async ({ request }) => {
  const token = await getToken(request, 'smoke_lead');
  const res   = await authed(request, token).get('/api/roles');
  expect(res.status()).toBe(200);
  const { roles } = await res.json();
  expect(roles.length).toBeGreaterThanOrEqual(7);
});

test('GET /api/roles — the Hiring Manager view never carries ctc_band for a role they do not own', async ({ request }) => {
  // The smoke Hiring Manager is named on no role, so compensation must be stripped from EVERY role it can read, while the
  // HR-tier smoke account still sees it. (Comp visibility is scoped to a role's own HM plus HR-tier.)
  const hm = await getToken(request, 'smoke_hm');
  const { roles } = await (await authed(request, hm).get('/api/roles')).json();
  expect(roles.length).toBeGreaterThanOrEqual(7);
  expect(roles.filter((r: { ctc_band?: unknown }) => r.ctc_band !== undefined)).toHaveLength(0);
  const lead = await getToken(request, 'smoke_lead');
  const all  = (await (await authed(request, lead).get('/api/roles')).json()).roles as Array<{ ctc_band?: unknown }>;
  expect(all.some(r => r.ctc_band !== undefined)).toBe(true);
});

test('GET /api/roles/:id — one role: HR-tier gets it, the Hiring Manager gets it without compensation, unknown id is 404', async ({ request }) => {
  const lead = await getToken(request, 'smoke_lead');
  const hm   = await getToken(request, 'smoke_hm');
  const { roles } = await (await authed(request, lead).get('/api/roles')).json();
  const id = roles[0].id as string;
  const a = await authed(request, lead).get(`/api/roles/${id}`);
  expect(a.status()).toBe(200);
  expect((await a.json()).role.id).toBe(id);
  const b = await authed(request, hm).get(`/api/roles/${id}`);
  expect(b.status()).toBe(200);
  expect((await b.json()).role.ctc_band).toBeUndefined();
  expect((await authed(request, lead).get('/api/roles/R-does-not-exist')).status()).toBe(404);
});

test('GET /api/dashboard — returns expected metric keys', async ({ request }) => {
  const token = await getToken(request, 'smoke_lead');
  const res   = await authed(request, token).get('/api/dashboard');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.metrics).toHaveProperty('open_roles_count');
  expect(body.metrics).toHaveProperty('sla_breach_total');
  expect(body.metrics).toHaveProperty('sla_breach_by_owner');
  expect(body).toHaveProperty('hiring_funnel');
  expect(body).toHaveProperty('hiring_funnel_snapshot');
  expect(body).toHaveProperty('aging_roles');
});

test('GET /api/agencies — HR can access, HM cannot', async ({ request }) => {
  const hrToken = await getToken(request, 'smoke_lead');
  const hmToken = await getToken(request, 'smoke_hm');
  expect((await authed(request, hrToken).get('/api/agencies')).status()).toBe(200);
  expect((await authed(request, hmToken).get('/api/agencies')).status()).toBe(403);
});

test('GET /api/eval-questions — returns seeded questions', async ({ request }) => {
  const token = await getToken(request, 'smoke_lead');
  const { questions } = await (await authed(request, token).get('/api/eval-questions')).json();
  expect(questions.length).toBeGreaterThanOrEqual(13);
});

test('GET /api/comp-benchmarks — HR sees data, HM blocked', async ({ request }) => {
  const hrToken = await getToken(request, 'smoke_lead');
  const hmToken = await getToken(request, 'smoke_hm');
  expect((await authed(request, hrToken).get('/api/comp-benchmarks')).status()).toBe(200);
  expect((await authed(request, hmToken).get('/api/comp-benchmarks')).status()).toBe(403);
});

// ─── The main list and dashboard endpoints, both personas ─────────────────────
// Status and shape only — never the content, which is real candidate data.
for (const [who, key] of [['HR-tier (leadership)', 'smoke_lead'], ['Hiring Manager', 'smoke_hm']] as const) {
  test(`${who} — the main read endpoints answer 200 with the expected shape`, async ({ request }) => {
    const token = await getToken(request, key);
    const get = (p: string) => authed(request, token).get(p);
    const json = async (p: string) => { const r = await get(p); expect(r.status(), p).toBe(200); return r.json(); };

    expect(Array.isArray((await json('/api/candidates?limit=1')).candidates)).toBe(true);
    expect(Array.isArray((await json('/api/applications?limit=1')).applications)).toBe(true);
    expect(Array.isArray((await json('/api/dashboard/pending')).actions)).toBe(true);
    await json('/api/dashboard/funnel-snapshot');
    await json('/api/dashboard/sla-by-role');
    await json('/api/roles/filter-options');
  });
}

test('persona boundary — user management is Super-Admin only: 403 for both smoke accounts, 401 without a token', async ({ request }) => {
  for (const key of ['smoke_lead', 'smoke_hm'] as const) {
    expect((await authed(request, await getToken(request, key)).get('/api/users')).status(), key).toBe(403);
  }
  expect((await request.get(`${BASE}/api/users`)).status()).toBe(401);
});

test('GET /api/sourcing/status — answers for every signed-in user once the module is deployed (404 = backend not deployed with it yet)', async ({ request }) => {
  for (const key of ['smoke_lead', 'smoke_hm'] as const) {
    const res = await authed(request, await getToken(request, key)).get('/api/sourcing/status');
    if (res.status() === 404) { test.info().annotations.push({ type: 'note', description: 'sourcing routes are not deployed yet' }); return; }
    expect(res.status(), key).toBe(200);
    expect(typeof (await res.json()).enabled).toBe('boolean');
  }
});
