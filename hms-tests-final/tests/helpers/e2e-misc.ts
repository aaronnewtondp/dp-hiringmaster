/**
 * Helpers for the browser specs on User Management, Help / info markers and the responsive + PWA surface
 * (tests/e2e/09-user-management, tests/e2e/13-help-and-info-markers, tests/e2e-mobile/15-responsive-and-pwa, and the Help check in
 * tests/smoke/production-ui). Kept in their own file on purpose: helpers/api.ts, e2e.ts and db.ts belong to the foundation.
 *
 * Nothing in here knows a sentence of the product: the Help page and the info-marker popovers are being reworded by another branch, so
 * these helpers only check STRUCTURE (a popover opened, it has text, the text is not leaked template syntax).
 */
import { APIRequestContext, expect, Locator, Page } from '@playwright/test';
import { FRONTEND_BASE, SessionUser } from './api';
import { withDb } from './db';

// ── Text that must never reach a user ────────────────────────────────────────────────────────────────────────────────────────────
// Unresolved template syntax ("{{x}}", "${x}") and JavaScript leftovers ("undefined", "[object Object]", "NaN") are what a broken
// string interpolation looks like on screen. The words "null" and "None" are deliberately NOT in the list: they are legitimate prose.
const LEAKS: Array<[string, RegExp]> = [
  ['{{ }} template syntax',  /\{\{|\}\}/],
  ['${ } template syntax',   /\$\{/],
  ['"undefined"',            /\bundefined\b/],
  ['"[object Object]"',      /\[object Object\]/],
  ['"NaN"',                  /\bNaN\b/],
];

/** What leaked into `text`, by name (empty when the text is clean). */
export function leakedSyntax(text: string): string[] {
  return LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Fails with the offending name and a short excerpt when `text` is empty or contains leaked template syntax. */
export function expectRealText(text: string, what: string): void {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  expect(trimmed.length, `${what}: the text is empty`).toBeGreaterThan(0);
  const leaks = leakedSyntax(trimmed);
  expect(leaks, `${what}: leaked syntax ${JSON.stringify(leaks)} in "${trimmed.slice(0, 160)}"`).toEqual([]);
}

// ── Users (direct SQL, local database only) ──────────────────────────────────────────────────────────────────────────────────────
/** The seeded super_admin: its bcrypt hash is the hash of the suite's seed password, so copying it gives another user that password. */
const SEED_HASH_SOURCE = 'superadmin@digitalpaani.com';

/**
 * Gives `email` the seed password ("password123") by copying the seeded super_admin's bcrypt hash. A user created through the
 * User Management page has NO password (every real account signs in with Google), so this is the only way to make one sign in through
 * POST /api/auth/login — exactly what the seeded fixture users do. Returns the number of rows changed (1 when the user exists).
 */
export async function giveSeedPassword(email: string): Promise<number> {
  return withDb(async db => {
    const src = await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE email = $1', [SEED_HASH_SOURCE]);
    const hash = src.rows[0]?.password_hash;
    if (!hash) throw new Error(`the seeded user ${SEED_HASH_SOURCE} has no password hash: is the database seeded?`);
    const res = await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email]);
    return res.rowCount ?? 0;
  });
}

export interface UserRow {
  id: string; name: string; email: string; persona: string; department: string | null; is_active: boolean;
  has_password: boolean; auth_provider: string | null;
}

export async function userRowByEmail(email: string): Promise<UserRow | null> {
  return withDb(async db => {
    const r = await db.query<UserRow>(
      `SELECT id, name, email, persona, department, is_active, (password_hash IS NOT NULL) AS has_password, auth_provider
         FROM users WHERE email = $1`, [email]);
    return r.rows[0] ?? null;
  });
}

export async function countUsers(): Promise<number> {
  return withDb(async db => Number((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n));
}

/** Removes the users a spec created (matched by their exact e-mail addresses; a spec never touches a seeded user). */
export async function deleteUsersByEmail(emails: string[]): Promise<void> {
  if (!emails.length) return;
  await withDb(db => db.query('DELETE FROM users WHERE email = ANY($1::text[])', [emails.map(e => e.toLowerCase())]));
}

/** Removes every leftover of an earlier crashed run of a spec: all users whose e-mail starts with `prefix` and ends in @example.com. */
export async function deleteUsersWithPrefix(prefix: string): Promise<void> {
  await withDb(db => db.query(`DELETE FROM users WHERE email LIKE $1 AND email LIKE '%@example.com'`, [`${prefix.toLowerCase()}%`]));
}

// ── Signing in as a user that is NOT one of the seeded fixtures ─────────────────────────────────────────────────────────────────
/** Puts a session obtained from POST /api/auth/login into the app's localStorage and opens `path` (loginViaApi only knows the seeded keys). */
export async function openWithSession(page: Page, session: { token: string; user: SessionUser }, path: string): Promise<void> {
  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(user));
    sessionStorage.clear();
  }, session);
  await page.goto(`${FRONTEND_BASE}${path}`);
}

