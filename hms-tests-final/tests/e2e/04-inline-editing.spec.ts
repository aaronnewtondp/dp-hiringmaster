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
import { Client } from 'pg';
import { FRONTEND_BASE, getToken, authed, uid } from '../helpers/api';
import { newClient } from '../helpers/db';
import { loginViaApi } from '../helpers/e2e';
import { recordRequests } from '../helpers/e2e-roles';
import { purgeRolesFast } from '../helpers/sourcing-db';

// What the tests below create is removed in afterAll: the Role filter everywhere lists every open role, and the candidate and agency lists
// grow with every run otherwise.
let db: Client;
const createdRoleIds: string[] = [];
const createdCandidateEmails: string[] = [];
const createdAgencyIds: string[] = [];

test.beforeAll(async () => {
  db = newClient();
  await db.connect();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  await purgeRolesFast(db, createdRoleIds, createdCandidateEmails);
  if (createdAgencyIds.length) await db.query(`DELETE FROM agencies WHERE id = ANY($1::text[])`, [createdAgencyIds]);   // its edit log goes with it (ON DELETE CASCADE)
  await db.end();
});

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
  expect(res.status(), 'creating the role fixture').toBe(201);
  const { role } = await res.json();
  createdRoleIds.push(role.id);
  return role;
}

async function createTestCandidate(page: Page, overrides: Record<string, unknown> = {}) {
  const token = await getToken(page.request, 'hr');
  const email = (overrides.email as string | undefined) ?? `e2e+${uid()}@example.com`;
  const res   = await authed(page.request, token).post('/api/candidates', {
    full_name:        `E2E Candidate ${uid()}`,
    current_company:  `Initial Co ${uid()}`,
    ...overrides,
    email,
  });
  expect(res.status(), 'creating the candidate fixture').toBe(201);
  const body = await res.json();
  createdCandidateEmails.push(email);
  return body.candidate;
}

async function createTestAgency(page: Page, overrides: Record<string, unknown> = {}) {
  const token = await getToken(page.request, 'hr');
  const res   = await authed(page.request, token).post('/api/agencies', {
    name:         `E2E Agency ${uid()}`,
    contact_name: `Initial Contact ${uid()}`,
    ...overrides,
  });
  expect(res.status(), 'creating the agency fixture').toBe(201);
  const { agency } = await res.json();
  createdAgencyIds.push(agency.id);
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

  // A field can render as a plain <input> (type: 'text'/'number'/'date'/
  // 'tags') or a <select> (type: 'select') depending on the FieldConfig in
  // the page's own EditableSection usage — e.g. RoleDetail's Department
  // became a <select> this session. Detect which is actually present rather
  // than assuming <input>, so this one helper covers both without every
  // caller needing to know a field's type ahead of time.
  const selectField = card.locator(`label:text-is("${fieldLabel}") + select`);
  const inputField  = card.locator(`label:text-is("${fieldLabel}") + input`);
  if (await selectField.count() > 0) {
    await selectField.selectOption(value);
  } else {
    await inputField.fill(value);
  }

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

      // Department is a fixed <select> now (DEPARTMENTS in frontend/src/
      // types/index.ts) — must pick one of its real option values, not an
      // arbitrary string, since editField's select path uses selectOption.
      const newDept = 'Sales & Growth';
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

      // Same constraint as the test above — must be a real DEPARTMENTS
      // option since editField's select path uses selectOption, and
      // deliberately different from that test's 'Sales & Growth' so the two
      // tests' edited values are also non-clashing strings within this file.
      const discardedValue = 'CSM/Service';
      // attached before the edit, so a save sent at any point (not only at Cancel) is seen
      const writes = recordRequests(page, r => r.method === 'PATCH' || r.method === 'PUT' || r.method === 'POST');
      await editField(page, 'Basic Info', 'Department', discardedValue, { save: false });

      // right away, without a reload: back in read mode, on the original value
      const basicInfo = sectionCard(page, 'Basic Info');
      await expect(basicInfo.getByRole('button', { name: 'Edit Basic Info' })).toBeVisible();
      await expect(basicInfo.getByText(originalDept)).toBeVisible();
      await expect(basicInfo.getByText(discardedValue)).toHaveCount(0);
      expect(writes, 'Cancel must not write anything').toEqual([]);

      await page.reload();
      await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible({ timeout: 10000 });
      await expect(sectionCard(page, 'Basic Info').getByText(originalDept)).toBeVisible();
      await expect(sectionCard(page, 'Basic Info').getByText(discardedValue)).toHaveCount(0);
    });
  });
});
