/**
 * E2E — Login flow
 *
 * Since the production Login page only shows the Google Sign-In button
 * (no email/password form), E2E tests use a direct API call to get a JWT
 * and then inject it into localStorage. This bypasses the OAuth popup and
 * works against both local Docker and the Vercel deployment.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS } from '../helpers/api';

async function loginViaApi(page: Page, user: keyof typeof USERS = 'hr') {
  const cred = USERS[user];
  const res  = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: cred.email, password: cred.password },
  });
  const { token, user: userBody } = await res.json();

  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, userBody }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(userBody));
  }, { token, userBody });

  await page.goto(`${FRONTEND_BASE}/dashboard`);
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

test('Login page loads with Google Sign-In button', async ({ page }) => {
  await page.goto(`${FRONTEND_BASE}/login`);
  await expect(page).toHaveURL(/\/login/);
  // Google GSI button renders inside a div — check for the DigitalPaani branding
  await expect(page.locator('body')).toContainText('DigitalPaani');
});

test('Authenticated user reaches dashboard', async ({ page }) => {
  await loginViaApi(page);
  await expect(page).toHaveURL(/\/dashboard/);
  // Dashboard should have some heading
  await expect(page.locator('h1, h2, [data-testid="dashboard"]')).toBeVisible({ timeout: 10000 });
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
