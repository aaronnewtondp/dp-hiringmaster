/**
 * Shared browser helpers for the e2e (and e2e-mobile) projects.
 *
 * The production Login page only offers the Google button, so a browser session is built the way the app itself would after a sign-in:
 * `hms_token` and `hms_user` in localStorage (frontend/src/contexts/AuthContext.tsx `applySession`; services/api.ts reads `hms_token` for the
 * Authorization header and clears both on a 401). The token and user record come from globalSetup's cache (.auth/tokens.json and
 * .auth/users.json), so no test pays for, or rate-limits, a login of its own.
 *
 *   await loginViaApi(page);                       // hr, lands on /dashboard (waits for it) — the old per-file behaviour
 *   await loginViaApi(page, 'hm_alex', '/roles');  // a path may be given positionally ...
 *   await gotoAs(page, 'leadership', '/my-tasks'); // ... or with gotoAs, which never waits for a URL (the app may redirect)
 *
 *   const pageErrors = expectNoPageErrors(page);   // attach BEFORE the first navigation, or load-time errors are missed
 *   await gotoAs(page, 'hr', '/dashboard');
 *   pageErrors.check();                            // fails the test when the page threw
 */
import { expect, Page } from '@playwright/test';
import { FRONTEND_BASE, getSession, USERS } from './api';

export type E2EUserKey = keyof typeof USERS;

export interface LoginOptions {
  /** Where to land after signing in. Default '/dashboard'. */
  path?: string;
  /**
   * URL to wait for after the final navigation. Default: /\/dashboard/ when the path is '/dashboard', otherwise no wait (many paths
   * redirect by design: a Hiring Manager on /users, the old /dashboard?sourcing_role links). `false` never waits.
   */
  waitForUrl?: RegExp | false;
  /** Clear sessionStorage too, as a fresh sign-in has none (the Sourcing page remembers its role there). Default true. */
  clearSessionStorage?: boolean;
}

/**
 * Sign in as a seeded user without touching the Login page: put the session in localStorage, then open `path`.
 * The first navigation (the app root) only exists to get onto the app's origin, where localStorage lives.
 */
export async function loginViaApi(page: Page, userKey: E2EUserKey = 'hr', opts: string | LoginOptions = {}): Promise<void> {
  const o: LoginOptions = typeof opts === 'string' ? { path: opts } : opts;
  const path = o.path ?? '/dashboard';
  const { token, user } = await getSession(page.request, userKey);

  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, user, clear }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(user));
    if (clear) sessionStorage.clear();
  }, { token, user, clear: o.clearSessionStorage !== false });

  await page.goto(`${FRONTEND_BASE}${path}`);
  const wait = o.waitForUrl === undefined ? (path === '/dashboard' ? /\/dashboard/ : false) : o.waitForUrl;
  if (wait) await page.waitForURL(wait, { timeout: 15_000 });
}

/** Sign in as `userKey` and open `path`. Never waits for a particular URL: the app may redirect (persona gates, legacy links). */
export async function gotoAs(page: Page, userKey: E2EUserKey, path: string): Promise<void> {
  await loginViaApi(page, userKey, { path, waitForUrl: false });
}

// ── Page errors ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Browser-extension noise that is not the app's: never counted.
const DEFAULT_IGNORED = [/FrameDoesNotExistError/, /extension/i];

export interface PageErrorWatch {
  /** Uncaught exceptions (and, when asked, console.error messages) seen since the watch was attached. */
  errors: string[];
  /** Fails the current test when any were seen. */
  check(): void;
}

/**
 * Starts listening for uncaught page exceptions NOW. Call it before the first `page.goto` (or `loginViaApi` / `gotoAs`): a listener added
 * after the page has loaded never sees what the load threw, which made the old "loads without errors" test vacuous.
 * `consoleErrors: true` also collects `console.error` output (noisy: failed requests and 401s are logged there), so it is off by default.
 */
export function expectNoPageErrors(page: Page, opts: { ignore?: RegExp[]; consoleErrors?: boolean } = {}): PageErrorWatch {
  const ignored = [...DEFAULT_IGNORED, ...(opts.ignore ?? [])];
  const errors: string[] = [];
  const record = (text: string) => { if (!ignored.some(re => re.test(text))) errors.push(text); };
  page.on('pageerror', e => record(`pageerror: ${e.message}`));
  if (opts.consoleErrors) page.on('console', m => { if (m.type() === 'error') record(`console.error: ${m.text()}`); });
  return {
    errors,
    check() { expect(errors, 'the page threw uncaught errors').toEqual([]); },
  };
}
