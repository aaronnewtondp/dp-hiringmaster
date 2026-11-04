/**
 * E2E — the Roles list and its filters, the Agencies list and the Add-candidate form (/candidates/new)
 *
 * These pages were render-checked only (smoke), although e2e/07's header promises the Roles filters. Each test builds its own roles (and,
 * for the form, its own candidates) and finds them by a marker in their title or e-mail address, so a database with hundreds of leftovers
 * changes nothing. The Add-candidate tests remove what they create afterwards (applications included) with the Cleanup registry.
 *
 * Tests whose title contains TODAY pin what the product does now where that looks unintended; each is listed in the run report.
 */
import { gotoAs } from '../helpers/e2e';
import { authed, getToken, uid } from '../helpers/api';
import { withDb } from '../helpers/db';
import {
  test, expect, Cleanup, createRole, createApplicant, toastWith, recordRequests, isPost, queryValues, hrApi, escapeRe, TestRole,
} from '../helpers/e2e-candidates';
import type { Page, APIRequestContext } from '@playwright/test';

const cleanup = new Cleanup();
test.afterAll(() => cleanup.purge());

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Roles list', () => {
  interface Trio { marker: string; alpha: TestRole; beta: TestRole; gamma: TestRole }

  /**
   * Three roles told apart by every filter the page has. Alpha and Beta are Drafts; Gamma is Live – Sourcing, so it shows in the page's DEFAULT
   * view (the Status filter starts as Approved + Live – Sourcing) and the Drafts do not.
   */
  async function makeTrio(request: APIRequestContext): Promise<Trio> {
    const marker = uid();
    const make = async (name: string, over: Record<string, unknown>) => {
      const role = await createRole(request, { title: `E2E Lists ${marker} ${name}`, ...over });
      cleanup.role(role.id);
      return role;
    };
    return {
      marker,
      alpha: await make('Alpha', { department: 'Product/QA', priority: 'P1', location: 'Mumbai' }),
      beta:  await make('Beta',  { department: 'Sales & Growth', priority: 'P2', location: 'Pune' }),
      gamma: await make('Gamma', { department: 'CSM/Service', priority: 'P3', location: 'Gujarat', status: 'Live – Sourcing' }),
    };
  }

  const rolesSearch = (page: Page) => page.getByPlaceholder(/Search by title, department/);
  const roleRow = (page: Page, role: { title: string }) => page.getByRole('row').filter({ hasText: role.title });
  const filterButton = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${escapeRe(label)}`) });
  /** Open a filter, tick one option and click away so the panel is closed again. */
  async function pick(page: Page, label: string, option: string) {
    await filterButton(page, label).click();
    await page.getByRole('checkbox', { name: option, exact: true }).check();
    await page.getByRole('heading', { name: 'Roles', level: 1 }).click();
  }

  test('the default view is Approved + Live – Sourcing (badge 2): a Draft shows only once Draft is added to the Status filter', async ({ page, request }) => {
    const t = await makeTrio(request);
    await gotoAs(page, 'hr', '/roles');
    await rolesSearch(page).fill(t.marker);
    await expect(filterButton(page, 'Status')).toHaveText(/Status\s*2/);
    await expect(roleRow(page, t.gamma)).toHaveCount(1);                              // Live – Sourcing: in the default view
    await expect(roleRow(page, t.alpha)).toHaveCount(0);                              // Drafts are not
    await expect(roleRow(page, t.beta)).toHaveCount(0);
    await expect(page.getByText(/^1 roles? shown$/)).toBeVisible();

    await pick(page, 'Status', 'Draft');
    await expect(filterButton(page, 'Status')).toHaveText(/Status\s*3/);
    await expect(roleRow(page, t.alpha)).toHaveCount(1);
    await expect(roleRow(page, t.beta)).toHaveCount(1);
    await expect(page.getByText(/^3 roles shown$/)).toBeVisible();

    await filterButton(page, 'Status').click();                                       // an empty Status filter means every status
    await page.getByRole('button', { name: 'Clear status' }).click();
    await page.getByRole('heading', { name: 'Roles', level: 1 }).click();
    await expect(filterButton(page, 'Status')).toHaveText(/^Status$/);
    await expect(page.getByText(/^3 roles shown$/)).toBeVisible();
  });

  test('Department, Priority and Location narrow the list on the server; each filter has its own badge and its own Clear', async ({ page, request }) => {
    const t = await makeTrio(request);
    await gotoAs(page, 'hr', '/roles');
    await pick(page, 'Status', 'Draft');
    await rolesSearch(page).fill(t.marker);
    await expect(page.getByText(/^3 roles shown$/)).toBeVisible();

    const dept = page.waitForRequest(r => r.url().includes('/api/roles?') && queryValues(r.url(), 'department').length > 0);
    await pick(page, 'Department', 'Product/QA');
    expect(queryValues((await dept).url(), 'department')).toEqual(['Product/QA']);
    await expect(filterButton(page, 'Department')).toHaveText(/Department\s*1/);
    await expect(page.getByText(/^1 roles? shown$/)).toBeVisible();
    await expect(roleRow(page, t.alpha)).toHaveCount(1);

    await pick(page, 'Department', 'Sales & Growth');                                 // two departments: Alpha and Beta
    await expect(filterButton(page, 'Department')).toHaveText(/Department\s*2/);
    await expect(page.getByText(/^2 roles shown$/)).toBeVisible();
    await expect(roleRow(page, t.gamma)).toHaveCount(0);

    await pick(page, 'Priority', 'P2');                                               // Priority ANDs with Department: Beta only
    await expect(page.getByText(/^1 roles? shown$/)).toBeVisible();
    await expect(roleRow(page, t.beta)).toHaveCount(1);
    await filterButton(page, 'Department').click();
    await page.getByRole('button', { name: 'Clear department' }).click();             // clearing one filter leaves the others
    await page.getByRole('heading', { name: 'Roles', level: 1 }).click();
    await expect(filterButton(page, 'Department')).toHaveText(/^Department$/);
    await expect(filterButton(page, 'Priority')).toHaveText(/Priority\s*1/);
    await expect(roleRow(page, t.beta)).toHaveCount(1);
    await expect(page.getByText(/^1 roles? shown$/)).toBeVisible();

    await pick(page, 'Location', 'Mumbai');                                           // Priority P2 AND Mumbai: nothing
    await expect(page.getByText('No roles match this filter')).toBeVisible();
    await expect(page.getByText(/^0 roles shown$/)).toBeVisible();
    await filterButton(page, 'Priority').click();
    await page.getByRole('button', { name: 'Clear priority' }).click();
    await page.getByRole('heading', { name: 'Roles', level: 1 }).click();
    await expect(roleRow(page, t.alpha)).toHaveCount(1);                              // Mumbai alone: Alpha
    await expect(page.getByText(/^1 roles? shown$/)).toBeVisible();
  });

  test('the search box matches title, id, department, location and status, and the table shows the role\'s own values', async ({ page, request }) => {
    const t = await makeTrio(request);
    await gotoAs(page, 'hr', '/roles');
    await pick(page, 'Status', 'Draft');
    await rolesSearch(page).fill(t.marker);
    await expect(page.getByText(/^3 roles shown$/)).toBeVisible();
    const alpha = roleRow(page, t.alpha);
    await expect(alpha).toContainText(t.alpha.id);
    await expect(alpha).toContainText('Product/QA');
    await expect(alpha).toContainText('Mumbai');
    await expect(alpha).toContainText('P1');
    await expect(alpha).toContainText('Draft');
    await expect(alpha).toContainText('10-20 LPA');                                   // Salary Range: HR sees the band

    // each field the box searches, one at a time: Beta's id, department and location find Beta and not Alpha; "draft" (the status) finds both Drafts, not the live Gamma
    for (const term of [t.beta.id, 'Sales & Growth', 'Pune']) {
      await rolesSearch(page).fill(term);
      await expect(roleRow(page, t.beta)).toHaveCount(1);
      await expect(roleRow(page, t.alpha)).toHaveCount(0);
    }
    await rolesSearch(page).fill('draft');
    await expect(roleRow(page, t.alpha)).toHaveCount(1);
    await expect(roleRow(page, t.beta)).toHaveCount(1);
    await expect(roleRow(page, t.gamma)).toHaveCount(0);
    await rolesSearch(page).fill('zzz-no-such-role');
    await expect(page.getByText('No roles match this filter')).toBeVisible();
  });

  test('the Status, Department and other filters survive leaving the page and coming back in the same session', async ({ page, request }) => {
    const t = await makeTrio(request);
    await gotoAs(page, 'hr', '/roles');
    await pick(page, 'Department', 'CSM/Service');
    await rolesSearch(page).fill(t.marker);
    await expect(roleRow(page, t.gamma)).toHaveCount(1);

    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole('link', { name: 'Roles', exact: true }).click();
    await expect(filterButton(page, 'Department')).toHaveText(/Department\s*1/);
    await expect(filterButton(page, 'Status')).toHaveText(/Status\s*2/);
    await expect(rolesSearch(page)).toHaveValue(t.marker);
    await expect(roleRow(page, t.gamma)).toHaveCount(1);
  });

  test('HR sees "New role" and the Salary Range column; a Hiring Manager and Leadership see "Request role", and only Leadership keeps the band', async ({ page, request }) => {
    const t = await makeTrio(request);
    const seen = async (who: Parameters<typeof gotoAs>[1]) => {
      await gotoAs(page, who, '/roles');
      await rolesSearch(page).fill(t.marker);
      await expect(roleRow(page, t.gamma)).toHaveCount(1);
      return {
        newRole: await page.getByRole('link', { name: 'New role' }).count(),
        requestRole: await page.getByRole('link', { name: 'Request role' }).count(),
        salaryColumn: await page.getByRole('columnheader', { name: 'Salary Range' }).count(),
        band: await roleRow(page, t.gamma).getByText('10-20 LPA').count(),
      };
    };
    expect(await seen('hr')).toEqual({ newRole: 1, requestRole: 0, salaryColumn: 1, band: 1 });
    expect(await seen('leadership')).toEqual({ newRole: 0, requestRole: 1, salaryColumn: 1, band: 1 });
    expect(await seen('hm_alex')).toEqual({ newRole: 0, requestRole: 1, salaryColumn: 0, band: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Agencies list', () => {

  test('HR sees every agency with a count that matches the API, and a row opens that agency', async ({ page, request }) => {
    const res = await (await hrApi(request)).get('/api/agencies');
    expect(res.status()).toBe(200);
    const { agencies } = await res.json();
    expect(agencies.length).toBeGreaterThan(0);

    await gotoAs(page, 'hr', '/dashboard');
    await page.getByRole('link', { name: 'Agencies', exact: true }).click();          // the sidebar entry exists for HR
    await expect(page).toHaveURL(/\/agencies$/);
    await expect(page.getByRole('heading', { name: 'Agency Repository' })).toBeVisible();
    await expect(page.getByText(`${agencies.length} agencies`, { exact: true })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(agencies.length + 1);             // header + one row each
    const first = agencies[0];
    await page.getByRole('link', { name: first.name }).first().click();
    await expect(page).toHaveURL(new RegExp(`/agencies/${first.id}$`));
    await expect(page.getByRole('heading', { name: first.name, level: 1 })).toBeVisible();
  });

  test('TODAY a Hiring Manager has no Agencies link, and the page opened by URL shows "0 agencies" because the server answers 403', async ({ page }) => {
    const answers = recordRequests(page, r => r.url().endsWith('/api/agencies'));
    const statuses: number[] = [];
    page.on('response', r => { if (r.url().endsWith('/api/agencies')) statuses.push(r.status()); });
    await gotoAs(page, 'hm_alex', '/dashboard');
    await expect(page.getByRole('link', { name: 'Roles', exact: true })).toBeVisible();   // the sidebar has rendered ...
    await expect(page.getByRole('link', { name: 'Agencies', exact: true })).toHaveCount(0);   // ... without the HR-only entry
    await gotoAs(page, 'hm_alex', '/agencies');
    await expect(page.getByRole('heading', { name: 'Agency Repository' })).toBeVisible();
    // TODAY: not a "no access" message — an empty list, with the Add agency button still drawn (it does nothing for anyone, see below).
    await expect(page.getByText('0 agencies', { exact: true })).toBeVisible();
    await expect(page.getByText('No agencies', { exact: true })).toBeVisible();
    expect(answers.requests.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set([403]));
  });

  test('TODAY the "Add agency" button is not wired: clicking it opens nothing', async ({ page }) => {
    await gotoAs(page, 'hr', '/agencies');
    const add = page.getByRole('button', { name: 'Add agency' });
    await expect(add).toBeVisible();
    const posts = recordRequests(page, isPost('/api/agencies'));
    await add.click();
    await expect(page).toHaveURL(/\/agencies$/);
    await expect(page.locator('div.fixed.inset-0')).toHaveCount(0);                    // no dialog
    await expect(page.getByRole('heading', { name: 'Agency Repository' })).toBeVisible();   // (a settled page: any request or dialog would have started by now)
    expect(posts.requests).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Add candidate form (/candidates/new)', () => {

  interface FormValues {
    name: string; email: string; phone: string; company: string; industry: string; location: string; preferred: string; years: string;
    languages: string; ctc: string; ectc: string; notice: string; resume: string; roleTitle: string;
  }

  /** The label above an input in this form (the labels are not tied to their inputs, so the input is "the next sibling"). */
  const field = (page: Page, label: string) => page.locator(`label:text-is("${label}") + input, label:text-is("${label}") + select`);

  const LABELS = {
    name: 'Full Name *', email: 'Email *', phone: 'Phone Number *', role: 'Role applying for *', company: 'Current Company *',
    industry: 'Current Industry *', location: 'Current Location *', preferred: 'Preferred Location *', years: 'Years of Experience *',
    languages: 'Languages Known *', ctc: 'Current CTC (Fixed and Variable breakup) in LPA *', ectc: 'Expected CTC (LPA) *',
    notice: 'Notice Period (days) *', resume: 'Resume — Google Drive link *',
  };

  async function fillForm(page: Page, v: FormValues) {
    await field(page, LABELS.name).fill(v.name);
    await field(page, LABELS.email).fill(v.email);
    await field(page, LABELS.phone).fill(v.phone);
    await field(page, LABELS.role).selectOption({ label: v.roleTitle });
    await field(page, LABELS.company).fill(v.company);
    await field(page, LABELS.industry).fill(v.industry);
    await field(page, LABELS.location).fill(v.location);
    await field(page, LABELS.preferred).fill(v.preferred);
    await field(page, LABELS.years).fill(v.years);
    await field(page, LABELS.languages).fill(v.languages);
    await field(page, LABELS.ctc).fill(v.ctc);
    await field(page, LABELS.ectc).fill(v.ectc);
    await field(page, LABELS.notice).fill(v.notice);
    await field(page, LABELS.resume).fill(v.resume);
  }

  async function arrangeForm(request: APIRequestContext): Promise<{ role: { id: string; title: string }; values: FormValues }> {
    const role = await createRole(request, { status: 'Live – Sourcing' });
    cleanup.role(role.id);
    const email = `e2ec+${uid()}@example.com`;
    cleanup.email(email);
    return {
      role,
      values: {
        name: `Priya Nf${uid()}`, email, phone: '+91 93333 33333', company: 'Form Co', industry: 'Water Treatment', location: 'Pune',
        preferred: 'Gurgaon', years: '6.5', languages: 'English, Hindi', ctc: '14.5', ectc: '18', notice: '45',
        resume: 'https://drive.google.com/file/d/e2e-no-such-file/view', roleTitle: role.title,
      },
    };
  }

  const submit = (page: Page) => page.getByRole('button', { name: 'Add candidate', exact: true });
  const countCandidates = (email: string) => withDb(async c => (await c.query('SELECT count(*)::int AS n FROM candidates WHERE lower(email) = lower($1)', [email])).rows[0].n as number);

  test('an empty form is stopped by the browser, a bad e-mail too, and a whitespace-only value is stopped by the page with a toast naming the field', async ({ page, request }) => {
    const { values } = await arrangeForm(request);
    const posts = recordRequests(page, isPost('/api/candidates'));
    await gotoAs(page, 'hr', '/candidates');
    await page.getByRole('link', { name: 'Add candidate' }).click();
    await expect(page).toHaveURL(/\/candidates\/new$/);
    await expect(page.getByRole('heading', { name: 'Add candidate', level: 1 })).toBeVisible();

    await submit(page).click();                                                       // nothing filled in
    await expect(field(page, LABELS.name)).toBeFocused();                              // the first required field is where the browser stops
    expect(await page.evaluate(() => (document.querySelector('form') as HTMLFormElement).checkValidity())).toBe(false);

    await fillForm(page, { ...values, email: 'not-an-email' });
    await submit(page).click();
    await expect(field(page, LABELS.email)).toBeFocused();
    expect(await field(page, LABELS.email).evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);

    // The browser lets a value of only spaces through (it is "filled in"); the page's own trim check catches it, one field at a time.
    await field(page, LABELS.email).fill(values.email);
    const blanks: Array<[keyof typeof LABELS, string, string]> = [
      ['name', 'Full Name', values.name], ['phone', 'Phone Number', values.phone],
      ['company', 'Current Company', values.company], ['languages', 'Languages Known', values.languages],
    ];
    for (const [key, shown, good] of blanks) {
      await field(page, LABELS[key]).fill('   ');
      await submit(page).click();
      await expect(toastWith(page, `${shown} is required`)).toBeVisible();
      await field(page, LABELS[key]).fill(good);
    }
    await expect(page).toHaveURL(/\/candidates\/new$/);
    // all of that is still one page and no request has gone out: the form is valid again, so a real submit is the proof that none was pending
    expect(posts.requests).toHaveLength(0);
    expect(await countCandidates(values.email)).toBe(0);
  });

  test('a duplicate e-mail (in any letter case) names the existing candidate and keeps the form', async ({ page, request }) => {
    const { role, values } = await arrangeForm(request);
    const existing = await createApplicant(request, role.id, { email: values.email, full_name: `Existing Nf${uid()}` });
    await gotoAs(page, 'hr', '/candidates/new');
    await fillForm(page, { ...values, email: values.email.toUpperCase() });
    const reply = page.waitForResponse(r => r.url().endsWith('/api/candidates') && r.request().method() === 'POST');
    await submit(page).click();
    expect((await reply).status()).toBe(409);

    await expect(toastWith(page, `Duplicate — ${existing.name} already exists (${existing.candidate.id})`)).toBeVisible();
    await expect(page).toHaveURL(/\/candidates\/new$/);                               // nothing is lost: the form is still filled in
    await expect(field(page, LABELS.name)).toHaveValue(values.name);
    expect(await countCandidates(values.email)).toBe(1);                              // and still only the original
  });

  test('a valid form creates the candidate and the application, sends exactly the typed values and lands on the new candidate', async ({ page, request }) => {
    const { role, values } = await arrangeForm(request);
    const draft = await createRole(request);                                           // a Draft role: not offered, only live ones are
    cleanup.role(draft.id);
    const posts = recordRequests(page, isPost('/api/candidates'));
    await gotoAs(page, 'hr', '/candidates/new');
    const roleSelect = field(page, LABELS.role);
    await expect(roleSelect.locator('option', { hasText: role.title })).toHaveCount(1);
    await expect(roleSelect.locator('option', { hasText: draft.title })).toHaveCount(0);
    await expect(roleSelect.locator('option', { hasText: 'Senior Product Manager' })).toHaveCount(1);   // seeded live roles are

    await fillForm(page, values);
    await submit(page).click();

    await expect(toastWith(page, 'Candidate added')).toBeVisible();
    await expect(page).toHaveURL(/\/candidates\/C\d+$/);
    await expect(page.getByRole('heading', { name: values.name, level: 1 })).toBeVisible();
    expect(posts.bodies()).toEqual([{
      full_name: values.name, email: values.email, phone: values.phone, linkedin_url: null, role_id: role.id,
      source: null, sourced_by_agency_id: null, agency_id: null,
      current_ctc_fixed: 14.5, expected_ctc: 18, notice_period_days: 45,
      current_company: values.company, current_industry: values.industry, current_designation: null,
      current_location: values.location, years_of_experience: 6.5, preferred_location: values.preferred,
      languages_known: values.languages, resume_drive_link: values.resume,
    }]);

    const id = page.url().split('/').pop()!;
    const detail = await (await authed(request, await getToken(request, 'hr')).get(`/api/candidates/${id}`)).json();
    expect(detail.candidate).toMatchObject({
      full_name: values.name, email: values.email, phone: values.phone, current_company: values.company, notice_period_days: 45, gender: 'F',
    });
    expect(Number(detail.candidate.expected_ctc)).toBe(18);
    expect(detail.applications).toHaveLength(1);
    expect(detail.applications[0]).toMatchObject({ role_id: role.id, stage: 'Applied and Screened', status: 'Active' });
  });

  test('Source = Agency asks which agency and sends it; changing the Source away clears the agency', async ({ page, request }) => {
    const { values } = await arrangeForm(request);
    const posts = recordRequests(page, isPost('/api/candidates'));
    await gotoAs(page, 'hr', '/candidates/new');
    await expect(field(page, 'Sourcing Agency *')).toHaveCount(0);
    await field(page, 'Source').selectOption('Agency');
    await expect(field(page, 'Sourcing Agency *')).toBeVisible();                     // appears, and is required
    await field(page, 'Sourcing Agency *').selectOption('AGN001');
    await field(page, 'Source').selectOption('LinkedIn');                             // away from Agency: the field goes, and its value with it
    await expect(field(page, 'Sourcing Agency *')).toHaveCount(0);
    await fillForm(page, values);
    await submit(page).click();
    await expect(toastWith(page, 'Candidate added')).toBeVisible();
    expect(posts.bodies()[0]).toMatchObject({ source: 'LinkedIn', sourced_by_agency_id: null });

    // and the other way round, with a second candidate: Agency + a chosen agency is stored
    const second = await arrangeForm(request);
    await gotoAs(page, 'hr', '/candidates/new');
    await field(page, 'Source').selectOption('Agency');
    await field(page, 'Sourcing Agency *').selectOption('AGN001');
    await fillForm(page, second.values);
    await submit(page).click();
    await expect(toastWith(page, 'Candidate added').last()).toBeVisible();
    await expect(page).toHaveURL(/\/candidates\/C\d+$/);
    expect(posts.bodies()[1]).toMatchObject({ source: 'Agency', sourced_by_agency_id: 'AGN001' });
    const id = page.url().split('/').pop()!;
    const { candidate } = await (await authed(request, await getToken(request, 'hr')).get(`/api/candidates/${id}`)).json();
    expect(candidate).toMatchObject({ source: 'Agency', sourced_by_agency_id: 'AGN001' });
  });

  test('Cancel goes back to the Candidates list without creating anything', async ({ page, request }) => {
    const { values } = await arrangeForm(request);
    await gotoAs(page, 'hr', '/candidates/new');
    await field(page, LABELS.name).fill(values.name);
    await field(page, LABELS.email).fill(values.email);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/candidates$/);
    await expect(page.getByRole('heading', { name: 'Active Candidates' })).toBeVisible();
    expect(await countCandidates(values.email)).toBe(0);
  });

  test('TODAY a Hiring Manager who opens /candidates/new is shown the whole form; submitting it fails with a generic toast and creates nothing', async ({ page, request }) => {
    const { values } = await arrangeForm(request);
    await gotoAs(page, 'hm_alex', '/candidates');
    await expect(page.getByRole('heading', { name: 'Active Candidates' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add candidate' })).toHaveCount(0);   // no link ...
    await gotoAs(page, 'hm_alex', '/candidates/new');                                  // ... but no route guard either
    await expect(page.getByRole('heading', { name: 'Add candidate', level: 1 })).toBeVisible();
    await fillForm(page, values);
    const reply = page.waitForResponse(r => r.url().endsWith('/api/candidates') && r.request().method() === 'POST');
    await submit(page).click();
    expect((await reply).status()).toBe(403);
    await expect(toastWith(page, 'Failed to add candidate')).toBeVisible();
    await expect(page).toHaveURL(/\/candidates\/new$/);
    expect(await countCandidates(values.email)).toBe(0);
  });
});
