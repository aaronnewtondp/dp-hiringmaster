/**
 * E2E — Unmatched Candidates panel + "Link to role" modal (Candidates page)
 *
 * Candidates ingested via the Job Application Form webhook whose stated
 * "role applying for" didn't match any open role land with zero
 * applications (candidateIngest.ts leaves `application: null`) — the main
 * Candidates table is application-row driven, so these candidates would
 * otherwise be invisible. Candidates.tsx surfaces them separately in the
 * merged "Unmatched Candidates" panel (2026-09-05 — used to be two separate
 * panels, "Unlinked candidates" and "Unmatched role submissions") with a
 * per-row "Link to role" action that opens a modal to attach them to a real
 * role. This spec covers the full browser flow: panel visibility, opening
 * the modal, submitting a link, and the candidate dropping out of the list
 * afterward.
 */
import { test, expect } from '@playwright/test';
import { BASE, SEEDED, CANDIDATE_INGEST_SECRET, uid } from '../helpers/api';
import { loginViaApi } from '../helpers/e2e';
import { Cleanup, dialogWith } from '../helpers/e2e-candidates';

test.describe('Unmatched Candidates panel + Link to role modal', () => {
  const cleanup = new Cleanup();
  test.afterAll(() => cleanup.purge());      // the candidate and the application the test links it to


  test('candidate with zero applications appears in the Unmatched Candidates panel and can be linked to a role', async ({ page }) => {
    const marker = `Unlinked E2E ${uid()}`;
    const email = `unlinked+${uid()}@example.com`;
    cleanup.email(email);

    // Seed a candidate with ZERO applications via the ingest webhook — a
    // role_applied_for that matches no real open role guarantees no
    // application gets created alongside it.
    const ingestRes = await page.request.post(`${BASE}/api/candidates/ingest`, {
      headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
      data: {
        email,
        full_name: marker,
        role_applied_for: `Nonexistent Role ${uid()}`,
      },
    });
    expect(ingestRes.status()).toBe(201);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.application).toBeNull();

    // The panel's own answer is awaited (registered BEFORE the page opens): its heading reads "(0)" while that request is still in flight, so a
    // heading check alone can pass on the loading state and then race the row below against a slow query on a large database.
    const answered = page.waitForResponse(r => r.url().includes('/api/candidates/unmatched') && r.status() === 200);
    await loginViaApi(page, 'hr', { path: '/candidates', waitForUrl: false });
    expect((await (await answered).json()).total).toBeGreaterThan(0);

    // Panel header is visible with a NON-ZERO count, but the row list below it starts collapsed by default
    // (Candidates.tsx's showUnmatched useState — 2026-09 fix) — click the header to expand before looking for this candidate's row.
    const panelHeading = page.getByRole('heading', { name: /Unmatched Candidates \([1-9]\d*\)/ });
    await expect(panelHeading).toBeVisible({ timeout: 15000 });
    await panelHeading.click();
    // The newest unmatched candidate is first in the list, but the longer timeout below covers a cold query on a big local database.
    const row = page.locator('.px-5.py-3', { hasText: marker });
    await expect(row).toBeVisible({ timeout: 30000 });

    // Open the "Link to role" modal for this candidate
    await row.getByRole('button', { name: 'Link to role' }).click();
    const modal = dialogWith(page, `Link ${marker} to a role`);
    await expect(modal.getByRole('heading', { name: `Link ${marker} to a role`, exact: true })).toBeVisible();

    // Pick a real seeded role and submit
    await modal.locator('select').selectOption(SEEDED.roles.senior_pm);
    await modal.getByRole('button', { name: 'Link', exact: true }).click();

    // Success toast (react-hot-toast) confirms the link went through. The
    // underlying POST /api/candidates/:id/applications now triggers a real,
    // synchronous ResumeIQ scoring call before responding (runResumeIQScoring,
    // called inline — see CLAUDE.md's "Pipeline stage model simplified" note)
    // where it used to return near-instantly, so the toast can now take
    // several seconds longer to appear than the original 5s budget allowed.
    await expect(page.getByText('Candidate linked to role')).toBeVisible({ timeout: 15000 });

    // Modal closes, and this candidate's row drops out of the panel
    // (or the whole panel disappears if it was the only one left)
    await expect(modal).toHaveCount(0, { timeout: 10000 });
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });
});
