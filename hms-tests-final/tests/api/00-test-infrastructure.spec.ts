/**
 * The test infrastructure itself: connection-level retry, the date helpers, the database-URL guards, the seeded-user session cache, the
 * stack script's argument checks and the config's "write-capable projects are local-only" rule.
 *
 * Almost all of it is pure (no HTTP): these tests exist because every other spec stands on these helpers, and a silent change in one of
 * them (a retry that also retries a 500, a date helper off by a day, a guard that lets a remote database through) would not fail anywhere else.
 * The browser-side helpers are pinned by tests/e2e/00-test-infrastructure.spec.ts.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import {
  USERS, authed, getSession, getToken, isConnectionError, withConnectionRetry,
} from '../helpers/api';
import { futureDateOnly, futureIso, futureLocalDateTime, pastDateOnly, pastIso } from '../helpers/dates';
import { DEFAULT_TEST_DB_URL, TEST_DB_URL, newClient, resolveTestDbUrl, withDb } from '../helpers/db';
import playwrightConfig from '../../playwright.config';

const DAY = 86_400_000;
const near = (a: number, b: number, ms = 5_000) => Math.abs(a - b) <= ms;

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('connection-level retry (helpers/api.ts)', () => {
  const connErr = (msg: string) => Object.assign(new Error(msg), {});

  test('isConnectionError: ECONNRESET, ECONNREFUSED and "socket hang up" only (message, code or cause)', () => {
    expect(isConnectionError(connErr('apiRequestContext.get: read ECONNRESET'))).toBe(true);
    expect(isConnectionError(connErr('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:4000'))).toBe(true);
    expect(isConnectionError(connErr('apiRequestContext.patch: socket hang up'))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);

    expect(isConnectionError(connErr('Timeout 30000ms exceeded'))).toBe(false);
    expect(isConnectionError(connErr('apiRequestContext.get: connect ETIMEDOUT 10.0.0.1:4000'))).toBe(false);
    expect(isConnectionError(connErr('Request failed with status 500'))).toBe(false);
    expect(isConnectionError(connErr('apiRequestContext.get: getaddrinfo ENOTFOUND nowhere.invalid'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError('ECONNRESET')).toBe(false);   // a bare string is not an Error: nothing to inspect
  });

  test('a connection error is retried up to 3 times (4 attempts) and the first success is returned', async () => {
    let calls = 0;
    const result = await withConnectionRetry(async () => {
      calls++;
      if (calls <= 3) throw connErr('read ECONNRESET');
      return 'ok';
    }, { backoffMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(4);
  });

  test('after 3 retries the connection error is thrown, not swallowed', async () => {
    let calls = 0;
    await expect(withConnectionRetry(async () => { calls++; throw connErr('connect ECONNREFUSED'); }, { backoffMs: 1 }))
      .rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(4);
  });

  test('anything else is NOT retried: a timeout, a plain error, and a returned HTTP 500 are all single attempts', async () => {
    for (const make of [() => connErr('Timeout 30000ms exceeded'), () => new Error('boom')]) {
      let calls = 0;
      await expect(withConnectionRetry(async () => { calls++; throw make(); }, { backoffMs: 1 })).rejects.toThrow();
      expect(calls).toBe(1);
    }
    let calls = 0;
    const res = await withConnectionRetry(async () => { calls++; return { status: () => 500 }; }, { backoffMs: 1 });
    expect(res.status()).toBe(500);
    expect(calls).toBe(1);
  });

  test('authed() applies it to get, post, patch, put and delete, and never retries a response with an error status', async () => {
    const seen: Record<string, number> = {};
    const flaky = (verb: string) => async () => {
      seen[verb] = (seen[verb] ?? 0) + 1;
      if (seen[verb] === 1) throw connErr(`apiRequestContext.${verb}: read ECONNRESET`);
      return { status: () => 200 };
    };
    const request = { get: flaky('get'), post: flaky('post'), patch: flaky('patch'), put: flaky('put'), delete: flaky('delete') } as unknown as APIRequestContext;
    const api = authed(request, 'token');
    for (const res of [await api.get('/x'), await api.post('/x', {}), await api.patch('/x', {}), await api.put('/x', {}), await api.delete('/x')]) {
      expect(res.status()).toBe(200);
    }
    expect(seen).toEqual({ get: 2, post: 2, patch: 2, put: 2, delete: 2 });

    let hits = 0;
    const serverError = { post: async () => { hits++; return { status: () => 500 }; } } as unknown as APIRequestContext;
    expect((await authed(serverError, 'token').post('/x', {})).status()).toBe(500);
    expect(hits).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('date helpers (helpers/dates.ts) are computed from the real clock', () => {
  test('futureIso / pastIso without options are exactly now ± n days', () => {
    expect(near(new Date(futureIso(30)).getTime(), Date.now() + 30 * DAY)).toBe(true);
    expect(near(new Date(pastIso(3)).getTime(), Date.now() - 3 * DAY)).toBe(true);
    expect(futureIso(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('a fixed time of day in an offset: IST 10:00 keeps the wall clock and the offset, on the IST date n days away', () => {
    const iso = futureIso(30, { hour: 10, offset: '+05:30' });
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T10:00:00\+05:30$/);
    const istToday = (offsetDays: number) => new Date(Date.now() + 19_800_000 + offsetDays * DAY).toISOString().slice(0, 10);
    expect([istToday(30), istToday(30)]).toContain(iso.slice(0, 10));
    expect(new Date(iso).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);   // really in the future
    expect(futureIso(2, { hour: 9, minute: 5 })).toMatch(/T09:05:00Z$/);       // default offset is Z
    expect(futureIso(2, { minute: 7 })).toMatch(/T00:07:00Z$/);               // `minute` alone also fixes the time of day (hour 0)
    expect(pastIso(3, { hour: 9, offset: '-05:00' })).toMatch(/T09:00:00-05:00$/);
    expect(new Date(pastIso(3, { hour: 9, offset: '-05:00' })).getTime()).toBeLessThan(Date.now());
  });

  test('date-only helpers follow the UTC calendar, or the calendar of the offset', () => {
    const utc = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
    expect(futureDateOnly(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(futureDateOnly(60)).toBe(utc(60));
    expect(pastDateOnly(1)).toBe(utc(-1));
    const ist = new Date(Date.now() + 19_800_000 + 7 * DAY).toISOString().slice(0, 10);
    expect(futureDateOnly(7, { offset: '+05:30' })).toBe(ist);
  });

  test('futureLocalDateTime is a datetime-local value in the future; a malformed offset is refused', () => {
    const v = futureLocalDateTime(30, { hour: 11 });
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T11:00$/);
    expect(new Date(v).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(futureLocalDateTime(1)).toMatch(/T10:00$/);
    expect(() => futureIso(1, { hour: 1, offset: 'IST' })).toThrow(/offset/);
  });

  test('with the clock pinned, every helper lands on the exact day and wall clock (zone arithmetic is deterministic, not a coincidence of the hour the suite runs)', () => {
    const realNow = Date.now;
    const at = (iso: string) => { Date.now = () => Date.parse(iso); };
    try {
      at('2026-06-15T18:45:00Z');                                     // 00:15 on the 16th in IST, 13:45 on the 15th at -05:00
      expect(futureDateOnly(0)).toBe('2026-06-15');
      expect(futureDateOnly(0, { offset: '+05:30' })).toBe('2026-06-16');
      expect(futureDateOnly(0, { offset: '+05:00' })).toBe('2026-06-15');   // the 30 minutes matter: 18:45Z is already tomorrow only at +05:30
      expect(futureDateOnly(0, { offset: '-05:00' })).toBe('2026-06-15');
      expect(futureDateOnly(30, { offset: '+05:30' })).toBe('2026-07-16');
      expect(pastDateOnly(15)).toBe('2026-05-31');
      expect(futureIso(30, { hour: 10, offset: '+05:30' })).toBe('2026-07-16T10:00:00+05:30');
      expect(futureIso(0, { hour: 9, minute: 5 })).toBe('2026-06-15T09:05:00Z');
      expect(pastIso(1, { hour: 23, minute: 59, offset: '-05:00' })).toBe('2026-06-14T23:59:00-05:00');
      expect(futureIso(30)).toBe('2026-07-15T18:45:00.000Z');
      expect(pastIso(3)).toBe('2026-06-12T18:45:00.000Z');
      at('2026-06-15T03:00:00Z');                                     // 22:00 on the 14th at -05:00
      expect(futureDateOnly(0, { offset: '-05:00' })).toBe('2026-06-14');
      expect(futureDateOnly(0, { offset: '+05:30' })).toBe('2026-06-15');
    } finally {
      Date.now = realNow;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('database URL guards (helpers/db.ts)', () => {
  test('default, override, and the local-host rule', () => {
    expect(DEFAULT_TEST_DB_URL).toBe('postgresql://hms_user:hms_password@localhost:5432/dp_hms');   // the contract with docker-compose.yml and the CI service: pinned literally, or the next line only compares the constant with itself
    expect(resolveTestDbUrl({})).toBe(DEFAULT_TEST_DB_URL);
    expect(resolveTestDbUrl({ TEST_DB_URL: 'postgresql://u:p@localhost:55440/dp_hms' })).toBe('postgresql://u:p@localhost:55440/dp_hms');
    expect(resolveTestDbUrl({ TEST_DB_URL: 'postgresql://u:p@127.0.0.1:55441/dp_hms' })).toContain('127.0.0.1');
    expect(resolveTestDbUrl({ TEST_DB_URL: 'postgresql://u:p@[::1]:5432/dp_hms' })).toContain('[::1]');
    for (const remote of ['postgresql://u:p@db.example.com:5432/x', 'postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres', 'postgresql://u:p@10.0.0.5/x', 'not a url']) {
      expect(() => resolveTestDbUrl({ TEST_DB_URL: remote }), remote).toThrow(/LOCAL database/);
    }
  });

  test('an API on a stack port (4110-4119) without TEST_DB_URL is refused: the default would be the developer\'s own database', () => {
    for (const port of [4110, 4115, 4119]) {
      expect(() => resolveTestDbUrl({ TEST_API_URL: `http://localhost:${port}` }), String(port)).toThrow(/stack port/);
      expect(resolveTestDbUrl({ TEST_API_URL: `http://localhost:${port}`, TEST_DB_URL: 'postgresql://u:p@localhost:55440/d' })).toContain('55440');
    }
    // outside the stack range the default stays valid: docker-compose (4000), CI, a hand-started backend on another port
    for (const url of [undefined, 'http://localhost:4000', 'http://localhost:4109', 'http://localhost:4120', 'http://127.0.0.1:3000']) {
      expect(resolveTestDbUrl({ TEST_API_URL: url }), String(url)).toBe(DEFAULT_TEST_DB_URL);
    }
  });

  test('the URL the specs actually use is TEST_DB_URL from the environment', () => {
    expect(TEST_DB_URL).toBe(process.env.TEST_DB_URL || DEFAULT_TEST_DB_URL);
  });

  test('newClient() and withDb() connect through TEST_DB_URL, hand back the callback\'s value, and always close the connection (also when the callback throws)', async () => {
    const want = new URL(TEST_DB_URL);
    const fresh = newClient();
    expect(fresh.port).toBe(Number(want.port));
    expect(fresh.host).toBe(want.hostname);
    expect(fresh.database).toBe(want.pathname.slice(1));

    let seen: ReturnType<typeof newClient> | undefined;
    const roles = await withDb(async c => { seen = c; return Number((await c.query('SELECT count(*) AS n FROM roles')).rows[0].n); });
    expect(roles).toBeGreaterThanOrEqual(7);
    await expect(seen!.query('SELECT 1'), 'the client must be closed after a normal return').rejects.toThrow();

    let thrown: ReturnType<typeof newClient> | undefined;
    await expect(withDb(async c => { thrown = c; throw new Error('boom from the callback'); })).rejects.toThrow('boom from the callback');
    await expect(thrown!.query('SELECT 1'), 'the client must be closed after a throw').rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('seeded users and the session cache written by globalSetup', () => {
  const authDir = path.join(process.cwd(), '.auth');
  const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf8')) as Record<string, any>;

  test('USERS carries the seeded super_admin, and it is the only super_admin', () => {
    expect(USERS.super_admin).toMatchObject({ email: 'superadmin@digitalpaani.com', persona: 'super_admin' });
    expect(Object.entries(USERS).filter(([, u]) => u.persona === 'super_admin').map(([k]) => k)).toEqual(['super_admin']);
  });

  test('globalSetup cached a token AND the user record for every seeded user', async ({ request }) => {
    const tokens = readJson('tokens.json');
    const users = readJson('users.json');
    for (const [key, u] of Object.entries(USERS)) {
      expect(tokens[key], `token for ${key}`).toBeTruthy();
      expect(users[key], `user record for ${key}`).toMatchObject({ email: u.email, persona: u.persona });
      expect(users[key].id).toBeTruthy();
      expect(users[key]).not.toHaveProperty('password_hash');
    }
    const session = await getSession(request, 'hm_alex');
    expect(session.token).toBe(tokens.hm_alex);
    expect(session.user).toMatchObject({ email: USERS.hm_alex.email, persona: 'hiring_manager' });
  });

  test('the super_admin session works against the API and is the only one that reaches /api/users', async ({ request }) => {
    const sa = authed(request, await getToken(request, 'super_admin'));
    const me = await (await sa.get('/api/auth/me')).json();
    expect(me.user.persona).toBe('super_admin');
    expect((await sa.get('/api/users')).status()).toBe(200);
    for (const who of ['hr', 'leadership', 'hm_alex'] as const) {
      expect((await authed(request, await getToken(request, who)).get('/api/users')).status(), who).toBe(403);
    }
  });

  test('the backend this suite talks to runs in UTC: a DATE column is serialised as UTC midnight of the SAME calendar day (a host in IST turned 2026-04-27 into 2026-04-26T18:30Z)', async ({ request }) => {
    const { id, day } = await withDb(async c => (await c.query(
      `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS day FROM roles WHERE start_date IS NOT NULL ORDER BY id LIMIT 1`)).rows[0]);
    expect(id, 'the seed holds a role with a start_date').toBeTruthy();
    const role = (await (await authed(request, await getToken(request, 'hr')).get(`/api/roles/${id}`)).json()).role;
    expect(String(role.start_date), 'start the stack with scripts/test-stack.sh (TZ=UTC), or run the backend with TZ=UTC').toBe(`${day}T00:00:00.000Z`);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('scripts/test-stack.sh: argument validation and the port plan (no docker is touched)', () => {
  const script = path.join(process.cwd(), 'scripts', 'test-stack.sh');
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  const RESERVED = [4000, 5173, 5432, 55432];   // the developer's own services

  test('an index outside 0..9, a non-number or an unknown command is refused with a non-zero exit before anything is started', () => {
    for (const bad of ['10', '-1', 'x', '', '00', '1a']) {
      const r = run('up', bad);
      expect(r.status, `up ${JSON.stringify(bad)}`).not.toBe(0);
      expect(r.stderr).toMatch(/stack index must be a single digit 0\.\.9/);
    }
    expect(run('bogus', '1').status).not.toBe(0);
    expect(run('up', '1', '--bogus').stderr).toMatch(/unknown option/);
  });

  test('env N prints the three exports; every index gets distinct ports and none is a reserved one', () => {
    const ports = new Set<number>();
    for (let n = 0; n <= 9; n++) {
      const r = run('env', String(n));
      expect(r.status, `env ${n}`).toBe(0);
      const api = Number(/TEST_API_URL=http:\/\/localhost:(\d+)/.exec(r.stdout)?.[1]);
      const fe = Number(/TEST_FRONTEND_URL=http:\/\/localhost:(\d+)/.exec(r.stdout)?.[1]);
      const db = Number(/TEST_DB_URL=postgresql:\/\/hms_user:hms_password@localhost:(\d+)\/dp_hms$/m.exec(r.stdout)?.[1]);   // anchored: the database name is exactly dp_hms (the db specs' default)
      expect([api, fe, db]).toEqual([4110 + n, 5180 + n, 55440 + n]);
      for (const p of [api, fe, db]) { expect(RESERVED, `port ${p} of stack ${n}`).not.toContain(p); ports.add(p); }
      expect(r.stdout.trim().split('\n').every(l => l.startsWith('export '))).toBe(true);
    }
    expect(ports.size).toBe(30);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('playwright.config.ts: settings every other spec relies on', () => {
  const project = (name: string) => playwrightConfig.projects?.find(p => p.name === name);

  test('serial on purpose (one worker, no retries), generous timeouts, forbidOnly in CI, an outputDir, and the live-tag gate', () => {
    expect(playwrightConfig.workers).toBe(1);
    expect(playwrightConfig.fullyParallel).toBe(false);
    expect(playwrightConfig.retries).toBe(0);
    expect(playwrightConfig.timeout).toBe(60_000);
    expect(playwrightConfig.expect?.timeout).toBe(10_000);
    expect(playwrightConfig.forbidOnly).toBe(!!process.env.CI);
    expect(playwrightConfig.globalSetup).toMatch(/tests[\\/]helpers[\\/]global-setup\.ts$/);
    expect(playwrightConfig.outputDir).toBe(process.env.PW_OUTPUT_DIR || 'test-results');
    if (process.env.TEST_LIVE) expect(playwrightConfig.grepInvert).toBeUndefined();
    else expect(String((playwrightConfig.grepInvert as RegExp)?.source)).toBe('@live');
  });

  test('the smoke project (it runs against production) never records a trace, a video or a screenshot', () => {
    expect(project('smoke')?.use).toMatchObject({ trace: 'off', video: 'off', screenshot: 'off' });
    for (const name of ['api', 'db', 'e2e']) expect(project(name)?.use?.trace, name).not.toBe('off');
    expect(playwrightConfig.use).toMatchObject({ trace: 'retain-on-failure', video: 'retain-on-failure', screenshot: 'only-on-failure' });
  });

  test('e2e and e2e-mobile: the browser runs in Asia/Kolkata and never reaches the internet; e2e-mobile is a phone viewport with touch', () => {
    for (const name of ['e2e', 'e2e-mobile']) {
      const use = project(name)?.use;
      expect(use?.timezoneId, name).toBe('Asia/Kolkata');
      if (!process.env.PW_ALLOW_EXTERNAL_HOSTS) {
        expect((use?.launchOptions?.args ?? []).join(' '), name).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
      }
    }
    expect(project('e2e')?.testMatch).toBe('tests/e2e/**/*.spec.ts');
    const mobile = project('e2e-mobile');
    expect(mobile?.testMatch).toBe('tests/e2e-mobile/**/*.spec.ts');
    expect(mobile?.use).toMatchObject({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  });
});

