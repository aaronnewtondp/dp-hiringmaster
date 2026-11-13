import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The authentication matrix: EVERY route of the real Express app (server.ts), who may call it, and what each kind of
// caller gets. Real routers, real authenticate / require* middleware, real JWTs; only the database and the outside world
// are replaced (src/test/fakeDb.ts, src/test/externalMocks.ts).
//
// GATES below is the explicit allow-list. It is the whole point of the file:
//   * the table must equal the app's route table, so a NEW route fails "the route table is exactly the documented one"
//     until someone writes down who may call it (and a removed route fails it too, so the table cannot go stale);
//   * every route that is not on the public / secret-header list must answer an anonymous request with 401 — so a new
//     route that forgot `authenticate`, or a router mounted ahead of the one that carries it, fails here;
//   * an HR-only route must refuse a hiring_manager with 403 BEFORE it touches the database, and /api/users must refuse
//     everyone but super_admin.
// Persona rules that live inside a handler (stage / status / screening, role approval, interview feedback) are 'handler'
// here — this file only proves that every persona is authenticated there — and are pinned in their own files
// (routes/applications.access.test.ts, routes/roles.patch.test.ts, routes/interviews.feedback.test.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// server.ts reads process.env.VERCEL at import to decide whether to listen; and it imports dotenv/config, which would load a
// developer's real backend/.env (secrets!) into the test process. Both are neutralised before anything is imported.
vi.hoisted(() => { process.env.VERCEL = '1'; process.env.NODE_ENV = 'test'; });
vi.mock('dotenv/config', () => ({}));
vi.mock('./db/index.js', async () => (await import('./test/fakeDb.js')).dbModule());
vi.mock('@anthropic-ai/sdk', async () => (await import('./test/externalMocks.js')).anthropicSdk());
vi.mock('googleapis', async () => (await import('./test/externalMocks.js')).googleapis());
vi.mock('@vercel/queue', async () => (await import('./test/externalMocks.js')).vercelQueue());
// The two sweeps a dashboard load / cron call would run for real; what they do is not under test here.
vi.mock('./jobs/slaChecker.js', async (orig) => ({ ...(await orig<typeof import('./jobs/slaChecker.js')>()), runSlaCheck: vi.fn(async () => undefined), sendDailyDigest: vi.fn(async () => undefined) }));
vi.mock('./jobs/sourcingChecker.js', async (orig) => ({ ...(await orig<typeof import('./jobs/sourcingChecker.js')>()), maybeRunSourcingCheck: vi.fn(async () => undefined), runSourcingCheck: vi.fn(async () => ({})) }));

import app from './server.js';
import { fakeDb } from './test/fakeDb.js';
import {
  ALL_PERSONAS, ApiClient, SMOKE_USER, TEST_JWT_SECRET, TEST_USERS, concretePath, listMiddleware, listRoutes, setEnv, signToken,
} from './test/routeHarness.js';

// ─── the documented outcome of every route ──────────────────────────────────────────────────────────────────────
type Gate =
  | 'public'    // no credentials needed (and none looked at)
  | 'ingest'    // a shared secret in x-ingest-secret instead of a JWT (SECRET_ROUTES says which)
  | 'cron'      // `Authorization: Bearer <CRON_SECRET>` instead of a JWT
  | 'any'       // any signed-in persona
  | 'hr'        // requireHR: hr_recruiter, leadership, super_admin; a hiring_manager gets 403 "HR access required"
  | 'super'     // requireSuperAdmin: super_admin only
  | 'settings'  // requireHR, then the handler also refuses hr_recruiter (leadership / super_admin may change sourcing settings)
  | 'handler';  // any signed-in persona gets in; the handler applies its own persona rules (pinned in other files)

