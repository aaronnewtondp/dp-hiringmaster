/**
 * E2E — Inline editing (EditableSection) across Role / Candidate / Agency detail pages
 *
 * Phase 3 feature: every detail page renders its fields inside EditableSection
 * cards — read mode shows label/value pairs; clicking the pencil (title=
 * "Edit {section title}") switches every field in that section to inputs,
 * with an explicit Save/Cancel row (no autosave, no per-field affordances).
 * See frontend/src/components/shared/EditableSection.tsx.
 *
 * These tests drive that exact interaction through the real UI, then reload
 * the page to prove the change actually persisted server-side — not just
 * that the UI optimistically rendered it.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS, getToken, authed, uid } from '../helpers/api';

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

// ─── Fresh, isolated test data — created directly via API so each test edits
// its own row rather than seeded data other tests might also touch ──────────
async function createTestRole(page: Page, overrides: Record<string, unknown> = {}) {
  const token = await getToken(page.request, 'hr');
  const res   = await authed(page.request, token).post('/api/roles', {
    title:      `E2E Role ${uid()}`,
    priority:   'P2',
    department: `Dept ${uid()}`,
    ...overrides,
  });
  const { role } = await res.json();
  return role;
}

async function createTestCandidate(page: Page, overrides: Record<string, unknown> = {}) {
  const token = await getToken(page.request, 'hr');
  const res   = await authed(page.request, token).post('/api/candidates', {
    full_name:        `E2E Candidate ${uid()}`,
    email:            `e2e+${uid()}@example.com`,
    current_company:  `Initial Co ${uid()}`,
    ...overrides,
  });
  const body = await res.json();
  return body.candidate;
}

async function createTestAgency(page: Page, overrides: Record<string, unknown> = {}) {
  const token = await getToken(page.request, 'hr');
  const res   = await authed(page.request, token).post('/api/agencies', {
    name:         `E2E Agency ${uid()}`,
    contact_name: `Initial Contact ${uid()}`,
    ...overrides,
  });
  const { agency } = await res.json();
  return agency;
}

/**
 * Drives one EditableSection card end-to-end: click its pencil, fill one
 * field's input, then Save (default) or Cancel.
 *
 * The card is located by its `<h2>` section title rather than the pencil
 * button, because the pencil itself is unmounted while isEditing is true
 * (replaced by the Save/Cancel row) — the h2 is the one anchor that stays
 * on screen in both read and edit mode.
 */
function sectionCard(page: Page, sectionTitle: string) {
  return page.locator('div.card').filter({
    has: page.getByRole('heading', { name: sectionTitle, level: 2 }),
  });
}

async function editField(
  page: Page,
  sectionTitle: string,
  fieldLabel: string,
  value: string,
  { save = true }: { save?: boolean } = {}
) {
  const card = sectionCard(page, sectionTitle);

  await card.getByRole('button', { name: `Edit ${sectionTitle}` }).click();
  await card.locator(`label:text-is("${fieldLabel}") + input`).fill(value);

  if (save) {
    await card.getByRole('button', { name: 'Save' }).click();
    // Pencil reappearing means isEditing flipped back to false — i.e. the
    // save resolved successfully (a failed save stays in edit mode + toasts).
    await expect(card.getByRole('button', { name: `Edit ${sectionTitle}` })).toBeVisible({ timeout: 10000 });
  } else {
    await card.getByRole('button', { name: 'Cancel' }).click();
  }
}

test.describe('Inline Editing (EditableSection) E2E', () => {

  test.describe('Role Detail', () => {
    test('editing Department in Basic Info persists after reload', async ({ page }) => {
      const role = await createTestRole(page);
      await loginViaApi(page);

      await page.goto(`${FRONTEND_BASE}/roles/${role.id}`);
      await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible({ timeout: 10000 });

      const newDept = `Updated Dept ${uid()}`;
      await editField(page, 'Basic Info', 'Department', newDept);

      await page.reload();
      await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible({ timeout: 10000 });
      await expect(sectionCard(page, 'Basic Info').getByText(newDept)).toBeVisible();
    });
  });

  test.describe('Candidate Detail', () => {
    test('editing Company in Current Role persists after reload', async ({ page }) => {
      const candidate = await createTestCandidate(page);
      await loginViaApi(page);

      await page.goto(`${FRONTEND_BASE}/candidates/${candidate.id}`);
      await expect(page.getByRole('heading', { name: candidate.full_name, level: 1 })).toBeVisible({ timeout: 10000 });

      const newCompany = `Updated Co ${uid()}`;
      await editField(page, 'Current Role', 'Company', newCompany);

      await page.reload();
      await expect(page.getByRole('heading', { name: candidate.full_name, level: 1 })).toBeVisible({ timeout: 10000 });
      await expect(sectionCard(page, 'Current Role').getByText(newCompany)).toBeVisible();
    });
  });

  test.describe('Agency Detail', () => {
    test('editing Contact Name in Contact persists after reload', async ({ page }) => {
      const agency = await createTestAgency(page);
      await loginViaApi(page);

      await page.goto(`${FRONTEND_BASE}/agencies/${agency.id}`);
      await expect(page.getByRole('heading', { name: agency.name, level: 1 })).toBeVisible({ timeout: 10000 });

      const newContact = `Updated Contact ${uid()}`;
      await editField(page, 'Contact', 'Contact Name', newContact);

      await page.reload();
      await expect(page.getByRole('heading', { name: agency.name, level: 1 })).toBeVisible({ timeout: 10000 });
      await expect(sectionCard(page, 'Contact').getByText(newContact)).toBeVisible();
    });
  });

  test.describe('Cancel discards changes', () => {
    test('editing a field then clicking Cancel leaves the original value in place after reload', async ({ page }) => {
      const originalDept = `Original Dept ${uid()}`;
      const role = await createTestRole(page, { department: originalDept });
      await loginViaApi(page);

      await page.goto(`${FRONTEND_BASE}/roles/${role.id}`);
      await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible({ timeout: 10000 });

      const discardedValue = `Should Not Save ${uid()}`;
      await editField(page, 'Basic Info', 'Department', discardedValue, { save: false });

      await page.reload();
      await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible({ timeout: 10000 });
      const basicInfo = sectionCard(page, 'Basic Info');
      await expect(basicInfo.getByText(originalDept)).toBeVisible();
      await expect(basicInfo.getByText(discardedValue)).not.toBeVisible();
    });
  });
});
