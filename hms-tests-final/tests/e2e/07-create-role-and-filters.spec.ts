/**
 * E2E — Create Role form rework, RoleDetail edit-mode parity, and the master filters on Dashboard/Roles/Candidates.
 *
 * 1) NewRole.tsx — every field is required except KPI Expectations and
 *    Additional Remarks; "Vacancy Caused Due To" and "Recruitment Channels"
 *    are plain toggle-button groups (not checkboxes/selects), and there is
 *    no more "Assignment Round Required" checkbox (every role gets one by
 *    default now, sent as a fixed `true` in the payload).
 * 2) RoleDetail.tsx — Suggested Interviewers, Assignment Required, WhatsApp
 *    Forward Link, Referral Message Link and Posting Status were all
 *    removed; "Approval Summary Link" was renamed to "Assignment Link".
 *    Clicking a card's pencil (title="Edit {section title}") switches
 *    Department/Location/Employment Type/Priority to real <select>s and
 *    Vacancy Caused Due To / Recruitment Mode to the same toggle-button UI
 *    as the create form, via EditableSection's 'multiselect' field type.
 * 3) MultiSelectFilter.tsx — shared by Dashboard/Roles/Candidates/My Tasks: a button
 *    showing the filter's label, a checkbox-driven dropdown panel, and a
 *    count badge once anything is selected. Candidates.tsx additionally
 *    auto-hides its "Unmatched Candidates" panel whenever any Role filter is
 *    active (unmatched candidates, by definition, have no role). The Roles list has the same
 *    filters and starts on Approved + Live – Sourcing.
 *
 * Every test builds its OWN data and none depends on another test, in any order or on its own (the old version shared a role created by
 * test 1 through module-level variables and skipped itself silently when test 1 had not run, so a retry or a --grep passed vacuously).
 * Tests 2 and 3 are about a role that came out of the real Create Role form, so each fills that form itself (`createRoleViaForm`); the
 * filter tests use SQL fixtures. Everything created is removed in afterAll — the Role filter lists every open role, so what a test leaves
 * behind makes the next run's dropdown longer.
 */
import { test, expect, Page } from '@playwright/test';
import { Client } from 'pg';
import { BASE, FRONTEND_BASE, uid, CANDIDATE_INGEST_SECRET } from '../helpers/api';
import { newClient } from '../helpers/db';
import { futureDateOnly } from '../helpers/dates';
import { loginViaApi } from '../helpers/e2e';
import { Fixtures, recordRequests, setFilter } from '../helpers/e2e-roles';
import { purgeRolesFast } from '../helpers/sourcing-db';

const RUN = uid();
let db: Client;
let fx: Fixtures;                                                    // roles for the Candidates Role filter test
let fxList: Fixtures;                                                // roles for the Roles list test (its own run id: that page searches by title)
const formRoleIds: string[] = [];                                    // roles the Create Role form made (not SQL fixtures)

test.beforeAll(async () => {
  db = newClient();
  await db.connect();
  fx = new Fixtures(db, RUN, 'E2E RoleFilter');
  fxList = new Fixtures(db, `${RUN}-list`, 'E2E RolesList');
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  await fx.cleanup();
  await fxList.cleanup();
  await purgeRolesFast(db, formRoleIds, [`e2e.unlinked+${RUN}%@example.com`]);
  await db.end();
});

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
 * (and its toast) ever runs. Vacancy Caused Due To / Recruitment Channels
 * are plain <button> toggle groups with no native constraint, so skipping
 * one of those is the only way to actually reach — and test — handleSubmit's
 * own required-selection checks.
 */