const GATES: Record<string, Gate> = {
  'GET /health': 'public',
  'POST /api/auth/login': 'public',
  'POST /api/auth/google': 'public',
  'POST /api/auth/logout': 'public',
  'GET /api/auth/me': 'any',

  'POST /api/roles/ingest': 'ingest',
  'POST /api/candidates/ingest': 'ingest',
  'POST /api/applications/portfolio-backfill': 'ingest',

  'POST /api/cron/sla-check': 'cron',
  'POST /api/cron/email-digest': 'cron',
  'GET /api/cron/sourcing-check': 'cron',
  'POST /api/cron/sourcing-check': 'cron',

  'GET /api/roles': 'any',
  'GET /api/roles/filter-options': 'any',
  'GET /api/roles/:id': 'any',
  'POST /api/roles': 'handler',                       // HR-tier creates, a hiring_manager requests (a Draft); see roles.patch.test.ts
  'DELETE /api/roles/:id': 'hr',
  'POST /api/roles/:id/regenerate-jd': 'hr',
  'PATCH /api/roles/:id': 'handler',                  // HR-tier only, decided in the handler after the role is found
  'GET /api/roles/:id/edit-log': 'any',
  'GET /api/roles/:id/activity': 'any',
  'GET /api/roles/:id/pipeline': 'any',
  'GET /api/roles/:id/comp-benchmark': 'hr',
  'GET /api/roles/:id/closure-summary.pdf': 'any',

  'GET /api/candidates': 'any',
  'GET /api/candidates/unmatched': 'hr',
  'GET /api/candidates/:id': 'any',
  'POST /api/candidates': 'hr',
  'POST /api/candidates/:id/applications': 'hr',
  'PATCH /api/candidates/:id': 'hr',
  'DELETE /api/candidates/:id': 'hr',
  'GET /api/candidates/:id/edit-log': 'any',
  'GET /api/candidates/:id/activity': 'any',

  'GET /api/applications': 'any',
  'GET /api/applications/:id': 'any',
  'GET /api/applications/:id/portfolio-analysis': 'any',
  'POST /api/applications/:id/portfolio-analysis': 'hr',
  'POST /api/applications/:id/stage': 'handler',      // shortlisting is open to every persona, every other move is HR-tier
  'POST /api/applications/:id/status': 'handler',
  'POST /api/applications/:id/screening': 'handler',
  'PATCH /api/applications/:id/notes': 'hr',
  'POST /api/applications/:id/founder-flag': 'handler', // HR-tier only, decided in the handler
  'POST /api/applications/:id/retry-scoring': 'hr',

  'GET /api/interviews': 'any',
  'POST /api/interviews': 'hr',
  'PATCH /api/interviews/:id/feedback': 'handler',    // a listed interviewer (or anyone, on a round with none listed), or HR-tier
  'POST /api/interviews/:id/assignment-send': 'hr',
  'POST /api/interviews/:id/assignment-submit': 'hr',

  'GET /api/dashboard': 'any',
  'GET /api/dashboard/funnel-snapshot': 'any',
  'GET /api/dashboard/sla-by-role': 'any',
  'GET /api/dashboard/sourcing': 'any',
  'GET /api/dashboard/pending': 'any',

  'GET /api/agencies': 'hr',
  'GET /api/agencies/:id': 'hr',
  'POST /api/agencies': 'hr',
  'PATCH /api/agencies/:id': 'hr',
  'GET /api/agencies/:id/edit-log': 'hr',

  'GET /api/assignment-repo': 'any',
  'GET /api/assignment-repo/:id': 'any',
  'POST /api/assignment-repo': 'hr',
  'PATCH /api/assignment-repo/:id': 'hr',

  'GET /api/ref-checks': 'any',
  'POST /api/ref-checks': 'hr',
  'PATCH /api/ref-checks/:id': 'hr',

  'GET /api/eval-questions': 'any',
  'POST /api/eval-questions': 'hr',
  'GET /api/comp-benchmarks': 'hr',
  'PATCH /api/comp-benchmarks/:id': 'hr',

  'GET /api/users': 'super',
  'POST /api/users': 'super',
  'PATCH /api/users/:id': 'super',

  'GET /api/sourcing/status': 'any',
  'GET /api/sourcing/settings': 'hr',
  'PUT /api/sourcing/settings': 'settings',
  'GET /api/sourcing/people': 'hr',
  'GET /api/sourcing/workspace': 'handler',           // HR-tier sees every plan, a hiring_manager only their own roles
  'GET /api/sourcing/plans/:roleId': 'handler',       // HR-tier, or the role's own hiring_manager (redacted)
  'GET /api/sourcing/plans/:roleId/advice': 'hr',
  'POST /api/sourcing/plans/:planId/activate': 'hr',
  'PATCH /api/sourcing/plans/:planId': 'hr',
  'PUT /api/sourcing/plans/:planId/channel': 'hr',
  'POST /api/sourcing/plans/:planId/channel/close': 'hr',
  'POST /api/sourcing/plans/:planId/channel/reopen': 'hr',
  'PATCH /api/sourcing/plans/:planId/channel-settings': 'hr',
  'POST /api/sourcing/commitments/:id/complete': 'hr',
  'POST /api/sourcing/commitments/:id/skip': 'hr',
  'POST /api/sourcing/commitments/:id/reopen': 'hr',
  'POST /api/sourcing/exceptions/:id/resolve': 'hr',
  'GET /api/sourcing/queue': 'hr',
  // Plan detailing (routes/sourcingDetail.ts): everything HR-tier; templates, alert settings and deleting a company are also refused to hr_recruiter by their handlers.
  'GET /api/sourcing/templates': 'hr',
  'PUT /api/sourcing/templates/:key': 'settings',
  'GET /api/sourcing/plans/:roleId/detail': 'hr',
  'PATCH /api/sourcing/plans/:planId/detail': 'hr',
  'POST /api/sourcing/plans/:planId/template': 'hr',
  'POST /api/sourcing/plans/:planId/prefill': 'hr',
  'POST /api/sourcing/plans/:planId/checkin': 'hr',
  'POST /api/sourcing/outreach/upload': 'hr',
  'GET /api/sourcing/reminders': 'hr',
  'GET /api/sourcing/overview': 'hr',
  'GET /api/sourcing/detail-settings': 'hr',
  'PUT /api/sourcing/detail-settings': 'settings',
  'GET /api/sourcing/company-lists': 'hr',
  'GET /api/sourcing/companies': 'hr',
  'POST /api/sourcing/companies/import': 'hr',
  'GET /api/sourcing/companies/:id': 'hr',
  'POST /api/sourcing/companies': 'hr',
  'PATCH /api/sourcing/companies/:id': 'hr',
  'POST /api/sourcing/companies/:id/exclude': 'hr',
  'POST /api/sourcing/companies/:id/checked': 'hr',
  'DELETE /api/sourcing/companies/:id': 'settings',
};

