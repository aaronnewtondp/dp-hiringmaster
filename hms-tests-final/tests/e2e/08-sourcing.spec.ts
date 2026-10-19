// Sourcing module — what only a browser can see: where the dashboard section sits, who gets the My Tasks box, the role card
// and its dialog, and the read-only Hiring Manager view. Skips itself while the module is off (SOURCING_ENABLED on the backend).
// Read-only by design: it opens dialogs but never saves, so it leaves no data behind.
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS } from '../helpers/api';

async function loginViaApi(page: Page, user: keyof typeof USERS, path: string) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email: USERS[user].email, password: 'password123' } });
  const { token, user: userBody } = await res.json();
  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, userBody }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(userBody));
    sessionStorage.clear();
  }, { token, userBody });
  await page.goto(`${FRONTEND_BASE}${path}`);
}

test.describe('Sourcing module (browser)', () => {
  test.setTimeout(90_000);                      // the first dashboard load after idle runs the whole SLA sweep (compute-on-read)

  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email, password: 'password123' } });
    const { token } = await login.json();
    const s = await request.get(`${BASE}/api/sourcing/status`, { headers: { Authorization: `Bearer ${token}` } });
    test.skip(!(s.ok() && (await s.json()).enabled === true), 'SOURCING_ENABLED is not true on the backend');
  });

  test('the dashboard section is the LAST section, below Operational velocity', async ({ page }) => {
    await loginViaApi(page, 'hr', '/dashboard');
    const sourcing = page.getByRole('heading', { name: 'Sourcing execution' });
    await expect(sourcing).toBeVisible({ timeout: 60_000 });
    const velocity = page.getByRole('heading', { name: 'Operational velocity' });
    await expect(velocity).toBeVisible();
    const [s, v] = [await sourcing.boundingBox(), await velocity.boundingBox()];
    expect(s!.y).toBeGreaterThan(v!.y);
    // nothing of the page's own heading structure follows it
    const lastHeading = await page.locator('h2').last().textContent();
    expect(['Sourcing execution', 'Exceptions']).toContain(lastHeading?.trim());
  });

  test('a recruiter gets a Sourcing box on My Tasks; opening it shows the queue (or its good empty state)', async ({ page }) => {
    await loginViaApi(page, 'hr', '/my-tasks');
    const box = page.getByRole('button', { name: /^Sourcing/ });
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.click();
    await expect(page.getByTestId('sourcing-targets').or(page.getByText('Nothing needs your attention ✓'))).toBeVisible({ timeout: 30_000 });
  });

  test('Leadership gets no Sourcing box (their box stays alerts-only)', async ({ page }) => {
    await loginViaApi(page, 'leadership', '/my-tasks');
    await expect(page.getByRole('button', { name: /Leadership Alerts|Other Pending Actions/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Sourcing/ })).toHaveCount(0);
  });

  test('a role page shows the Sourcing card, the header chip and a read-only Recruitment Mode; a dialog opens and closes with Escape', async ({ page }) => {
    await loginViaApi(page, 'hr', '/roles/R001');
    const card = page.locator('#sourcing');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole('heading', { name: 'Sourcing' })).toBeVisible();
    await expect(page.getByTestId('sourcing-chip')).toBeVisible();
    await expect(page.getByText('Recruitment Mode (managed in the Sourcing plan)')).toBeVisible();

    const activate = card.getByRole('button', { name: 'Activate plan' });
    if (await activate.count()) {
      await activate.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Activate sourcing plan' })).toBeVisible();
      await expect(dialog.getByLabel('Sourcing owner')).toHaveCount(0);                     // sourcing belongs to HR as a whole: nothing to pick
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  });

  test('the role\'s Hiring Manager sees a View-only card with no actions', async ({ page }) => {
    await loginViaApi(page, 'hm_alex', '/roles/R005');                           // R005's Hiring Manager is "Alex"
    const card = page.locator('#sourcing');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('View only')).toBeVisible();
    for (const name of [/Activate plan/, /Mark done/, /Resolve/, /Skip/, /Stop using/]) await expect(card.getByRole('button', { name })).toHaveCount(0);
  });

  test('a Hiring Manager of ANOTHER role gets no card at all', async ({ page }) => {
    await loginViaApi(page, 'hm_satyadev', '/roles/R005');                       // not Satyadev's role
    await expect(page.getByRole('heading', { name: 'Quality Assurance Engineer' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#sourcing')).toHaveCount(0);
    await expect(page.getByTestId('sourcing-chip')).toHaveCount(0);
  });
});
