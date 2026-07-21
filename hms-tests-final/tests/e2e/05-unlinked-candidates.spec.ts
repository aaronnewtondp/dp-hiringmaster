/**
 * E2E — Unlinked candidates panel + "Link to role" modal (Candidates page)
 *
 * Candidates ingested via the Job Application Form webhook whose stated
 * "role applying for" didn't match any open role land with zero
 * applications (candidateIngest.ts leaves `application: null`) — the main
 * Candidates table is application-row driven, so these candidates would
 * otherwise be invisible. Candidates.tsx surfaces them separately in an
 * "Unlinked candidates" panel with a per-row "Link to role" action that
 * opens a modal to attach them to a real role. This spec covers the full
 * browser flow: panel visibility, opening the modal, submitting a link,
 * and the candidate dropping out of the unlinked list afterward.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS, SEEDED, CANDIDATE_INGEST_SECRET, uid } from '../helpers/api';

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

test.describe('Unlinked candidates panel + Link to role modal', () => {

  test('candidate with zero applications appears in the unlinked panel and can be linked to a role', async ({ page }) => {
    const marker = `Unlinked E2E ${uid()}`;

    // Seed a candidate with ZERO applications via the ingest webhook — a
    // role_applied_for that matches no real open role guarantees no
    // application gets created alongside it.
    const ingestRes = await page.request.post(`${BASE}/api/candidates/ingest`, {
      headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
      data: {
        email: `unlinked+${uid()}@example.com`,
        full_name: marker,
        role_applied_for: `Nonexistent Role ${uid()}`,
      },
    });
    expect(ingestRes.status()).toBe(201);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.application).toBeNull();

    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/candidates`);

    // Panel is visible with a non-zero count, and this candidate is listed in it
    await expect(page.getByRole('heading', { name: /Unlinked candidates \(\d+\)/ })).toBeVisible({ timeout: 15000 });
    const row = page.locator('.px-5.py-3', { hasText: marker });
    await expect(row).toBeVisible();

    // Open the "Link to role" modal for this candidate
    await row.getByRole('button', { name: 'Link to role' }).click();
    const modal = page.locator('.fixed.inset-0');
    await expect(modal.getByRole('heading', { name: `Link ${marker} to a role`, exact: true })).toBeVisible();

    // Pick a real seeded role and submit
    await modal.locator('select').selectOption(SEEDED.roles.senior_pm);
    await modal.getByRole('button', { name: 'Link', exact: true }).click();

    // Success toast (react-hot-toast) confirms the link went through
    await expect(page.getByText('Candidate linked to role')).toBeVisible({ timeout: 5000 });

    // Modal closes, and this candidate's row drops out of the unlinked panel
    // (or the whole panel disappears if it was the only one left)
    await expect(modal).toHaveCount(0, { timeout: 10000 });
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });
});