/** What an anonymous, empty-bodied request to a PUBLIC route answers (nothing is looked at, so these are validation answers). */
const PUBLIC_ANONYMOUS_STATUS: Record<string, number> = {
  'GET /health': 200,
  'POST /api/auth/login': 400,     // "Email and password required"
  'POST /api/auth/google': 400,    // "credential required"
  'POST /api/auth/logout': 200,
};

/** The routes that take a shared secret instead of a JWT, which header it travels in, and what an empty body is told once past the gate. */
const SECRET_ROUTES: Record<string, { header: string; env: string; pastTheGate: string }> = {
  'POST /api/roles/ingest':                    { header: 'x-ingest-secret', env: 'ROLE_INGEST_SECRET',      pastTheGate: 'job_title is required' },
  'POST /api/candidates/ingest':               { header: 'x-ingest-secret', env: 'CANDIDATE_INGEST_SECRET', pastTheGate: 'email and full_name are required' },
  'POST /api/applications/portfolio-backfill': { header: 'x-ingest-secret', env: 'ROLE_INGEST_SECRET',      pastTheGate: 'role_id required' },
};

const SECRETS = { ROLE_INGEST_SECRET: 'role-ingest-test-secret', CANDIDATE_INGEST_SECRET: 'candidate-ingest-test-secret', CRON_SECRET: 'cron-test-secret' };

// ─── harness ─────────────────────────────────────────────────────────────────────────────────────────────────────
const api = new ApiClient(app);
let restoreEnv: () => void = () => undefined;

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, SOURCING_ENABLED: 'true', ...SECRETS });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);   // handlers log the failures a bare fake database causes
});
afterEach(() => { restoreEnv(); vi.restoreAllMocks(); });

