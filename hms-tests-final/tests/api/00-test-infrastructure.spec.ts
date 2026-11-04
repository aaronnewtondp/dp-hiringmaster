/**
 * The test infrastructure itself: connection-level retry, the date helpers, the database-URL guards, the seeded-user session cache, the
 * stack script's argument checks and the config's "write-capable projects are local-only" rule.
 *
 * Almost all of it is pure (no HTTP): these tests exist because every other spec stands on these helpers, and a silent change in one of
 * them (a retry that also retries a 500, a date helper off by a day, a guard that lets a remote database through) would not fail anywhere else.
 * The browser-side helpers are pinned by tests/e2e/00-test-infrastructure.spec.ts.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  USERS, authed, getSession, getToken, isConnectionError, withConnectionRetry,
} from '../helpers/api';
import { futureDateOnly, futureIso, futureLocalDateTime, pastDateOnly, pastIso } from '../helpers/dates';
import { DEFAULT_TEST_DB_URL, TEST_DB_URL, resolveTestDbUrl } from '../helpers/db';

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
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('database URL guards (helpers/db.ts)', () => {
  test('default, override, and the local-host rule', () => {
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
      const db = Number(/TEST_DB_URL=postgresql:\/\/hms_user:hms_password@localhost:(\d+)\/dp_hms/.exec(r.stdout)?.[1]);
      expect([api, fe, db]).toEqual([4110 + n, 5180 + n, 55440 + n]);
      for (const p of [api, fe, db]) { expect(RESERVED, `port ${p} of stack ${n}`).not.toContain(p); ports.add(p); }
      expect(r.stdout.trim().split('\n').every(l => l.startsWith('export '))).toBe(true);
    }
    expect(ports.size).toBe(30);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
