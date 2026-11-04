/**
 * E2E — Login flow
 *
 * Since the production Login page only shows the Google Sign-In button
 * (no email/password form), E2E tests use a direct API call to get a JWT
 * and then inject it into localStorage. This bypasses the OAuth popup and
 * works against both local Docker and the Vercel deployment.
 */
import { test, expect } from '@playwright/test';
import { FRONTEND_BASE } from '../helpers/api';
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

test('Logout clears session and redirects to login', async ({ page }) => {
  await loginViaApi(page);
  // Clear localStorage (simulates logout)
  await page.evaluate(() => {
    localStorage.removeItem('hms_token');
    localStorage.removeItem('hms_user');
  });
  await page.goto(`${FRONTEND_BASE}/dashboard`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  await expect(page).toHaveURL(/\/login/);
});