async function fillRequiredFields(page: Page, { title, skipVacancyReason = false }: { title: string; skipVacancyReason?: boolean }) {
  await newRoleField(page, 'Role Title *').fill(title);
  await newRoleField(page, 'Department *', 'select').selectOption('Tech/Devs');
  await newRoleField(page, 'Hiring Manager *').fill('E2E Hiring Manager');
  await newRoleField(page, 'Location *', 'select').selectOption('Bangalore');
  await newRoleField(page, 'Experience Range *').fill('3-5 years');
  await newRoleField(page, 'Educational Qualifications *').fill('B.Tech / B.E. in Computer Science');
  await newRoleField(page, 'CTC Band (₹ LPA) *').fill('18-24 LPA');
  // Target Close Date is blank by default and required; Open Date already defaults to today. Comfortably in the future, computed from the clock.
  await newRoleField(page, 'Target Close Date *').fill(futureDateOnly(60));
  await newRoleField(page, 'Must Have Skills *', 'textarea').fill('Node.js; TypeScript; PostgreSQL; Docker');
  await newRoleField(page, 'Nice to Have Skills *', 'textarea').fill('GraphQL; AWS; Kubernetes');
  await newRoleField(page, 'Job Description *', 'textarea').fill('Key responsibilities and expectations for this E2E test role.');
  if (!skipVacancyReason) {
    await page.getByRole('button', { name: 'Resignation', exact: true }).click();
  }
  await page.getByRole('button', { name: 'LinkedIn', exact: true }).click();
}

/** Signs in as HR, fills the real Create Role form and submits it. Returns the new role (the app navigates to /roles/<id> on success). */
async function createRoleViaForm(page: Page, label: string): Promise<{ id: string; title: string }> {
  await loginViaApi(page, 'hr', '/roles/new');
  await page.waitForURL(/\/roles\/new/, { timeout: 10000 });
  const title = `E2E New Role ${label} ${RUN}`;
  await fillRequiredFields(page, { title });
  await page.getByRole('button', { name: 'Create role' }).click();

  // R### id scheme: an uppercase letter followed by digits.
  await page.waitForURL(/\/roles\/[A-Z]\d+/, { timeout: 15000 });
  const id = page.url().split('/roles/')[1];
  formRoleIds.push(id);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({ timeout: 10000 });
  return { id, title };
}

