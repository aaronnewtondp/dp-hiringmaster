/**
 * E2E — Create Role form rework, RoleDetail edit-mode parity, and the new
 * master filters on Dashboard/Roles/Candidates (all built this session,
 * zero prior E2E coverage).
 *
 * 1) NewRole.tsx — every field is required except KPI Expectations and
 *    Additional Remarks; "Vacancy Caused Due To" and "Recruitment Channels"
 *    are plain toggle-button groups (not checkboxes/selects), and there is
 *    no more "Assignment Round Required" checkbox (removed this session —
 *    every role gets one by default now, sent as a fixed `true` in the
 *    payload).
 * 2) RoleDetail.tsx — Suggested Interviewers, Assignment Required, WhatsApp
 *    Forward Link, Referral Message Link and Posting Status were all
 *    removed; "Approval Summary Link" was renamed to "Assignment Link".
 *    Clicking a card's pencil (title="Edit {section title}") switches
 *    Department/Location/Employment Type/Priority to real <select>s and
 *    Vacancy Caused Due To / Recruitment Mode to the same toggle-button UI
 *    as the create form, via EditableSection's new 'multiselect' field type.
 * 3) MultiSelectFilter.tsx — shared by Dashboard/Roles/Candidates: a button
 *    showing the filter's label, a checkbox-driven dropdown panel, and a
 *    count badge once anything is selected. Candidates.tsx additionally
 *    auto-hides its "Unlinked candidates" panel whenever any Role filter is
 *    active (unlinked candidates, by definition, have no role).
 *
 * Tests 2, 3 and 6 below reuse the role created by test 1 (rather than an
 * API-created fixture) since the point is specifically to exercise
 * RoleDetail/filter behavior against a role that came out of the real
 * Create Role form. This relies on playwright.config.ts's
 * `fullyParallel: false, workers: 1` actually running this file's tests in
 * declaration order within one worker process, so the module-level
 * `createdRoleId`/`createdRoleTitle` set by test 1 are visible to the
 * later tests. Each dependent test guards itself with `test.skip` rather
 * than failing confusingly if test 1 didn't get far enough to set them.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS, uid, CANDIDATE_INGEST_SECRET } from '../helpers/api';

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

/**
 * Locates a NewRole.tsx field by its exact <label> text (every required
 * field's label carries a trailing " *") and the input/select/textarea
 * immediately after it as a sibling — same `label + input` adjacency
 * 04-inline-editing.spec.ts relies on for EditableSection, since none of
 * these labels are wired via htmlFor/id either.
 */
function newRoleField(page: Page, labelText: string, tag: 'input' | 'select' | 'textarea' = 'input') {
  return page.locator(`label:text-is("${labelText}") + ${tag}`);
}

/**
 * Copied from 04-inline-editing.spec.ts (this suite's precedent: each e2e
 * file keeps its own local copy rather than importing one). Locates an
 * EditableSection card by its <h2> title rather than the pencil button,
 * because the pencil unmounts once isEditing flips true (replaced by the
 * Save/Cancel row) — the h2 is the one anchor present in both modes.
 */
function sectionCard(page: Page, sectionTitle: string) {
  return page.locator('div.card').filter({
    has: page.getByRole('heading', { name: sectionTitle, level: 2 }),
  });
}

/**
 * Locates a MultiSelectFilter's wrapping `div.relative` (the toggle button
 * + its conditional dropdown panel are the only children) by the filter's
 * own label text. On every page this spec touches, that label text is the
 * only place the word appears inside a `relative`-positioned wrapper, so a
 * plain hasText substring filter resolves to exactly one container — both
 * before and after a selection changes the button's own accessible name
 * (e.g. "Department" -> "Department1", once the count badge renders),
 * which is why this doesn't rely on getByRole's exact-name matching.
 */
function masterFilter(page: Page, label: string) {
  return page.locator('div.relative').filter({ hasText: label });
}

