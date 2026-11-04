/**
 * The browser side of the test infrastructure: helpers/e2e.ts (loginViaApi, gotoAs, expectNoPageErrors) and the e2e project's browser
 * settings (hermetic network, pinned time zone). The pure helpers are pinned by tests/api/00-test-infrastructure.spec.ts.
 */
import { test, expect, Page } from '@playwright/test';
import { FRONTEND_BASE, USERS, getToken } from '../helpers/api';
import { futureDateOnly } from '../helpers/dates';
import { expectNoPageErrors, gotoAs, loginViaApi } from '../helpers/e2e';

const stored = (page: Page) => page.evaluate(() => ({
  token: localStorage.getItem('hms_token'),
  user: JSON.parse(localStorage.getItem('hms_user') || 'null'),
}));

test.describe('loginViaApi / gotoAs', () => {
  test('default: hr signs in from the cached session and lands on /dashboard; the app holds exactly the cached token and user record', async ({ page, request }) => {
    await loginViaApi(page);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    const s = await stored(page);
    expect(s.token).toBe(await getToken(request, 'hr'));
    expect(s.user).toMatchObject({ email: USERS.hr.email, persona: 'hr_recruiter' });
  });

  test('a path may be given positionally or through gotoAs; the persona of the stored user follows the key', async ({ page }) => {
    await loginViaApi(page, 'hm_alex', '/roles');
    await expect(page).toHaveURL(/\/roles$/);
    expect((await stored(page)).user).toMatchObject({ email: USERS.hm_alex.email, persona: 'hiring_manager' });

    await gotoAs(page, 'super_admin', '/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await stored(page)).user).toMatchObject({ email: USERS.super_admin.email, persona: 'super_admin' });

    await gotoAs(page, 'leadership', '/candidates');
    await expect(page).toHaveURL(/\/candidates$/);
    expect((await stored(page)).user.persona).toBe('leadership');
  });

  test('gotoAs does not wait for a URL: a path the app redirects away from does not fail the helper', async ({ page }) => {
    await gotoAs(page, 'hm_alex', '/users');                 // Super-Admin only: everyone else is bounced to /dashboard
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('a fresh sign-in clears sessionStorage by default and keeps it with clearSessionStorage: false', async ({ page }) => {
    await page.goto(FRONTEND_BASE);
    await page.evaluate(() => sessionStorage.setItem('hms:selftest', 'left over'));
    await loginViaApi(page);
    expect(await page.evaluate(() => sessionStorage.getItem('hms:selftest'))).toBeNull();

    await page.evaluate(() => sessionStorage.setItem('hms:selftest', 'kept'));
    await loginViaApi(page, 'hr', { clearSessionStorage: false });
    expect(await page.evaluate(() => sessionStorage.getItem('hms:selftest'))).toBe('kept');
  });

  test('waitForUrl: an explicit pattern is awaited (and a pattern that never matches fails the helper after waitTimeoutMs), false is not', async ({ page }) => {
    await loginViaApi(page, 'hr', { path: '/candidates', waitForUrl: /\/candidates$/ });
    await expect(page).toHaveURL(/\/candidates$/);
    await loginViaApi(page, 'hr', { path: '/roles', waitForUrl: false });
    await expect(page).toHaveURL(/\/roles$/);

    const started = Date.now();
    await expect(loginViaApi(page, 'hr', { path: '/roles', waitForUrl: /\/never-there$/, waitTimeoutMs: 800 })).rejects.toThrow();
    expect(Date.now() - started, 'the wait is bounded by waitTimeoutMs, not the 15 s default').toBeLessThan(12_000);
  });

  test('gotoAs never waits for a URL: a path that does not end on /dashboard returns at once', async ({ page }) => {
    const started = Date.now();
    await gotoAs(page, 'super_admin', '/users');
    await expect(page).toHaveURL(/\/users$/);
    expect(Date.now() - started, 'a wait for /dashboard would have burnt the 15 s default').toBeLessThan(12_000);
  });
});

test.describe('expectNoPageErrors', () => {
  const origin = new URL(FRONTEND_BASE).origin;
  const html = (script: string) => `<!doctype html><title>selftest</title><script>${script}</script><body>ok</body>`;

  test('attached before the first navigation it sees what the page throws WHILE LOADING, and check() fails the test', async ({ page }) => {
    await page.route(`${origin}/__selftest/load-error`, r => r.fulfill({ contentType: 'text/html', body: html('throw new Error("load-time boom")') }));
    const watch = expectNoPageErrors(page);
    await page.goto(`${origin}/__selftest/load-error`);
    expect(watch.errors).toHaveLength(1);
    expect(watch.errors[0]).toContain('load-time boom');
    expect(() => watch.check()).toThrow();
  });

  test('a later error is seen too; a clean app page passes check()', async ({ page }) => {
    const clean = expectNoPageErrors(page);
    await loginViaApi(page, 'hr', '/dashboard');
    clean.check();

    const later = expectNoPageErrors(page);
    await page.evaluate(() => { setTimeout(() => { throw new Error('async boom'); }, 0); });
    await expect.poll(() => later.errors.length).toBe(1);
    expect(later.errors[0]).toContain('async boom');
  });

  test('browser-extension noise and caller-supplied patterns are ignored; console errors only count when asked for', async ({ page }) => {
    await page.route(`${origin}/__selftest/noise`, r => r.fulfill({
      contentType: 'text/html',
      body: html('setTimeout(()=>{ throw new Error("FrameDoesNotExistError: gone") },0); setTimeout(()=>{ throw new Error("benign vendor widget") },0); console.error("logged only")'),
    }));
    const quiet = expectNoPageErrors(page, { ignore: [/benign vendor widget/] });
    const loud = expectNoPageErrors(page, { consoleErrors: true });
    await page.goto(`${origin}/__selftest/noise`);
    await expect.poll(() => loud.errors.length).toBeGreaterThanOrEqual(2);   // the benign throw and the console.error; the extension one never counts
    quiet.check();
    expect(loud.errors.some(e => e.includes('console.error: logged only'))).toBe(true);
    expect(loud.errors.some(e => e.includes('FrameDoesNotExistError'))).toBe(false);
  });
});

test.describe('the e2e project\'s browser is hermetic and runs in IST', () => {
  test.skip(!!process.env.PW_ALLOW_EXTERNAL_HOSTS, 'PW_ALLOW_EXTERNAL_HOSTS=1 turns the hermetic network off on purpose');

  test('a request to any non-local host fails at once with net::ERR_NAME_NOT_RESOLVED instead of stalling the load event; localhost works', async ({ page }) => {
    const failed: Record<string, string> = {};
    page.on('requestfailed', r => { failed[new URL(r.url()).host] = r.failure()?.errorText ?? ''; });
    const started = Date.now();
    await page.goto(`${FRONTEND_BASE}/login`);
    await expect(page.locator('body')).toContainText('DigitalPaani');   // the app itself (a local host) is unaffected

    // A probe that does not depend on what frontend/index.html happens to load today (Google Fonts and the Google Identity script as of now):
    // example.com is a real, resolvable host, so only the host-resolver rule can make this fail, and make it fail immediately.
    const probe = await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'loaded', (e: Error) => `blocked: ${e.message}`));
    expect(probe).toMatch(/^blocked: /);
    expect(failed['example.com']).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(Date.now() - started, 'the load event and the probe must not wait for external hosts').toBeLessThan(15_000);
    expect(Object.keys(failed).filter(h => /^(localhost|127\.0\.0\.1)(:|$)/.test(h))).toEqual([]);
    for (const [host, why] of Object.entries(failed)) expect(why, `${host} must fail by name resolution, not by a timeout`).toBe('net::ERR_NAME_NOT_RESOLVED');
  });

  test('the browser time zone is Asia/Kolkata, so a datetime-local value of 11:00 is the instant 05:30Z on that same date (the assumption of e2e/06)', async ({ page }) => {
    await page.goto(`${FRONTEND_BASE}/login`);
    // ICU reports the canonical id, which for India is the old spelling "Asia/Calcutta"
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));
    const day = futureDateOnly(30, { offset: '+05:30' });   // computed from the real clock: the zone has no DST, so any date proves the offset
    expect(await page.evaluate(d => new Date(`${d}T11:00`).toISOString(), day)).toBe(`${day}T05:30:00.000Z`);
  });
});