test.describe('Create Role form + RoleDetail parity + master filters', () => {

  test('Create Role form: filling every required field and one toggle per group navigates to the new role', async ({ page }) => {
    const { id, title } = await createRoleViaForm(page, 'create');
    // what the form sent is what the server stored
    const row = (await db.query(`SELECT title, status, department, location, vacancy_reason, recruitment_mode, assignment_required FROM roles WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ title, status: 'Draft', department: 'Tech/Devs', location: 'Bangalore', vacancy_reason: ['Resignation'], assignment_required: true });
    expect(row.recruitment_mode).toEqual(['LinkedIn']);
  });

  test('RoleDetail for a role created through the form hides removed legacy fields and shows the renamed Assignment Link', async ({ page }) => {
    const { id } = await createRoleViaForm(page, 'detail');
    await page.goto(`${FRONTEND_BASE}/roles/${id}`);

    await expect(page.getByText('Assignment Required')).toHaveCount(0);
    await expect(page.getByText('Suggested Interviewers')).toHaveCount(0);

    const linksCard = sectionCard(page, 'Links & Assets');
    await expect(linksCard.getByText('Assignment Link', { exact: true })).toBeVisible();
  });

  test('Basic Info edit mode mirrors the Create Role form select and toggle-button UI', async ({ page }) => {
    const { id } = await createRoleViaForm(page, 'edit-mode');
    await page.goto(`${FRONTEND_BASE}/roles/${id}`);

    const basicInfo = sectionCard(page, 'Basic Info');
    await basicInfo.getByRole('button', { name: 'Edit Basic Info' }).click();

    // Department is now a real <select>, not a plain text input.
    await expect(basicInfo.locator('label:text-is("Department") + select')).toBeVisible();

    // Vacancy Caused Due To renders the same toggle-button group as the
    // create form (EditableSection's 'multiselect' field type) — the option
    // picked in the form ("Resignation") should still show as active
    // (bg-dp-600, per NewRole.tsx/EditableSection.tsx's shared active style).
    const vacancyToggle = basicInfo.getByRole('button', { name: 'Resignation', exact: true });
    await expect(vacancyToggle).toBeVisible();
    await expect(vacancyToggle).toHaveClass(/bg-dp-600/);

    // Leave without saving.
    await basicInfo.getByRole('button', { name: 'Cancel' }).click();
    await expect(basicInfo.getByRole('button', { name: 'Edit Basic Info' })).toBeVisible();
  });

  test('Create Role form: leaving Vacancy Caused Due To unselected is blocked client-side with a toast, no navigation away from /roles/new and no request to create a role', async ({ page }) => {
    // The listener is attached BEFORE the first navigation, so a request sent at any point of the test is seen. (This used to sleep 1.5 s and look at the URL.)
    const creates = recordRequests(page, r => r.method === 'POST' && new URL(r.url).pathname === '/api/roles');
    await loginViaApi(page, 'hr', '/roles/new');
    await page.waitForURL(/\/roles\/new/, { timeout: 10000 });

    await fillRequiredFields(page, { title: `E2E Incomplete Role ${RUN}`, skipVacancyReason: true });

    await page.getByRole('button', { name: 'Create role' }).click();

    // handleSubmit's own JS validation (not native HTML `required`, which
    // every text/select/date field carries and which the browser would
    // enforce before handleSubmit even runs) is what fires this toast and
    // returns before any API call is made.
    await expect(page.getByText('Select at least one Vacancy Caused Due To option')).toBeVisible({ timeout: 5000 });
    await page.waitForLoadState('networkidle');                                  // anything the click started has now been sent
    expect(creates, 'a role was created although the form is incomplete').toEqual([]);
    await expect(page).toHaveURL(/\/roles\/new/);
    const stored = await db.query(`SELECT 1 FROM roles WHERE title = $1`, [`E2E Incomplete Role ${RUN}`]);
    expect(stored.rowCount).toBe(0);
  });

  test('Dashboard Department master filter shows a count badge, and Clear all resets it', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/dashboard`);
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });

    // The button's name is the filter label, then the count badge once anything is selected ("Department1").
    const departmentFilter = page.getByRole('button', { name: /^Department/ });
    await expect(departmentFilter).toHaveText(/^Department$/);
    await departmentFilter.click();

    // The dropdown panel renders via a React portal straight onto
    // document.body (position: fixed) rather than as an absolutely-
    // positioned child of the filter's own wrapper — needed so it isn't
    // clipped by any scrollable ancestor. Look for it at the body level.
    const panel = page.locator('body > div.fixed');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await panel.locator('label').first().click();

    await expect(departmentFilter).toHaveText(/^Department\s*1$/);

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(departmentFilter).toHaveText(/^Department$/);
  });

  test('Candidates Role filter hides the Unmatched Candidates panel (and Clear brings it back), however many roles the dropdown lists', async ({ page }) => {
    // A role this test owns, so the option to pick exists and is unique. (The Role dropdown lists EVERY open role in the database, so on
    // a long-lived one it holds hundreds of options and the one wanted can sit far below the fold of the panel.)
    const role = await fx.role('role-filter');

    // Seed a genuinely unmatched candidate (zero applications, same pattern as 05-unlinked-candidates.spec.ts) so the panel is guaranteed
    // visible before filtering — otherwise "the panel disappears after filtering" could pass vacuously on a database with none.
    const marker = `E2E Unlinked ${uid()}`;
    const ingestRes = await page.request.post(`${BASE}/api/candidates/ingest`, {
      headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
      data: {
        email: `e2e.unlinked+${RUN}.${uid()}@example.com`,
        full_name: marker,
        role_applied_for: `Nonexistent Role ${uid()}`,
      },
    });
    expect(ingestRes.status()).toBe(201);

    await loginViaApi(page, 'hr');
    await page.goto(`${FRONTEND_BASE}/candidates`);
    const panelHeading = page.getByRole('heading', { name: /Unmatched Candidates \(\d+\)/ });
    await expect(panelHeading).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^Role/ }).click();

    // Portaled to document.body — see the comment on the Department test above for why this isn't nested inside the filter.
    const panel = page.locator('body > div.fixed');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // The option is a real checkbox inside a scrolling panel: Playwright scrolls the panel itself until it is in view.
    // No DOM-level click, no forcing: this is what a person does (scroll, tick).
    const option = panel.getByLabel(role.title, { exact: true });
    await option.scrollIntoViewIfNeeded();
    await option.check();

    await expect(page.getByRole('heading', { name: /Unmatched Candidates/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Role\s*1$/ })).toBeVisible();

    // and the panel is back once the filter is cleared
    await panel.getByRole('button', { name: /Clear role/i }).click();
    await expect(panelHeading).toBeVisible();
  });

  test('Roles list: starts on Approved + Live – Sourcing, the Status filter reaches the others, Department and Priority narrow, search narrows', async ({ page }) => {
    const live  = await fxList.role('live',  { status: 'Live – Sourcing', department: 'Tech/Devs',    priority: 'P1' });
    const draft = await fxList.role('draft', { status: 'Draft',           department: 'Tech/Devs',    priority: 'P2' });
    const hold  = await fxList.role('hold',  { status: 'On Hold',         department: 'CSM/Service',  priority: 'P2' });
    const appr  = await fxList.role('appr',  { status: 'Approved',        department: 'CSM/Service',  priority: 'P3' });
    const link = (r: { title: string }) => page.getByRole('link', { name: r.title, exact: true });

    await loginViaApi(page, 'hr', '/roles');
    await page.getByPlaceholder(/^Search by title/).fill(fxList.run);                                       // client-side search: narrows to this test's roles
    await expect(page.getByText(/^2 roles? shown/)).toBeVisible();
    // the default view: Approved and Live – Sourcing
    await expect(link(live)).toBeVisible();
    await expect(link(appr)).toBeVisible();
    await expect(link(draft)).toHaveCount(0);
    await expect(link(hold)).toHaveCount(0);

    // Status: add Draft -> three; then ONLY On Hold -> one; no status selected = every status -> four
    await setFilter(page, 'Status', { check: ['Draft'] });
    await expect(page.getByText(/^3 roles? shown/)).toBeVisible();
    await expect(link(draft)).toBeVisible();
    await setFilter(page, 'Status', { uncheck: ['Draft', 'Approved', 'Live – Sourcing'], check: ['On Hold'] });
    await expect(page.getByText(/^1 roles? shown/)).toBeVisible();
    await expect(link(hold)).toBeVisible();
    await setFilter(page, 'Status', { uncheck: ['On Hold'] });
    await expect(page.getByText(/^4 roles? shown/)).toBeVisible();

    // Department narrows server-side: CSM/Service has two of the four
    await setFilter(page, 'Department', { check: ['CSM/Service'] });
    await expect(page.getByText(/^2 roles? shown/)).toBeVisible();
    await expect(link(hold)).toBeVisible();
    await expect(link(appr)).toBeVisible();
    await expect(link(live)).toHaveCount(0);
    // Priority P3 within that department: only the Approved one
    await setFilter(page, 'Priority', { check: ['P3'] });
    await expect(page.getByText(/^1 roles? shown/)).toBeVisible();
    await expect(link(appr)).toBeVisible();
    await expect(link(hold)).toHaveCount(0);

    // a search that matches nothing says so
    await page.getByPlaceholder(/^Search by title/).fill(`${fxList.run}-no-such-role`);
    await expect(page.getByText('No roles match this filter')).toBeVisible();
  });
});