// ── Info markers (components/shared/InfoTooltip.tsx) ────────────────────────────────────────────────────────────────────────────
/** Every "i" marker under `scope`: a <button aria-label="More info">. */
export const infoMarkers = (scope: Page | Locator): Locator => scope.getByRole('button', { name: 'More info', exact: true });

/** The popover a marker opens: the <div> right after its button (it exists only while the popover is open). */
export const markerPopover = (marker: Locator): Locator => marker.locator('xpath=following-sibling::div');

/**
 * Opens one marker the way a mouse user does (hover), returns the popover's text and moves the mouse away again, asserting the popover
 * closes. Throws a descriptive error when no popover opens.
 */
export async function readMarkerByHover(page: Page, marker: Locator, what: string): Promise<string> {
  await marker.scrollIntoViewIfNeeded();
  await marker.hover();
  const popover = markerPopover(marker);
  await expect(popover, `${what}: hovering the marker did not open a popover`).toBeVisible();
  const text = await popover.innerText();
  await page.mouse.move(0, 0);
  await expect(popover, `${what}: the popover stayed open after the mouse left`).toHaveCount(0);
  return text;
}

// ── Production build vs dev server ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Which frontend is being tested: the Vite DEV server (index.html loads /src/main.tsx and the /@vite/client) or a PRODUCTION BUILD
 * (`bash scripts/test-stack.sh preview N`, or a deployment: index.html loads a hashed /assets/index-*.js). The service worker, the
 * manifest and the precache exist only in a production build — dev mode registers none (frontend/vite.config.ts has no devOptions).
 * Decided from index.html alone, never from /sw.js: in a production build that has LOST its PWA plugin /sw.js answers with the app
 * shell, and a check that skipped "because there is no /sw.js" would hide exactly that regression.
 */
export async function frontendBuild(request: APIRequestContext): Promise<'production' | 'dev'> {
  const res = await request.get(`${FRONTEND_BASE}/`);
  expect(res.ok(), `GET ${FRONTEND_BASE}/ answered ${res.status()}: is the frontend running?`).toBe(true);
  const html = await res.text();
  if (/\/@vite\/client|\/src\/main\.tsx/.test(html)) return 'dev';
  expect(html, 'index.html is neither the dev server\'s nor a production build\'s').toMatch(/\/assets\/index-[\w-]+\.js/);
  return 'production';
}

export const NEEDS_PREVIEW = 'needs the production build of the frontend: bash scripts/test-stack.sh preview <N> (the dev server registers no service worker)';

// ── Service worker ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Waits (bounded) until the page's service worker is registered, ACTIVE and CONTROLLING this page, and fails with a clear message when it
 * never gets there: registration is asynchronous (main.tsx registers it after the load event), so a test must wait for it rather than assume.
 */
export async function waitForServiceWorkerControl(page: Page, timeoutMs = 20_000): Promise<{ scriptURL: string }> {
  const state = await page.evaluate(async (ms: number) => {
    if (!('serviceWorker' in navigator)) return { ok: false, why: 'this browser context has no serviceWorker API (is the context blocking service workers?)' };
    const timeout = new Promise<{ ok: false; why: string }>(r => setTimeout(() => r({ ok: false, why: `no active service worker within ${ms} ms (navigator.serviceWorker.ready never resolved)` }), ms));
    const ready = navigator.serviceWorker.ready.then(async reg => {
      const deadline = Date.now() + ms;
      while (!navigator.serviceWorker.controller && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));   // clientsClaim() takes control a moment after activation
      return navigator.serviceWorker.controller
        ? { ok: true as const, scriptURL: navigator.serviceWorker.controller.scriptURL, why: '' }
        : { ok: false as const, why: `the service worker is active (${reg.active?.scriptURL ?? '?'}) but never took control of the page` };
    });
    return Promise.race([ready, timeout]);
  }, timeoutMs);
  if (!state.ok) throw new Error(`Service worker: ${state.why}`);
  return { scriptURL: (state as { scriptURL: string }).scriptURL };
}

/** PNG width and height from the IHDR chunk (bytes 16-23), or null when `buf` is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