const table = Object.entries(GATES).map(([key, gate]) => {
  const [method, ...rest] = key.split(' ');
  return { key, method, pattern: rest.join(' '), path: concretePath(rest.join(' ')), gate };
});
const withGate = (...gates: Gate[]) => table.filter(r => gates.includes(r.gate));
const protectedRoutes = table.filter(r => !['public', 'ingest', 'cron'].includes(r.gate));
const body = (method: string) => (method === 'GET' ? undefined : {});

// ─── 1. the table is the app ─────────────────────────────────────────────────────────────────────────────────────
describe('the route table is exactly the documented one', () => {
  it('every route the app answers is in GATES, and every GATES entry is a route the app answers', () => {
    const actual = listRoutes(app).map(r => `${r.method} ${r.path}`).sort();
    const documented = Object.keys(GATES).sort();
    const undocumented = actual.filter(k => !documented.includes(k));
    const stale = documented.filter(k => !actual.includes(k));
    // A new route lands in `undocumented`: decide who may call it, add it to GATES, and (unless it is public) give it authenticate.
    expect({ undocumented, stale }).toEqual({ undocumented: [], stale: [] });
    expect(actual).toHaveLength(111);   // 90 + the 21 plan-detailing routes
  });

  it('apart from routes and routers the app holds only the documented middleware, in this order — a plain app.use(path, handler) would answer outside the table above', () => {
    // body parsers / helmet / cors, then the two rate limiters (the second pair of '<anonymous>' at the end are the 404 and the error
    // handler). A new entry here means someone mounted a handler that listRoutes cannot enumerate: give it authenticate and a row in
    // GATES by making it a router, or write it down here on purpose.
    expect(listMiddleware(app)).toEqual([
      { path: '*', name: 'query' }, { path: '*', name: 'expressInit' }, { path: '*', name: 'helmetMiddleware' },
      { path: '*', name: 'corsMiddleware' }, { path: '*', name: 'jsonParser' },
      { path: '/api/auth', name: '<anonymous>' }, { path: '/api', name: '<anonymous>' },
      { path: '*', name: '<anonymous>' }, { path: '*', name: '<anonymous>' },
    ]);
  });

  it('no route is registered twice (a duplicate path would let a later, ungated handler shadow a gated one)', () => {
    const keys = listRoutes(app).map(r => `${r.method} ${r.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('every public / secret-header / cron route is one the tests below say something specific about', () => {
    expect(withGate('public').map(r => r.key).sort()).toEqual(Object.keys(PUBLIC_ANONYMOUS_STATUS).sort());
    expect(withGate('ingest').map(r => r.key).sort()).toEqual(Object.keys(SECRET_ROUTES).sort());
    expect(withGate('cron').map(r => r.key).sort()).toEqual([
      'GET /api/cron/sourcing-check', 'POST /api/cron/email-digest', 'POST /api/cron/sla-check', 'POST /api/cron/sourcing-check',
    ]);
  });
});

// ─── 2. anonymous callers ────────────────────────────────────────────────────────────────────────────────────────
describe('an anonymous request', () => {
  it.each(protectedRoutes.map(r => [r.key, r] as const))('%s → 401 "No token provided", before the database is touched', async (_key, r) => {
    const res = await api.request(r.method, r.path, { body: body(r.method) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'No token provided' });
    expect(fakeDb.untouched()).toBe(true);
  });

  it.each(withGate('public').map(r => [r.key, r] as const))('%s is public: it answers without credentials (and not with a 401)', async (_key, r) => {
    const res = await api.request(r.method, r.path, { body: body(r.method) });
    expect(res.status).toBe(PUBLIC_ANONYMOUS_STATUS[r.key]);
  });

  it('a path that is not a route is a 404 (nothing is served without credentials), and under an authenticated router it is a 401 first, so the router does not say which paths exist', async () => {
    for (const p of ['/api/does-not-exist', '/']) expect((await api.get(p)).status, p).toBe(404);
    expect((await api.get('/api/roles/9001/not-a-route')).status).toBe(401);
    expect((await api.get('/api/roles/9001/not-a-route', { as: 'super_admin' })).status).toBe(404);
  });
});

// ─── 3. credentials that are present but wrong ──────────────────────────────────────────────────────────────────
describe('a token that is not valid', () => {
  const sign = (opts: jwt.SignOptions, secret: string | Buffer = TEST_JWT_SECRET) => jwt.sign({ ...TEST_USERS.super_admin }, secret, opts);
  const variants: Array<[string, string]> = [
    ['garbage',                             'Bearer not-a-jwt'],
    ['expired',                             `Bearer ${sign({ expiresIn: -60 })}`],
    ['signed with another secret',          `Bearer ${sign({ expiresIn: '1h' }, 'some-other-secret')}`],
    ['unsigned (alg none)',                 `Bearer ${sign({ algorithm: 'none' }, '')}`],
    ['a tampered payload',                  (() => { const [h, , s] = sign({ expiresIn: '1h' }).split('.'); const p = Buffer.from(JSON.stringify({ ...TEST_USERS.hr_recruiter, persona: 'super_admin' })).toString('base64url'); return `Bearer ${h}.${p}.${s}`; })()],
  ];

  it.each(variants)('%s is refused with 401 on every protected route, before the database is touched', async (_name, authorization) => {
    const wrong: string[] = [];
    for (const r of protectedRoutes) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { authorization, body: body(r.method) });
      if (res.status !== 401 || !fakeDb.untouched()) wrong.push(`${r.key} → ${res.status}${fakeDb.untouched() ? '' : ' (touched the database)'}`);
    }
    expect(wrong).toEqual([]);
  });

  it('only the Bearer scheme is read: Basic, a bare token and a lower-case "bearer" are all "No token provided"', async () => {
    const t = signToken('super_admin');
    for (const authorization of [`Basic ${t}`, t, `bearer ${t}`, 'Bearer ']) {
      const res = await api.get('/api/users', { authorization });
      expect([authorization.slice(0, 8), res.status, res.body.error]).toEqual([authorization.slice(0, 8), 401, 'No token provided']);
    }
  });

  it('with JWT_SECRET missing from the server, even a well-formed token is refused (fails closed, never open)', async () => {
    const token = signToken('super_admin');
    restoreEnv();
    restoreEnv = setEnv({ JWT_SECRET: undefined });
    const res = await api.get('/api/users', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });
});

// ─── 4. who gets past each guard ─────────────────────────────────────────────────────────────────────────────────
describe('HR-only routes (requireHR)', () => {
  const hrRoutes = withGate('hr', 'settings');

  it.each(hrRoutes.map(r => [r.key, r] as const))('%s → 403 for a hiring_manager, before the database is touched', async (_key, r) => {
    const res = await api.request(r.method, r.path, { as: 'hiring_manager', body: body(r.method) });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'HR access required' });
    expect(fakeDb.untouched()).toBe(true);
  });

  it('hr_recruiter, leadership and super_admin all clear the guard of every one of them', async () => {
    const turnedAway: string[] = [];
    for (const persona of ['hr_recruiter', 'leadership', 'super_admin'] as const) {
      for (const r of hrRoutes) {
        fakeDb.reset();
        const res = await api.request(r.method, r.path, { as: persona, body: body(r.method) });
        // PUT /api/sourcing/settings is refused to hr_recruiter by its own handler (next test) — everything else must get in.
        if ((res.status === 401 || res.status === 403) && !(r.gate === 'settings' && persona === 'hr_recruiter')) turnedAway.push(`${persona} ${r.key} → ${res.status} ${res.body?.error}`);
      }
    }
    expect(turnedAway).toEqual([]);
  });

  it('sourcing settings can be READ by HR-tier but WRITTEN only by leadership and super_admin (an hr_recruiter is stopped by the handler)', async () => {
    const put = (as: (typeof ALL_PERSONAS)[number]) => api.put('/api/sourcing/settings', { as, body: {} });
    expect((await put('hr_recruiter')).status).toBe(403);
    expect((await put('hr_recruiter')).body.error).toMatch(/Only Leadership or the Super Admin/);
    expect((await put('hiring_manager')).body).toEqual({ error: 'HR access required' });
    expect((await put('leadership')).status).toBe(200);
    expect((await put('super_admin')).status).toBe(200);
    expect((await api.get('/api/sourcing/settings', { as: 'hr_recruiter' })).status).toBe(200);
  });
});

describe('/api/users (requireSuperAdmin on the whole router)', () => {
  const userRoutes = withGate('super');

  it.each(userRoutes.map(r => [r.key, r] as const))('%s → 403 for hr_recruiter, hiring_manager and leadership, before the database is touched', async (_key, r) => {
    for (const persona of ['hr_recruiter', 'hiring_manager', 'leadership'] as const) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { as: persona, body: body(r.method) });
      expect([persona, res.status, res.body]).toEqual([persona, 403, { error: 'Super-Admin access required' }]);
      expect(fakeDb.untouched(), persona).toBe(true);
    }
  });

  it.each(userRoutes.map(r => [r.key, r] as const))('%s is open to super_admin (past the guard)', async (_key, r) => {
    const res = await api.request(r.method, r.path, { as: 'super_admin', body: body(r.method) });
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('a token whose persona is not one of the four (the retired "interviewer", or a made-up one)', () => {
  it('is authenticated but is never HR-tier: 403 on every HR-only and super-admin-only route, before the database', async () => {
    for (const persona of ['interviewer', 'admin', 'HR_RECRUITER', '']) {
      const token = jwt.sign({ userId: 'U9100', email: 'odd@example.test', name: 'Odd Persona', persona }, TEST_JWT_SECRET, { expiresIn: '1h' });
      for (const r of withGate('hr', 'settings', 'super')) {
        fakeDb.reset();
        const res = await api.request(r.method, r.path, { authorization: `Bearer ${token}`, body: body(r.method) });
        expect([`"${persona}"`, r.key, res.status]).toEqual([`"${persona}"`, r.key, 403]);
        expect(fakeDb.untouched()).toBe(true);
      }
    }
  });
});

describe('every other route authenticates every persona', () => {
  const open = withGate('any', 'handler');

  it.each(open.map(r => [r.key, r] as const))('%s: no persona is turned away at authentication, and none by an HR guard', async (_key, r) => {
    const refused: string[] = [];
    for (const persona of ALL_PERSONAS) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { as: persona, body: body(r.method) });
      if (res.status === 401) refused.push(`${persona} → 401`);
      // The routes marked 'any' have no persona rule at all: a 403 there means someone put a guard on a view every persona uses.
      // ('handler' routes decide in the handler, so their 403s are the handler's own and are pinned in the dedicated files.)
      if (r.gate === 'any' && res.status === 403) refused.push(`${persona} → 403 ${res.body?.error}`);
    }
    expect(refused).toEqual([]);
  });
});

// ─── 5. the read-only smoke-test accounts, on the real routes ────────────────────────────────────────────────────
describe('a production smoke-test account (…@hms-smoke.invalid) is read-only everywhere', () => {
  const writes = protectedRoutes.filter(r => r.method !== 'GET');
  const reads = protectedRoutes.filter(r => r.method === 'GET');

  it(`is refused on all ${writes.length} routes that can change data, with a 403 that says why, before the database`, async () => {
    const wrong: string[] = [];
    for (const r of writes) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { as: SMOKE_USER, body: {} });
      if (res.status !== 403 || res.body?.error !== 'Smoke-test accounts are read-only' || !fakeDb.untouched()) wrong.push(`${r.key} → ${res.status} ${res.body?.error}`);
    }
    expect(wrong).toEqual([]);
  });

  it(`is not stopped from reading: none of the ${reads.length} GET routes answers it with the read-only refusal or a 401`, async () => {
    const wrong: string[] = [];
    for (const r of reads) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { as: SMOKE_USER });
      if (res.status === 401 || res.body?.error === 'Smoke-test accounts are read-only') wrong.push(`${r.key} → ${res.status} ${res.body?.error}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a real @digitalpaani.com account is not treated that way', async () => {
    const res = await api.post('/api/applications/9001/status', { as: { ...TEST_USERS.hr_recruiter, email: 'someone@digitalpaani.com' }, body: {} });
    expect(res.status).toBe(400);   // got past authentication into the handler ("new_status required")
  });
});

// ─── 6. the shared-secret endpoints ──────────────────────────────────────────────────────────────────────────────
describe('endpoints that take a shared secret instead of a JWT', () => {
  const secretRoutes = withGate('ingest').map(r => ({ ...r, ...SECRET_ROUTES[r.key] }));

  it.each(secretRoutes.map(r => [r.key, r] as const))('%s → 401 without the header, with a wrong one, and with a signed-in user\'s JWT — and never reaches the database', async (_key, r) => {
    const attempts: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['empty header', { [r.header]: '' }],
      ['wrong secret', { [r.header]: 'not-the-secret' }],
      ['the secret with a character added', { [r.header]: `${SECRETS[r.env as keyof typeof SECRETS]}x` }],
      ['the secret with a character missing', { [r.header]: SECRETS[r.env as keyof typeof SECRETS].slice(0, -1) }],
      ['a super_admin JWT as Bearer', { authorization: `Bearer ${signToken('super_admin')}` }],
      ['a super_admin JWT in the secret header', { [r.header]: signToken('super_admin') }],
    ];
    for (const [name, headers] of attempts) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { headers, body: {} });
      expect([name, res.status]).toEqual([name, 401]);
      expect(fakeDb.untouched(), name).toBe(true);
    }
  });

  it.each(secretRoutes.map(r => [r.key, r] as const))('%s lets the right secret in (a bare body then fails its own validation, so the gate is not simply always closed)', async (_key, r) => {
    const res = await api.request(r.method, r.path, { headers: { [r.header]: SECRETS[r.env as keyof typeof SECRETS] }, body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(r.pastTheGate);
  });

  it('the secrets are not interchangeable: the role secret does not open candidate ingest, nor the candidate secret the role ingest or the backfill', async () => {
    const opens = async (key: string, secret: string) => (await api.request(...(key.split(' ') as [string, string]), { headers: { 'x-ingest-secret': secret }, body: {} })).status !== 401;
    expect(await opens('POST /api/candidates/ingest', SECRETS.ROLE_INGEST_SECRET)).toBe(false);
    expect(await opens('POST /api/roles/ingest', SECRETS.CANDIDATE_INGEST_SECRET)).toBe(false);
    expect(await opens('POST /api/applications/portfolio-backfill', SECRETS.CANDIDATE_INGEST_SECRET)).toBe(false);
    expect(await opens('POST /api/roles/ingest', SECRETS.ROLE_INGEST_SECRET)).toBe(true);
  });

  it('with a secret missing from the server, nothing a caller sends opens the endpoint (a header that reads "undefined" included)', async () => {
    restoreEnv();
    restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, ROLE_INGEST_SECRET: undefined, CANDIDATE_INGEST_SECRET: undefined });
    for (const r of secretRoutes) {
      for (const value of ['', 'undefined', 'null', 'x']) {
        fakeDb.reset();
        const res = await api.request(r.method, r.path, { headers: { [r.header]: value }, body: {} });
        expect([r.key, value, res.status]).toEqual([r.key, value, 401]);
        expect(fakeDb.untouched()).toBe(true);
      }
    }
  });
});