test.describe('playwright.config.ts: the project set, and the live-tag gate', () => {
  test.describe.configure({ timeout: 120_000 });   // each nested `playwright test --list` loads ~70 spec files: ~2.5 s idle, several times that under load

  // Nested `playwright test --list` runs (no globalSetup, no browser, no backend contact). The parent run's own PW_* / PLAYWRIGHT_*
  // variables are removed so the child is an ordinary CLI invocation.
  const cleanEnv = (extra: Record<string, string>) => {
    const env: Record<string, string | undefined> = { ...process.env, ...extra };
    for (const k of Object.keys(env)) if (/^(PW_|PLAYWRIGHT_|TEST_WORKER_INDEX|TEST_PARALLEL_INDEX|TEST_LIVE)/.test(k)) delete env[k];
    Object.assign(env, extra);
    return env as NodeJS.ProcessEnv;
  };
  const cli = require.resolve('@playwright/test/cli');
  const list = (extra: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, 'test', '--list', ...args], { cwd: process.cwd(), env: cleanEnv(extra), encoding: 'utf8', timeout: 90_000 });

  type JsonSuite = { specs?: { title: string; tests: { projectName: string }[] }[]; suites?: JsonSuite[] };
  /** Every (project, test title) pair of a `--list --reporter=json` run. */
  const listed = (extra: Record<string, string>, ...args: string[]) => {
    const r = list(extra, '--reporter=json', ...args);
    expect(r.status, r.stderr).toBe(0);
    const out: { project: string; title: string }[] = [];
    const walk = (s: JsonSuite) => {
      for (const spec of s.specs ?? []) for (const t of spec.tests) out.push({ project: t.projectName, title: spec.title });
      for (const child of s.suites ?? []) walk(child);
    };
    for (const s of (JSON.parse(r.stdout) as { suites: JsonSuite[] }).suites) walk(s);
    return out;
  };
  const projectsOf = (rows: { project: string }[]) => [...new Set(rows.map(r => r.project))].sort();

  test('against a non-local URL only the read-only smoke project exists: api, db, e2e and e2e-mobile are "not found"', () => {
    const remote = { TEST_API_URL: 'https://hms-config-selftest.invalid', TEST_FRONTEND_URL: 'https://hms-config-selftest.invalid' };
    for (const project of ['api', 'db', 'e2e', 'e2e-mobile']) {
      const r = list(remote, `--project=${project}`);
      expect(r.status, project).not.toBe(0);
      expect(r.stderr + r.stdout, project).toMatch(new RegExp(`Project\\(s\\) "${project}" not found`));
    }
    expect(projectsOf(listed(remote))).toEqual(['smoke']);
  });

  test('against a local URL the api, db, e2e, smoke projects all list tests (e2e-mobile exists but may hold none yet)', () => {
    const local = { TEST_API_URL: 'http://localhost:4000', TEST_FRONTEND_URL: 'http://localhost:5173' };
    expect(projectsOf(listed(local))).toEqual(expect.arrayContaining(['api', 'db', 'e2e', 'smoke']));
    expect(list(local, '--project=e2e-mobile').stderr).not.toMatch(/Project\(s\) .* not found/);   // the project is configured
  });

  test('a test whose title carries the live tag is left out of a run unless TEST_LIVE is set (the real config, measured on a probe directory)', () => {
    // A throw-away config + spec under .stack/ (git-ignored, inside hms-tests-final so @playwright/test resolves) that spreads the REAL
    // playwright.config.ts and only swaps the project set, so what is measured is the real grepInvert and nothing else.
    const dir = path.join(process.cwd(), '.stack', `selftest-live-gate-${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'gate.spec.ts'),
        "import { test } from '@playwright/test';\n" +
        "test('plain probe', () => {});\n" +
        "test('probe tagged @live', () => {});\n");
      fs.writeFileSync(path.join(dir, 'playwright.config.ts'),
        "import base from '../../playwright.config';\n" +
        "export default { ...base, testDir: __dirname, outputDir: __dirname + '/out', globalSetup: undefined, projects: [{ name: 'gate', testMatch: '*.spec.ts' }] };\n");
      const titles = (extra: Record<string, string>) => {
        const r = list({ TEST_API_URL: 'http://localhost:4000', ...extra }, '--config', path.join(dir, 'playwright.config.ts'), '--reporter=json');
        expect(r.status, r.stderr).toBe(0);
        const out: string[] = [];
        const walk = (s: JsonSuite) => { for (const sp of s.specs ?? []) out.push(sp.title); for (const c of s.suites ?? []) walk(c); };
        for (const s of (JSON.parse(r.stdout) as { suites: JsonSuite[] }).suites) walk(s);
        return out.sort();
      };
      expect(titles({})).toEqual(['plain probe']);
      expect(titles({ TEST_LIVE: '1' })).toEqual(['plain probe', 'probe tagged @live']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// helpers/global-setup.ts and the live-login fallback of helpers/api.ts, run FOR REAL in nested Playwright runs against a fake API
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A nested run gets its own directory under .stack/ (git-ignored; inside hms-tests-final so @playwright/test resolves), its own working
// directory (globalSetup writes .auth/ relative to the cwd, and must never overwrite THIS run's cached tokens) and its own outputDir. The
// config spreads the REAL playwright.config.ts and keeps the REAL globalSetup; the target is a throw-away HTTP server in this process
// (so these tests need neither the backend nor the database). SMOKE_* variables are removed: a developer's production smoke credentials
// must never reach a nested run.
test.describe('globalSetup and the live-login fallback, run for real against a fake API', () => {
  test.describe.configure({ timeout: 180_000 });

  type Hit = { method: string; url: string; auth?: string };
  type FakeOptions = { loginOk?: boolean; failLoginFor?: string; dashboardDelayMs?: number; unhealthyAnswers?: number };

  async function fakeApi(opts: FakeOptions = {}) {
    const hits: Hit[] = [];
    let healthAnswers = 0;
    const server = http.createServer((req, res) => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/health') return json(++healthAnswers <= (opts.unhealthyAnswers ?? 0) ? 503 : 200, { status: 'ok' });   // counted, not timed: a nested run's start-up time depends on the machine
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
          const { email } = JSON.parse(raw || '{}') as { email: string };
          if (opts.loginOk === false || email === opts.failLoginFor) return json(401, { error: 'Invalid credentials' });
          const persona = Object.values(USERS).find(u => u.email === email)?.persona ?? 'hr_recruiter';
          json(200, { token: `fake-token-${email}`, user: { id: `id-${email}`, name: email.split('@')[0], email, persona } });
        });
        return;
      }
      if (req.url === '/api/dashboard') { setTimeout(() => json(200, {}), opts.dashboardDelayMs ?? 0); return; }
      json(404, { error: 'not found' });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      hits,
      close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
  }

  /** A port nothing listens on (bound and released a moment ago). */
  async function closedPort(): Promise<number> {
    const s = http.createServer();
    await new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>(resolve => s.close(() => resolve()));
    return port;
  }

  const abs = (...parts: string[]) => path.join(process.cwd(), ...parts).split(path.sep).join('/');

  /** Runs one nested Playwright run in a fresh probe directory; returns its exit code, combined output and the files it left in .auth/. */
  async function runProbe(opts: { spec: string; globalSetup: boolean; env: Record<string, string> }) {
    const dir = path.join(process.cwd(), '.stack', `selftest-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'probe.spec.ts'), opts.spec);
      fs.writeFileSync(path.join(dir, 'playwright.config.ts'),
        "import base from '../../playwright.config';\n" +
        "export default { ...base, testDir: __dirname, outputDir: __dirname + '/out', grepInvert: undefined, reporter: [['line']],\n" +
        `  globalSetup: ${opts.globalSetup ? `'${abs('tests/helpers/global-setup.ts')}'` : 'undefined'},\n` +
        "  projects: [{ name: 'probe', testMatch: '*.spec.ts' }] };\n");
      const env: Record<string, string | undefined> = { ...process.env };
      for (const k of Object.keys(env)) if (/^(PW_|PLAYWRIGHT_|TEST_|SMOKE_|HMS_PW_|CI$)/.test(k)) delete env[k];
      Object.assign(env, opts.env);
      const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(dir, 'playwright.config.ts'), '--reporter=line'],
        { cwd: dir, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      const readAuth = (file: string) => {
        const f = path.join(dir, '.auth', file);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any> : null;
      };
      return { code, out, tokens: readAuth('tokens.json'), users: readAuth('users.json') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const TRIVIAL = "import { test } from '@playwright/test';\ntest('probe ran', () => {});\n";

  test('a healthy local API: every seeded user is logged in, tokens AND user records are cached, and /api/dashboard is warmed exactly once with the hr token and a budget well beyond a few seconds', async () => {
    const api = await fakeApi({ dashboardDelayMs: 2_500 });
    try {
      const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: api.url, TEST_FRONTEND_URL: 'http://localhost:5173' } });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/1 passed/);
      const keys = Object.keys(USERS).sort();
      expect(Object.keys(r.tokens ?? {}).sort()).toEqual(keys);
      expect(Object.keys(r.users ?? {}).sort()).toEqual(keys);
      for (const [key, u] of Object.entries(USERS)) {
        expect(r.tokens?.[key]).toBe(`fake-token-${u.email}`);
        expect(r.users?.[key]).toMatchObject({ email: u.email, persona: u.persona });
      }
      const logins = api.hits.filter(h => h.method === 'POST' && h.url === '/api/auth/login');
      expect(logins).toHaveLength(keys.length);
      const warm = api.hits.filter(h => h.url === '/api/dashboard');
      expect(warm).toHaveLength(1);
      expect(warm[0].auth).toBe(`Bearer fake-token-${USERS.hr.email}`);
      expect(r.out, 'the 2.5 s dashboard answer must be waited for, not abandoned').toMatch(/dashboard warmed \(HTTP 200/);
      expect(r.out).not.toMatch(/warm-up failed/);
    } finally { await api.close(); }
  });

  test('the health check comes first and tolerates a backend that is still starting (503 twice, then 200)', async () => {
    const api = await fakeApi({ unhealthyAnswers: 2 });
    try {
      const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: api.url } });
      expect(r.code, r.out).toBe(0);
      const health = api.hits.filter(h => h.url === '/health');
      expect(health.length, 'it must have polled past two 503 answers, not given up on the first').toBe(3);
      const firstLogin = api.hits.findIndex(h => h.url === '/api/auth/login');
      expect(api.hits.findIndex(h => h.url === '/health'), 'GET /health precedes every login').toBeLessThan(firstLogin);
    } finally { await api.close(); }
  });

  test('an unreachable local API aborts the whole run with a clear message: nothing is run, no login is attempted', async () => {
    const port = await closedPort();
    const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: `http://127.0.0.1:${port}`, HMS_PW_HEALTH_WAIT_MS: '1500' } });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`The API at http://127.0.0.1:${port} is not reachable`);
    expect(r.out).toMatch(/Nothing was run/);
    expect(r.out).toMatch(/test-stack\.sh up/);
    expect(r.out).not.toMatch(/1 passed/);
    expect(r.tokens, 'no token cache is written for an API that never answered').toBeNull();
  });

  test('a seeded login that fails THROWS (the database is not the seeded one); it names the user, and no test runs', async () => {
    const api = await fakeApi({ loginOk: false });
    try {
      const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: api.url } });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(new RegExp(`${Object.keys(USERS).length} seeded user\\(s\\) could not sign in`));
      expect(r.out).not.toMatch(/1 passed/);
    } finally { await api.close(); }

    const one = await fakeApi({ failLoginFor: USERS.super_admin.email });
    try {
      const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: one.url } });
      expect(r.code, 'even ONE failed seeded login is fatal').not.toBe(0);
      expect(r.out).toMatch(/1 seeded user\(s\) could not sign in/);
      expect(r.out).toContain('super_admin');
      expect(r.out).not.toMatch(/1 passed/);
    } finally { await one.close(); }
  });

  test('a non-local target without smoke credentials: no health check, no seeded users, and the run throws because no token at all was obtained', async () => {
    const r = await runProbe({ spec: TRIVIAL, globalSetup: true, env: { TEST_API_URL: 'https://hms-selftest.invalid' } });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/No token was obtained from https:\/\/hms-selftest\.invalid/);
    expect(r.out).not.toMatch(/not reachable/);
    expect(r.out).not.toMatch(/seeded user/);
    expect(r.out).toMatch(/smoke_lead: no credentials configured/);
  });

  test('without globalSetup the helpers fall back to ONE live login per user, then serve the session from memory', async () => {
    const api = await fakeApi();
    try {
      const spec =
        "import { test, expect } from '@playwright/test';\n" +
        `import { getSession, getToken } from '${abs('tests/helpers/api')}';\n` +
        "test('fallback', async ({ request }) => {\n" +
        "  const first = await getSession(request, 'hm_alex');\n" +
        "  expect(first.token).toBe('fake-token-alex@digitalpaani.com');\n" +
        "  expect(first.user).toMatchObject({ email: 'alex@digitalpaani.com', persona: 'hiring_manager' });\n" +
        "  expect((await getSession(request, 'hm_alex')).token).toBe(first.token);\n" +
        "  expect(await getToken(request, 'hm_alex')).toBe(first.token);\n" +
        "  expect(await getToken(request, 'leadership')).toBe('fake-token-nalin@digitalpaani.com');\n" +
        "  expect(await getToken(request, 'leadership')).toBe('fake-token-nalin@digitalpaani.com');\n" +
        "});\n";
      const r = await runProbe({ spec, globalSetup: false, env: { TEST_API_URL: api.url } });
      expect(r.code, r.out).toBe(0);
      const logins = api.hits.filter(h => h.method === 'POST' && h.url === '/api/auth/login');
      expect(logins, 'one login for alex (session + token share it) and one for nalin').toHaveLength(2);
    } finally { await api.close(); }
  });

  test('under CI=1 the config forbids test.only and reports through list, github, junit (test-results/junit.xml) and html', async () => {
    const spec =
      "import { test, expect } from '@playwright/test';\n" +
      `import cfg from '${abs('playwright.config')}';\n` +
      "test('ci settings', () => {\n" +
      "  expect(cfg.forbidOnly).toBe(true);\n" +
      "  const reporters = cfg.reporter as unknown as [string, any?][];\n" +
      "  expect(reporters.map(r => r[0]).sort()).toEqual(['github', 'html', 'junit', 'list']);\n" +
      "  expect(reporters.find(r => r[0] === 'junit')![1].outputFile).toBe('test-results/junit.xml');\n" +
      "  expect(reporters.find(r => r[0] === 'html')![1]).toMatchObject({ open: 'never' });\n" +
      "});\n";
    const r = await runProbe({ spec, globalSetup: false, env: { CI: '1', TEST_API_URL: 'http://localhost:4000' } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/1 passed/);
  });
});
