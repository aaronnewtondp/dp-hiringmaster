/**
 * E2E — Login flow
 *
 * Since the production Login page only shows the Google Sign-In button
 * (no email/password form), E2E tests use a direct API call to get a JWT
 * and then inject it into localStorage. This bypasses the OAuth popup and
 * works against both local Docker and the Vercel deployment.
 */
import { test, expect } from '@playwright/test';
import { FRONTEND_BASE, USERS } from '../helpers/api';
import { loginViaApi } from '../helpers/e2e';

test('Login page loads with Google Sign-In button', async ({ page }) => {
  await page.goto(`${FRONTEND_BASE}/login`);
  await expect(page).toHaveURL(/\/login/);
  // Google GSI button renders inside a div — check for the DigitalPaani branding
  await expect(page.locator('body')).toContainText('DigitalPaani');
});

test('Authenticated user reaches dashboard', async ({ page }) => {
  await loginViaApi(page);
  await expect(page).toHaveURL(/\/dashboard/);
  // Dashboard renders several headings (page h1 + per-card h2s) — assert the
  // page-level h1 specifically rather than a locator that matches all of them.
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 10000 });
});

test('Unauthenticated user is redirected to login', async ({ page }) => {
  await page.goto(`${FRONTEND_BASE}/dashboard`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  await expect(page).toHaveURL(/\/login/);
});

test('Sign out ends the session: the sidebar button clears the stored session and returns to the login page', async ({ page }) => {
  await loginViaApi(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 10000 });
  const stored = () => page.evaluate(() => ({ token: localStorage.getItem('hms_token'), user: localStorage.getItem('hms_user') }));
  const before = await stored();
  expect(before.token).toBeTruthy();                                   // there is a session to end ...
  expect(JSON.parse(before.user!).email).toBe(USERS.hr.email);
  await expect(page.locator('aside')).toContainText('Aaron Newton');   // ... and the sidebar shows whose it is

  // The app's own control (the sidebar's "Sign out"), not a hand-made localStorage wipe.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  expect(await stored()).toEqual({ token: null, user: null });

  // Protected pages stay out of reach: a fresh visit and a reload both end on the login page.
  await page.goto(`${FRONTEND_BASE}/dashboard`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('aside')).toHaveCount(0);                  // no app chrome without a session
});
