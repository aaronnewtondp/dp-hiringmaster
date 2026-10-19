/**
 * Playwright globalSetup — runs ONCE before all tests.
 *
 * Logs in every test user and writes their JWT tokens to .auth/tokens.json.
 * All worker processes read from this file instead of calling /api/auth/login,
 * so the rate-limiter (20 logins / 15 min in production) is never triggered
 * regardless of how many test files run.
 */
import { request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { isLocalTarget, loadSmokeEnv } from './smoke-env';

const BASE = process.env.TEST_API_URL || 'http://localhost:4000';

loadSmokeEnv();

// Local Docker: the seeded users. Production: seeded users cannot sign in (every production account is Google-only), so the
// suite uses the two dedicated read-only smoke accounts instead — see helpers/smoke-env.ts.
const LOCAL_USERS: Record<string, { email: string; password: string }> = {
  hr:          { email: 'aaron.newton@digitalpaani.com', password: 'password123' },
  hr2:         { email: 'garima@digitalpaani.com',       password: 'password123' },
  hm_alex:     { email: 'alex@digitalpaani.com',         password: 'password123' },
  hm_satyadev: { email: 'satyadev@digitalpaani.com',     password: 'password123' },
  leadership:  { email: 'nalin@digitalpaani.com',        password: 'password123' },
};
const SMOKE_USERS: Record<string, { email: string; password: string }> = {
  smoke_lead: { email: process.env.SMOKE_LEADERSHIP_EMAIL ?? '', password: process.env.SMOKE_LEADERSHIP_PASSWORD ?? '' },
  smoke_hm:   { email: process.env.SMOKE_HM_EMAIL ?? '',         password: process.env.SMOKE_HM_PASSWORD ?? '' },
};
const TEST_USERS = isLocalTarget(BASE) ? LOCAL_USERS : SMOKE_USERS;

export default async function globalSetup() {
  const authDir = path.join(process.cwd(), '.auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const apiContext = await request.newContext({ baseURL: BASE });
  const tokens: Record<string, string> = {};
  const failed: string[] = [];

  console.log(`\n[global-setup] Pre-authenticating test users against ${BASE}`);

  for (const [key, cred] of Object.entries(TEST_USERS)) {
    if (!cred.email || !cred.password) {
      failed.push(`${key}: no credentials configured`);
      console.error(`  ✗ ${key} — not configured: put SMOKE_* in hms-tests-final/.env.smoke.local (see README)`);
      continue;
    }
    try {
      const res  = await apiContext.post('/api/auth/login', {
        data: { email: cred.email, password: cred.password },
      });
      const text = await res.text();
      const body = JSON.parse(text);
      if (body.token) {
        tokens[key] = body.token;
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

  await apiContext.dispose();
  fs.writeFileSync(path.join(authDir, 'tokens.json'), JSON.stringify(tokens, null, 2));

  if (failed.length) {
    console.warn(`[global-setup] ⚠ Failed to auth ${failed.length} user(s).`);
  } else {
    console.log(`[global-setup] ✓ All ${Object.keys(tokens).length} tokens cached → .auth/tokens.json\n`);
  }
}