describe('cron endpoints (Authorization: Bearer <CRON_SECRET>)', () => {
  const cronRoutes = withGate('cron');

  it.each(cronRoutes.map(r => [r.key, r] as const))('%s → 401 without the bearer secret, with a wrong one, with the secret unprefixed, and with a JWT; never reaches the database', async (_key, r) => {
    const attempts: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['wrong secret', { authorization: 'Bearer wrong' }],
      ['the secret without "Bearer "', { authorization: SECRETS.CRON_SECRET }],
      ['the secret as Basic', { authorization: `Basic ${SECRETS.CRON_SECRET}` }],
      ['a super_admin JWT', { authorization: `Bearer ${signToken('super_admin')}` }],
    ];
    for (const [name, headers] of attempts) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { headers, body: body(r.method) });
      expect([name, res.status, res.body]).toEqual([name, 401, { error: 'Unauthorized' }]);
      expect(fakeDb.untouched(), name).toBe(true);
    }
  });

  it.each(cronRoutes.map(r => [r.key, r] as const))('%s runs for the right bearer secret', async (_key, r) => {
    const res = await api.request(r.method, r.path, { headers: { authorization: `Bearer ${SECRETS.CRON_SECRET}` }, body: body(r.method) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it.each(cronRoutes.map(r => [r.key, r] as const))('%s answers 500 "CRON_SECRET not set" when the server has no secret — closed, whatever the caller sends', async (_key, r) => {
    restoreEnv();
    restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, CRON_SECRET: undefined });
    for (const authorization of ['Bearer undefined', 'Bearer ', 'Bearer']) {
      const res = await api.request(r.method, r.path, { headers: { authorization }, body: body(r.method) });
      expect([authorization, res.status, res.body]).toEqual([authorization, 500, { error: 'CRON_SECRET not set' }]);
    }
  });
});

