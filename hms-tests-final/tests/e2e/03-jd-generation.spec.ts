/**
 * E2E — Phase 3 JD generation flow
 *
 * Role created via API → HR approves it via the UI's "Change status" modal
 * → backend AWAITS JD generation inline before responding (real Claude call
 * + long-form/social PDF render + Drive upload — see roles.ts's PATCH
 * /api/roles/:id handler; this is intentionally synchronous, not
 * fire-and-forget — see CLAUDE.md's "no fire-and-forget on Vercel" rule) →
 * the PATCH request itself takes as long as generation does (~15-30s
 * observed), and only resolves — closing the modal — once the role's
 * "Links & Assets" card already has the real Drive link.
 *
 * Two tests, because generation needs two things the isolated test stack does not have (an Anthropic key and Google Drive):
 *  - the OFFLINE one runs everywhere: approving works whether or not generation can run, and the page says what the server reported — a
 *    failure with its reason, the "Generating JD…" placeholders and no Regenerate JD button, or (on a configured backend) the success path.
 *    It never waits for Claude;
 *  - the @live one (TEST_LIVE=1 and a configured backend only) is the genuinely slow one: a real Claude call, PDF render and Drive upload,
 *    generous timeouts throughout are intentional, not a smell.
 * Every role either test creates is removed afterwards.
 */
import { test, expect, Page } from '@playwright/test';
import { Client } from 'pg';
import { FRONTEND_BASE, getToken, authed, uid, pollUntil } from '../helpers/api';
import { newClient } from '../helpers/db';
import { futureDateOnly, pastDateOnly } from '../helpers/dates';
import { loginViaApi } from '../helpers/e2e';
import { purgeRolesFast } from '../helpers/sourcing-db';

let db: Client;
const roleIds: string[] = [];

test.beforeAll(async () => {
  db = newClient();
  await db.connect();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  await purgeRolesFast(db, roleIds);
  await db.end();
});

/**
 * Creates a fresh Draft role via the API (HR). Faster and more focused than creating via the UI, which isn't what's under test here.
 * Enough real content (job_description, must_have_skills, etc.) so a Claude-generated JD has something substantive to condense.
 */
async function createDraftRole(page: Page, title: string) {
  const token = await getToken(page.request, 'hr');
  const createRes = await authed(page.request, token).post('/api/roles', {
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
  roleIds.push(role.id);
  expect(role.status).toBe('Draft');
  expect(role.jd_drive_link).toBeFalsy();
  return role as { id: string; title: string };
}

/** Opens the "Change status" modal on a role page, picks Approved and presses Update. */
async function approveViaStatusModal(page: Page) {
  await page.getByRole('button', { name: 'Change status' }).click();
  await expect(page.getByRole('heading', { name: 'Update status' })).toBeVisible();
  await page.locator('select').selectOption('Approved');
  await page.getByRole('button', { name: 'Update' }).click();
}

test.describe('JD Generation E2E', () => {

  test('Approving a role approves it whether or not JD generation can run, and the page reports exactly what the server said about the JD', async ({ page }) => {
    const title = `Test JD Role Offline ${uid()}`;
    const role = await createDraftRole(page, title);

    await loginViaApi(page, 'hr', `/roles/${role.id}`);
    await expect(page.locator('h1')).toContainText(title, { timeout: 15000 });

    const answered = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith(`/roles/${role.id}`));
    await approveViaStatusModal(page);
    const res = await answered;
    expect(res.status()).toBe(200);
    const body = await res.json();
    const jd = body.jdGeneration as { generated: boolean; error?: string } | undefined;
    expect(jd, 'the Draft -> Approved transition always reports JD generation, one way or the other').toBeTruthy();

    // What approving does has nothing to do with Claude or Drive: the dialog closes, the role is Approved, and the approver is the acting user.
    await expect(page.getByRole('heading', { name: 'Update status' })).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Status updated to Approved')).toBeVisible();
    await expect(page.getByRole('heading', { name: title, level: 1 }).locator('xpath=..')).toContainText('Approved');
    const row = (await db.query(`SELECT status, approver_name, approval_date::text AS approval_date, start_date::text AS start_date, jd_drive_link FROM roles WHERE id = $1`, [role.id])).rows[0];
    expect(row.status).toBe('Approved');
    expect(row.approver_name).toBe('Aaron Newton');
    expect(row.start_date, 'Open Date copies the Approval Date the same moment').toBe(row.approval_date);
    expect([pastDateOnly(1), futureDateOnly(0), futureDateOnly(1)]).toContain(row.approval_date);                                       // today (UTC or IST), never an invented date
    const approvalCard = page.locator('div.card').filter({ has: page.getByRole('heading', { name: 'Approval', level: 2 }) });
    await expect(approvalCard).toContainText('Aaron Newton');
    const events = (await db.query(`SELECT event_type FROM activity_log WHERE role_id = $1 ORDER BY id`, [role.id])).rows.map(r => r.event_type as string);
    expect(events).toContain('Role Approved');

    if (jd!.generated) {
      // a backend with Claude and Drive configured: the success toast, and the link is on the page (the @live test below checks the link itself)
      await expect(page.getByText('Long-form and social JDs generated')).toBeVisible();
      expect(events).toContain('JD Generated');
    } else {
      // no Claude key or no Drive folder: the server gives its reason and the page shows it; nothing is half-written and nothing pretends
      expect(jd!.error).toBeTruthy();
      await expect(page.getByText(`JD generation failed: ${jd!.error}`)).toBeVisible();
      expect(row.jd_drive_link).toBeNull();
      expect(events).not.toContain('JD Generated');
      const links = page.locator('div.card').filter({ has: page.getByRole('heading', { name: 'Links & Assets', level: 2 }) });
      await expect(links.getByText('Generating JD…')).toBeVisible();                                                                    // placeholders, not links
      await expect(links.getByText('Generating social JD…')).toBeVisible();
      await expect(links.locator('a')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Regenerate JD' })).toHaveCount(0);                                                // nothing to regenerate yet
    }
  });

  test('@live Approving a role generates a JD and a Drive link appears on the role page', async ({ page }) => {
    // Real Claude call + PDF render + Drive upload — give this room to breathe.
    test.setTimeout(150_000);

    const title = `Test JD Role ${uid()}`;
    const role = await createDraftRole(page, title);

    // ─── Log in via API-token injection, go to the role detail page ───────
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/${role.id}`);
    await expect(page.locator('h1')).toContainText(title, { timeout: 15000 });

    // ─── Change status to Approved via the "Change status" modal ──────────
    await approveViaStatusModal(page);

    // Modal closes once the PATCH resolves — and since generation is awaited inline, that PATCH doesn't resolve until the real Claude call +
    // PDF renders + Drive uploads all finish (~15-30s observed).
    await expect(page.getByRole('heading', { name: 'Update status' })).not.toBeVisible({ timeout: 45_000 });
    await expect(page.locator('body')).toContainText('Approved', { timeout: 15000 });

    // ─── Confirm the generated JD Drive link is present ────────────────────
    // No polling is actually required any more — the PATCH above already
    // waited for generation, so jd_drive_link is set the moment the modal
    // closes. pollUntil is kept as a defensive fallback (e.g. a slow client-
    // side query refetch) rather than the primary wait.
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