// Target Close Date is blank by default and required; Open Date already
// defaults to today so it doesn't need touching. Comfortably in the future
// so no "close date before open date" validation (if any exists) could ever
// interfere.
function futureDateInput(): string {
  return new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Fills every NewRole.tsx required field with a realistic value and clicks
 * one toggle from each required button group — optionally skipping the
 * Vacancy Caused Due To toggle (for the negative validation test).
 * Department/Location values are hardcoded to entries from the fixed
 * DEPARTMENTS/LOCATIONS lists in frontend/src/types/index.ts rather than
 * imported cross-package.
 *
 * Every text/select/date field below carries a native HTML `required`
 * attribute in NewRole.tsx, so all of them must always be filled here —
 * leaving any one of THEM blank makes the browser's own native validation
 * bubble intercept the click before handleSubmit's custom JS validation
 * (and its toast) ever runs (confirmed by running this exact scenario:
 * leaving Hiring Manager blank produces a native "Please fill out this
 * field" tooltip, not an app toast). Vacancy Caused Due To / Recruitment
 * Channels are plain <button> toggle groups with no native constraint, so
 * skipping one of those is the only way to actually reach — and test —
 * handleSubmit's own required-selection checks.
 */
async function fillRequiredFields(page: Page, { title, skipVacancyReason = false }: { title: string; skipVacancyReason?: boolean }) {
  await newRoleField(page, 'Role Title *').fill(title);
  await newRoleField(page, 'Department *', 'select').selectOption('Tech/Devs');
  await newRoleField(page, 'Hiring Manager *').fill('E2E Hiring Manager');
  await newRoleField(page, 'Location *', 'select').selectOption('Bangalore');
  await newRoleField(page, 'Experience Range *').fill('3-5 years');
  await newRoleField(page, 'Educational Qualifications *').fill('B.Tech / B.E. in Computer Science');
  await newRoleField(page, 'CTC Band (₹ LPA) *').fill('18-24 LPA');
  await newRoleField(page, 'Target Close Date *').fill(futureDateInput());
  await newRoleField(page, 'Must Have Skills *', 'textarea').fill('Node.js; TypeScript; PostgreSQL; Docker');
  await newRoleField(page, 'Nice to Have Skills *', 'textarea').fill('GraphQL; AWS; Kubernetes');
  await newRoleField(page, 'Job Description *', 'textarea').fill('Key responsibilities and expectations for this E2E test role.');
  if (!skipVacancyReason) {
    await page.getByRole('button', { name: 'Resignation', exact: true }).click();
  }
  await page.getByRole('button', { name: 'LinkedIn', exact: true }).click();
}

test.describe('Create Role form + RoleDetail parity + master filters', () => {
  let createdRoleId: string | undefined;
  let createdRoleTitle: string | undefined;

  test('Create Role form: filling every required field and one toggle per group navigates to the new role', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/new`);
    await page.waitForURL(/\/roles\/new/, { timeout: 10000 });

    createdRoleTitle = `E2E New Role ${uid()}`;
    await fillRequiredFields(page, { title: createdRoleTitle });

    await page.getByRole('button', { name: 'Create role' }).click();

    // R### id scheme: an uppercase letter followed by digits.
    await page.waitForURL(/\/roles\/[A-Z]\d+/, { timeout: 15000 });
    createdRoleId = page.url().split('/roles/')[1];

    await expect(page.getByRole('heading', { name: createdRoleTitle, level: 1 })).toBeVisible({ timeout: 10000 });
  });

  test('RoleDetail for the newly created role hides removed legacy fields and shows the renamed Assignment Link', async ({ page }) => {
    test.skip(!createdRoleId, 'depends on the role created by the previous test');

    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/${createdRoleId}`);
    await expect(page.getByRole('heading', { name: createdRoleTitle!, level: 1 })).toBeVisible({ timeout: 10000 });

    await expect(page.getByText('Assignment Required')).toHaveCount(0);
    await expect(page.getByText('Suggested Interviewers')).toHaveCount(0);

    const linksCard = sectionCard(page, 'Links & Assets');
    await expect(linksCard.getByText('Assignment Link', { exact: true })).toBeVisible();
  });

  test('Basic Info edit mode mirrors the Create Role form select and toggle-button UI', async ({ page }) => {
    test.skip(!createdRoleId, 'depends on the role created by the first test');

    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/${createdRoleId}`);
    await expect(page.getByRole('heading', { name: createdRoleTitle!, level: 1 })).toBeVisible({ timeout: 10000 });

    const basicInfo = sectionCard(page, 'Basic Info');
    await basicInfo.getByRole('button', { name: 'Edit Basic Info' }).click();

    // Department is now a real <select>, not a plain text input.
    await expect(basicInfo.locator('label:text-is("Department") + select')).toBeVisible();

    // Vacancy Caused Due To renders the same toggle-button group as the
    // create form (EditableSection's 'multiselect' field type) — the option
    // picked back in test 1 ("Resignation") should still show as active
    // (bg-dp-600, per NewRole.tsx/EditableSection.tsx's shared active style).
    const vacancyToggle = basicInfo.getByRole('button', { name: 'Resignation', exact: true });
    await expect(vacancyToggle).toBeVisible();
    await expect(vacancyToggle).toHaveClass(/bg-dp-600/);

    // Leave without saving.
    await basicInfo.getByRole('button', { name: 'Cancel' }).click();
    await expect(basicInfo.getByRole('button', { name: 'Edit Basic Info' })).toBeVisible();
  });

  test('Create Role form: leaving Vacancy Caused Due To unselected is blocked client-side with a toast, no navigation away from /roles/new', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/roles/new`);
    await page.waitForURL(/\/roles\/new/, { timeout: 10000 });

    await fillRequiredFields(page, { title: `E2E Incomplete Role ${uid()}`, skipVacancyReason: true });

    await page.getByRole('button', { name: 'Create role' }).click();

    // handleSubmit's own JS validation (not native HTML `required`, which
    // every text/select/date field carries and which the browser would
    // enforce before handleSubmit even runs) is what fires this toast and
    // returns before any API call is made.
    await expect(page.getByText('Select at least one Vacancy Caused Due To option')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/roles\/new/);
  });

  test('Dashboard Department master filter shows a count badge, and Clear all resets it', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/dashboard`);
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });

    const departmentFilter = masterFilter(page, 'Department');
    await departmentFilter.locator('button').first().click();

    const panel = departmentFilter.locator('div.absolute');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await panel.locator('label').first().click();

    await expect(departmentFilter.locator('span.bg-dp-600')).toHaveText('1');

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(departmentFilter.locator('span.bg-dp-600')).toHaveCount(0);
  });

  test('Candidates Role filter hides the Unlinked candidates panel', async ({ page }) => {
    test.skip(!createdRoleId, 'depends on the role created by the first test');

    // Seed a genuinely unlinked candidate (zero applications, same pattern
    // as 05-unlinked-candidates.spec.ts) so the panel is guaranteed visible
    // before filtering — otherwise "the panel disappears after filtering"
    // could pass vacuously on an environment with no unlinked candidates.
    const marker = `E2E Unlinked ${uid()}`;
    const ingestRes = await page.request.post(`${BASE}/api/candidates/ingest`, {
      headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
      data: {
        email: `e2e.unlinked+${uid()}@example.com`,
        full_name: marker,
        role_applied_for: `Nonexistent Role ${uid()}`,
      },
    });
    expect(ingestRes.status()).toBe(201);

    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/candidates`);
    await expect(page.getByRole('heading', { name: /Unlinked candidates \(\d+\)/ })).toBeVisible({ timeout: 15000 });

    const roleFilter = masterFilter(page, 'Role');
    await roleFilter.locator('button').first().click();

    const panel = roleFilter.locator('div.absolute');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await panel.locator('label', { hasText: createdRoleTitle! }).click();

    await expect(page.getByRole('heading', { name: /Unlinked candidates/ })).not.toBeVisible();
  });
});
