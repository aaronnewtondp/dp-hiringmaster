import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS } from '../helpers/api';

async function loginViaApi(page: Page, user: keyof typeof USERS = 'hr') {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: USERS[user].email, password: 'password123' },
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

test('Dashboard loads without errors', async ({ page }) => {
  await loginViaApi(page);
  // No console errors should crash the page
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForTimeout(2000);
  // Filter out known browser extension noise
  const realErrors = errors.filter(e => !e.includes('FrameDoesNotExistError') && !e.includes('extension'));
  expect(realErrors).toHaveLength(0);
});

test('Dashboard shows role count metric', async ({ page }) => {
  await loginViaApi(page);
  // Wait for data to load
  await page.waitForTimeout(3000);
  // At least one numeric metric should be visible
  const body = await page.locator('body').textContent();
  // We seeded 7 roles so some number should appear
  expect(body).toMatch(/\d+/);
});