// ─── 7. the Sourcing module's off switch ─────────────────────────────────────────────────────────────────────────
describe('while SOURCING_ENABLED is not "true"', () => {
  const sourcing = table.filter(r => r.path.startsWith('/api/sourcing/'));

  it('every sourcing route still needs a token', async () => {
    restoreEnv();
    restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, SOURCING_ENABLED: undefined });
    for (const r of sourcing) expect([r.key, (await api.request(r.method, r.path, { body: body(r.method) })).status]).toEqual([r.key, 401]);
  });

  it('reads answer { enabled: false } and writes 503 for EVERY persona — the switch is checked before the HR guard — and nothing is read or written', async () => {
    restoreEnv();
    restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, SOURCING_ENABLED: undefined });
    for (const persona of ALL_PERSONAS) {
      for (const r of sourcing) {
        fakeDb.reset();
        const res = await api.request(r.method, r.path, { as: persona, body: body(r.method) });
        if (r.method === 'GET') expect([persona, r.key, res.status, res.body]).toEqual([persona, r.key, 200, { enabled: false }]);
        else expect([persona, r.key, res.status, res.body.enabled]).toEqual([persona, r.key, 503, false]);
        expect(fakeDb.untouched(), `${persona} ${r.key}`).toBe(true);
      }
    }
  });

  it('only the string "true" switches it on ("1", "TRUE" and "yes" do not)', async () => {
    for (const value of ['1', 'TRUE', 'yes', 'on', '']) {
      restoreEnv();
      restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, SOURCING_ENABLED: value });
      const res = await api.get('/api/sourcing/status', { as: 'hr_recruiter' });
      expect([value, res.body]).toEqual([value, { enabled: false }]);
    }
  });
});

