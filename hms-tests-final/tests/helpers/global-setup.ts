/**
 * Playwright globalSetup — runs ONCE per `playwright test` invocation (not once per project).
 *
 * LOCAL target (TEST_API_URL on localhost / 127.0.0.1):
 *   1. GET /health — the whole run is aborted with a clear message when the API is unreachable (instead of ~700 confusing failures);
 *   2. logs in every seeded user and THROWS when any login fails (a seeded user that cannot sign in means a wrong or half-seeded database);
 *   3. writes the JWTs to .auth/tokens.json and the matching `user` records to .auth/users.json, so no test needs a login of its own
 *      (the production rate limiter is 20 logins / 15 min) and a browser session can be built from the cache (helpers/e2e.ts);
 *   4. warms GET /api/dashboard once with a 120 s budget: the SLA sweep is compute-on-read, and the first call after a quiet spell
 *      took 25-30 s on a big database — without this, whichever test lands first pays for it and times out.
 *
 * NON-LOCAL target (production smoke run): unchanged behaviour — only the two read-only smoke accounts (helpers/smoke-env.ts) are used and
 * a failed login is a warning — but the run throws when NO token at all was obtained. No health check and no warm-up there.
 */
import { request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { isLocalTarget, loadSmokeEnv } from './smoke-env';
import { USERS, withConnectionRetry } from './api';

const BASE = process.env.TEST_API_URL || 'http://localhost:4000';

loadSmokeEnv();

const HEALTH_WAIT_MS = 10_000;     // tolerates a backend that is still starting (tsx takes a few seconds)
const WARM_BUDGET_MS = 120_000;

type Cred = { email: string; password: string };

// Local Docker: the seeded users (helpers/api.ts USERS is the single list; seed.sql is the source of truth). Production: seeded users
// cannot sign in (every production account is Google-only), so the suite uses the two dedicated read-only smoke accounts instead.
const LOCAL_USERS: Record<string, Cred> = Object.fromEntries(
  Object.entries(USERS).map(([key, u]) => [key, { email: u.email, password: u.password }]),
);
const SMOKE_USERS: Record<string, Cred> = {
  smoke_lead: { email: process.env.SMOKE_LEADERSHIP_EMAIL ?? '', password: process.env.SMOKE_LEADERSHIP_PASSWORD ?? '' },
  smoke_hm:   { email: process.env.SMOKE_HM_EMAIL ?? '',         password: process.env.SMOKE_HM_PASSWORD ?? '' },
};

async function waitForHealth(): Promise<void> {
  const ctx = await request.newContext({ baseURL: BASE });
  const started = Date.now();
  let last = 'no answer';
  try {
    for (;;) {
      try {
        const res = await ctx.get('/health', { timeout: 5_000 });
        if (res.ok()) return;
        last = `HTTP ${res.status()}`;
      } catch (err) {
        last = String(err).split('\n')[0];
      }
      if (Date.now() - started > HEALTH_WAIT_MS) break;
      await new Promise(r => setTimeout(r, 1_000));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(
    `[global-setup] The API at ${BASE} is not reachable (GET /health: ${last}).\n` +
    `  Start a stack and export its URLs:   bash scripts/test-stack.sh up <N>   then   eval "$(bash scripts/test-stack.sh env <N>)"\n` +
    `  or the developer stack:              docker-compose up -d   (API on :4000)\n` +
    `  Nothing was run.`);
}

export default async function globalSetup() {
  const local = isLocalTarget(BASE);
  if (local) await waitForHealth();

  const authDir = path.join(process.cwd(), '.auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const TEST_USERS = local ? LOCAL_USERS : SMOKE_USERS;
  const apiContext = await request.newContext({ baseURL: BASE });
  const tokens: Record<string, string> = {};
  const users: Record<string, unknown> = {};
  const failed: string[] = [];

  console.log(`\n[global-setup] Pre-authenticating test users against ${BASE}`);

  for (const [key, cred] of Object.entries(TEST_USERS)) {
    if (!cred.email || !cred.password) {
      failed.push(`${key}: no credentials configured`);
      console.error(`  ✗ ${key} — not configured: put SMOKE_* in hms-tests-final/.env.smoke.local (see README)`);
      continue;
    }
    try {
      const res  = await withConnectionRetry(() => apiContext.post('/api/auth/login', {
        data: { email: cred.email, password: cred.password },
      }));
      const text = await res.text();
      const body = JSON.parse(text);
      if (body.token) {
        tokens[key] = body.token;
        if (body.user) users[key] = body.user;
        console.log(`  ✓ ${cred.email}`);
      } else {
        failed.push(`${key}: ${text.slice(0, 120)}`);
        console.error(`  ✗ ${cred.email} — ${text.slice(0, 120)}`);
      }
    } catch (err) {
      failed.push(`${key}: ${err}`);
      console.error(`  ✗ ${cred.email} — ${err}`);
    }
  }

  fs.writeFileSync(path.join(authDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
  fs.writeFileSync(path.join(authDir, 'users.json'), JSON.stringify(users, null, 2));

  if (local && failed.length) {
    await apiContext.dispose();
    throw new Error(
      `[global-setup] ${failed.length} seeded user(s) could not sign in against ${BASE} — the database is not the seeded one ` +
      `(run: bash scripts/test-stack.sh reset <N>, or apply backend/src/db/seed.sql):\n  ${failed.join('\n  ')}`);
  }
  if (!local && Object.keys(tokens).length === 0) {
    await apiContext.dispose();
    throw new Error(`[global-setup] No token was obtained from ${BASE}: ${failed.join('; ') || 'no accounts configured'}`);
  }

  if (failed.length) {
    console.warn(`[global-setup] ⚠ Failed to auth ${failed.length} user(s).`);
  } else {
    console.log(`[global-setup] ✓ All ${Object.keys(tokens).length} tokens cached → .auth/tokens.json\n`);
  }

  if (local && tokens.hr) {
    const started = Date.now();
    try {
      const res = await apiContext.get('/api/dashboard', { headers: { Authorization: `Bearer ${tokens.hr}` }, timeout: WARM_BUDGET_MS });
      console.log(`[global-setup] dashboard warmed (HTTP ${res.status()}, ${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
    } catch (err) {
      // not fatal: the tests that need the dashboard will say what is wrong
      console.warn(`[global-setup] ⚠ dashboard warm-up failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${String(err).split('\n')[0]}\n`);
    }
  }

  await apiContext.dispose();
}
