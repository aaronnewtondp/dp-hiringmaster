/**
 * E2E — Phase 3 JD generation flow
 *
 * Role created via API → HR approves it via the UI's "Change status" modal
 * → backend fires an async, non-blocking JD generation job (real Claude call
 * + long-form/social PDF render + Drive upload — see roles.ts's PATCH
 * /api/roles/:id handler) → the role's "Links & Assets" card should
 * eventually show a real Drive link once generation completes.
 *
 * This is a genuinely slow test (external Claude API + PDF render + Drive
 * upload round trip) — generous timeouts throughout are intentional, not a
 * smell.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS, getToken, authed, uid, pollUntil } from '../helpers/api';

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

test.describe('JD Generation E2E', () => {

  test('Approving a role generates a JD and a Drive link appears on the role page', async ({ page, request }) => {
    // Real Claude call + PDF render + Drive upload — give this room to breathe.
    test.setTimeout(150_000);

    // ─── Create a fresh role via the API (HR) ──────────────────────────────
    // Faster and more focused than creating via the UI, which isn't what's
    // under test here. Fill in enough real content (job_description,
    // must_have_skills, etc.) so the Claude-generated JD content has
    // something substantive to condense.
    const token = await getToken(request, 'hr');
    const title = `Test JD Role ${uid()}`;
    const createRes = await authed(request, token).post('/api/roles', {
      title,
      priority:            'P2',
      department:          'Engineering',
      location:            'Bengaluru',
      employment_type:     'Full-time',
      yoe_required:        '3-5 years',
      job_description:     "Own backend services powering DigitalPaani's water quality monitoring platform, from API design through production rollout.",
      must_have_skills:    'Node.js, TypeScript, PostgreSQL, REST API design',
      nice_to_have_skills: 'AWS, Docker, CI/CD pipelines',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();
    expect(role.status).toBe('Draft');
    expect(role.jd_drive_link).toBeFalsy();

    // ─── Log in via API-token injection, go to the role detail page ───────
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/${role.id}`);
    await expect(page.locator('h1')).toContainText(title, { timeout: 15000 });

    // ─── Change status to Approved via the "Change status" modal ──────────
    await page.getByRole('button', { name: 'Change status' }).click();
    await expect(page.getByRole('heading', { name: 'Update status' })).toBeVisible();
    await page.locator('select').selectOption('Approved');
    await page.getByRole('button', { name: 'Update' }).click();

    // Modal closes once the PATCH resolves and the role query is invalidated
    await expect(page.getByRole('heading', { name: 'Update status' })).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('body')).toContainText('Approved', { timeout: 15000 });

    // ─── Poll for the generated JD Drive link to appear ────────────────────
    // JD generation is fire-and-forget on the backend (setImmediate in
    // roles.ts) — nothing in the PATCH response to await, so poll the page
    // instead. The "Links & Assets" card shows a "Generating JD…" spinner
    // in place of the Long-form JD field until jd_drive_link is set, then
    // renders it as a real <a> link (EditableSection's `linkify` mode).
    const jdRow  = page.getByText('Long-form JD', { exact: true }).locator('..');
    const jdLink = jdRow.locator('a');

    await pollUntil(
      async () => {
        const visible = await jdLink.isVisible().catch(() => false);
        if (!visible) await page.reload();
        return visible;
      },
      (visible) => visible === true,
      { timeoutMs: 90_000, intervalMs: 5_000 }
    );

    await expect(jdLink).toBeVisible({ timeout: 15_000 });
    const href = await jdLink.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href!.startsWith('https://')).toBe(true);
  });
});