// ─── 8. known gaps, pinned as they are today ─────────────────────────────────────────────────────────────────────
describe('characterization (what the code does today; see productIssues in the task report)', () => {
  it('GET /api/candidates/:id/edit-log is open to a hiring_manager and returns the raw log rows — including old and new values of the compensation fields that GET /api/candidates/:id hides from that persona', async () => {
    const row = { id: 1, candidate_id: 'C9001', field_name: 'expected_ctc', old_value: '1000000', new_value: '1400000', changed_by_name: 'Test Recruiter' };
    fakeDb.when(/FROM candidate_edit_log/, [row]);
    const res = await api.get('/api/candidates/C9001/edit-log', { as: 'hiring_manager' });
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([row]);
  });

  it('requireLeadership is exported but no route is mounted with it: across all routes a hiring_manager is never told "Leadership access required"', async () => {
    const messages = new Set<string>();
    for (const r of protectedRoutes) {
      fakeDb.reset();
      const res = await api.request(r.method, r.path, { as: 'hiring_manager', body: body(r.method) });
      if (res.status === 403) messages.add(String(res.body?.error));
    }
    expect(messages.has('HR access required')).toBe(true);           // the sweep did reach the guards …
    expect(messages.has('Leadership access required')).toBe(false);  // … and none of them is requireLeadership
  });
});
