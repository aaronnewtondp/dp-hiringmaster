/**
 * E2E — the Active Candidates list (selection, bulk actions, the Gender filter) and the Archived Pipeline (filters, Reactivate)
 *
 * Candidates.tsx and TalentPool.tsx are two of three hand-written candidate tables that share no component, so nothing but a browser test
 * notices when one of them stops matching the others. Until now nothing in a browser touched row selection, the bulk modals, the Gender
 * filter's "Not tagged" union (API-tested only, api/40) or Reactivate.
 *
 * Data: every test makes its own role and its own candidates through the API, with a marker in each name. The pages are searched by that
 * marker, so the tests see exactly their own rows however large the database has grown (the list is capped at 100 newest/best rows).
 * Gender comes from the server's own classifier: the first names below are ones it tags M, F or leaves untagged; the fixture asserts that,
 * so a changed dictionary stops here with a clear message instead of failing a filter test.
 */
import { gotoAs } from '../helpers/e2e';
import { authed, getToken, uid } from '../helpers/api';
import { withDb } from '../helpers/db';
import {
  test, expect, Cleanup, createRole, createApplicant, moveToStage, getApp, dialogWith, toastWith, recordRequests, queryValues,
  isPost, hrApi, setRoleStatus, Applicant,
} from '../helpers/e2e-candidates';
import type { Page, APIRequestContext, Locator } from '@playwright/test';

const cleanup = new Cleanup();
test.afterAll(() => cleanup.purge());

type Kind = 'M' | 'F' | 'U';
const FIRST_NAMES: Record<Kind, string[]> = { M: ['Rahul', 'Ravi', 'Rohit'], F: ['Priya', 'Meera', 'Anita'], U: ['Kiran', 'Xylo', 'Zqxv'] };

interface Batch { marker: string; search: string; role: { id: string; title: string }; people: Array<Applicant & { kind: Kind; appId: string }> }

/** A role of its own and one candidate per entry of `kinds`, all findable by `batch.search`. `over` = expected CTC 30 against the 10-20 LPA band. */
async function makeBatch(
  request: APIRequestContext, kinds: Array<Kind | `${Kind}-over`>, roleOver: Record<string, unknown> = {},
  { marker = uid(), offset = 0 }: { marker?: string; offset?: number } = {},   // a second batch can share the marker (offset picks different first names)
): Promise<Batch> {
  const role = await createRole(request, roleOver);
  cleanup.role(role.id);
  const used: Record<Kind, number> = { M: offset, F: offset, U: offset };
  const people: Batch['people'] = [];
  for (const entry of kinds) {
    const kind = entry.slice(0, 1) as Kind;
    const first = FIRST_NAMES[kind][used[kind]++];
    const a = await createApplicant(request, role.id, { full_name: `${first} Bk${marker}`, expected_ctc: entry.endsWith('-over') ? 30 : 15 });
    cleanup.email(a.email);
    expect(a.candidate.gender ?? null, `the classifier must tag ${first} as ${kind === 'U' ? 'unknown' : kind}`).toBe(kind === 'U' ? null : kind);
    people.push({ ...a, kind, appId: a.application.id });
  }
  return { marker, search: `Bk${marker}`, role, people };
}

const searchBox = (page: Page) => page.getByPlaceholder('Search by name or role…');
const rowOf = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

/** The Active Candidates page, searched down to this batch's rows. */
async function openCandidates(page: Page, who: Parameters<typeof gotoAs>[1], b: Batch, expectedRows: number) {
  await gotoAs(page, who, '/candidates');
  await searchAndWait(page, searchBox(page), b.search);
  // Nothing but this batch matches its marker, so once the filtered answer is in, the table body IS the batch.
  await expect(page.locator('tbody tr')).toHaveCount(expectedRows);
  await expect(rowOf(page, b.search)).toHaveCount(expectedRows);
}

/** Type into a search box and wait for the server's answer to THAT search (the box is debounced; rows from the unfiltered list may match too). */
async function searchAndWait(page: Page, box: Locator, text: string) {
  const answered = page.waitForResponse(r => /\/api\/(applications|candidates)(\?|$)/.test(r.url()) && new URL(r.url()).searchParams.get('q') === text);
  await box.fill(text);
  await answered;
}

const selectedBar = (page: Page) => page.getByText(/^\d+ selected$/);
const headerCheckbox = (page: Page) => page.locator('thead').getByRole('checkbox');
const rowCheckbox = (page: Page, text: string) => rowOf(page, text).getByRole('checkbox');
/** Tick the checkbox of every person of the batch (or the given ones). */
async function selectPeople(page: Page, people: Batch['people']) {
  for (const p of people) await rowCheckbox(page, p.name).check();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Active Candidates: selection', () => {

  test('row and select-all checkboxes drive the selection bar; Clear empties it', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    await openCandidates(page, 'hr', b, 3);

    await expect(selectedBar(page)).toHaveCount(0);                                  // nothing selected: no bar
    await expect(headerCheckbox(page)).not.toBeChecked();

    await rowCheckbox(page, b.people[0].name).check();
    await expect(selectedBar(page)).toHaveText('1 selected');
    await expect(page.getByRole('button', { name: 'Change Stage' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change Status' })).toBeVisible();
    await expect(headerCheckbox(page)).not.toBeChecked();
    expect(await headerCheckbox(page).evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);   // some, not all

    await headerCheckbox(page).check();                                              // select all visible
    await expect(selectedBar(page)).toHaveText('3 selected');
    for (const p of b.people) await expect(rowCheckbox(page, p.name)).toBeChecked();
    expect(await headerCheckbox(page).evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);

    await headerCheckbox(page).uncheck();                                            // and none
    await expect(selectedBar(page)).toHaveCount(0);
    for (const p of b.people) await expect(rowCheckbox(page, p.name)).not.toBeChecked();

    await rowCheckbox(page, b.people[1].name).check();
    await rowCheckbox(page, b.people[2].name).check();
    await expect(selectedBar(page)).toHaveText('2 selected');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(selectedBar(page)).toHaveCount(0);
    for (const p of b.people) await expect(rowCheckbox(page, p.name)).not.toBeChecked();
  });

  test('a Hiring Manager gets neither checkboxes nor the Add candidate link; HR gets both', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F']);
    await openCandidates(page, 'hr', b, 2);
    await expect(page.getByRole('link', { name: 'Add candidate' })).toBeVisible();
    await expect(rowCheckbox(page, b.people[0].name)).toBeVisible();

    await openCandidates(page, 'hm_alex', b, 2);                                     // the rows are there to read
    await expect(page.getByRole('link', { name: 'Add candidate' })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(selectedBar(page)).toHaveCount(0);
  });

  test('the search, stage and filters survive leaving the page and coming back in the same session', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F']);
    await openCandidates(page, 'hr', b, 2);
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'All stages' }) }).selectOption('Applied and Screened');
    await page.getByRole('button', { name: /^Gender/ }).click();
    await page.getByRole('checkbox', { name: 'Female' }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Active Candidates' }).click();          // close the panel by clicking away
    await expect(rowOf(page, b.search)).toHaveCount(1);

    await page.getByRole('link', { name: 'Dashboard' }).click();                     // client-side navigation: the page unmounts
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole('link', { name: 'Active Candidates' }).click();
    await expect(searchBox(page)).toHaveValue(b.search);
    await expect(page.getByRole('button', { name: /^Gender\s*1$/ })).toBeVisible();
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, b.people[1].name)).toBeVisible();                        // Priya, the one Female
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Active Candidates: bulk stage', () => {

  test('moving in-band candidates to Interview Round 1 asks for no reason, sends one request each and reports the count', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U', 'M-over']);                   // the over-budget row exists but is NOT selected
    const posts = recordRequests(page, isPost('/stage'));
    await openCandidates(page, 'hr', b, 4);
    await selectPeople(page, b.people.slice(0, 3));
    await expect(selectedBar(page)).toHaveText('3 selected');

    await page.getByRole('button', { name: 'Change Stage' }).click();
    const dialog = dialogWith(page, 'Update stage');
    await expect(dialog).toContainText('3 candidates');
    await expect(dialog.getByRole('combobox')).toHaveValue('Applied and Screened');
    await dialog.getByRole('combobox').selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(1);                       // no budget panel: nobody selected is over the line
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, '3 of 3 updated to Interview Round 1')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(selectedBar(page)).toHaveCount(0);                                  // the selection is cleared
    expect(posts.requests.map(r => r.url().match(/applications\/(A\d+)\/stage/)?.[1]).sort()).toEqual(b.people.slice(0, 3).map(p => p.appId).sort());
    for (const body of posts.bodies()) expect(body).toEqual({ new_stage: 'Interview Round 1' });
    for (const p of b.people.slice(0, 3)) {
      expect((await getApp(request, p.appId)).stage).toBe('Interview Round 1');
      await expect(rowOf(page, p.name)).toContainText('Interview Round 1');
    }
    expect((await getApp(request, b.people[3].appId)).stage).toBe('Applied and Screened');   // the unselected row did not move
  });

  test('an over-budget row in the selection makes the reason mandatory, and the reason goes with the request', async ({ page, request }) => {
    const b = await makeBatch(request, ['M-over']);
    const posts = recordRequests(page, isPost('/stage'));
    await openCandidates(page, 'hr', b, 1);
    await selectPeople(page, b.people);
    await page.getByRole('button', { name: 'Change Stage' }).click();
    const dialog = dialogWith(page, 'Update stage');
    const update = dialog.getByRole('button', { name: 'Update', exact: true });

    await dialog.getByRole('combobox').selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(2);                       // the reason picker appears
    await expect(update).toBeDisabled();
    await dialog.getByRole('combobox').nth(1).selectOption('Business-critical urgency to fill role');
    await dialog.getByPlaceholder('Optional context…').fill('E2E: bulk exception');
    await expect(update).toBeEnabled();
    await update.click();

    await expect(toastWith(page, '1 of 1 updated to Interview Round 1')).toBeVisible();
    expect(posts.bodies()).toEqual([{
      new_stage: 'Interview Round 1', budget_exception_reason_cat: 'Business-critical urgency to fill role', budget_exception_reason_detail: 'E2E: bulk exception',
    }]);
    const app = await getApp(request, b.people[0].appId);
    expect(app).toMatchObject({ stage: 'Interview Round 1', budget_exception_reason_cat: 'Business-critical urgency to fill role' });
  });

  test('the reason picker follows the stage: it is for Interview Round 1 only', async ({ page, request }) => {
    const b = await makeBatch(request, ['M-over']);
    await openCandidates(page, 'hr', b, 1);
    await selectPeople(page, b.people);
    await page.getByRole('button', { name: 'Change Stage' }).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Interview Round 2');
    await expect(dialog.getByRole('combobox')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await dialog.getByRole('combobox').first().selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Cancel' }).click();                    // Cancel forgets the choice
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Change Stage' }).click();
    await dialogWith(page, 'Update stage').getByRole('combobox').first().selectOption('Interview Round 1');
    await expect(dialogWith(page, 'Update stage').getByRole('combobox').nth(1)).toHaveValue('');   // the reason was reset
  });

  test('TODAY with one over-budget row in a mixed selection, the reason is sent for, and stored on, every selected application', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'M-over']);
    const posts = recordRequests(page, isPost('/stage'));
    await openCandidates(page, 'hr', b, 3);
    await headerCheckbox(page).check();
    await page.getByRole('button', { name: 'Change Stage' }).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Interview Round 1');
    await dialog.getByRole('combobox').nth(1).selectOption('Leadership-approved exception');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, '3 of 3 updated to Interview Round 1')).toBeVisible();

    expect(posts.bodies()).toHaveLength(3);
    for (const body of posts.bodies()) expect(body).toMatchObject({ budget_exception_reason_cat: 'Leadership-approved exception' });
    for (const p of b.people) {                                                      // TODAY: in-band candidates carry an "over-budget exception" too
      expect((await getApp(request, p.appId)).budget_exception_reason_cat).toBe('Leadership-approved exception');
    }
  });

  test('a row the server refuses is reported in the count and the others still move', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    const refused = b.people[1];
    await page.route(`**/api/applications/${refused.appId}/stage`, route => route.fulfill({ status: 400, json: { error: 'refused for the test' } }));
    await openCandidates(page, 'hr', b, 3);
    await headerCheckbox(page).check();
    await page.getByRole('button', { name: 'Change Stage' }).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Interview Round 2');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, '2 of 3 updated to Interview Round 2')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect((await getApp(request, refused.appId)).stage).toBe('Applied and Screened');
    expect((await getApp(request, b.people[0].appId)).stage).toBe('Interview Round 2');
    expect((await getApp(request, b.people[2].appId)).stage).toBe('Interview Round 2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Active Candidates: bulk status', () => {

  test('bulk reject needs a reason; with two reasons every selected application is rejected and leaves the Active list', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    const posts = recordRequests(page, isPost('/status'));
    await openCandidates(page, 'hr', b, 3);
    await headerCheckbox(page).check();

    await page.getByRole('button', { name: 'Change Status' }).click();
    const dialog = dialogWith(page, 'Update status');
    await expect(dialog).toContainText('3 candidates');
    await dialog.getByRole('combobox').selectOption('Rejected');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Select at least one reason')).toBeVisible();

    await dialog.getByRole('checkbox', { name: 'Missing mandatory skill' }).check();
    await dialog.getByRole('checkbox', { name: 'Short average tenure' }).check();
    await dialog.getByPlaceholder('Additional detail (optional)').fill('E2E: bulk reject');
    await expect(dialog.getByRole('checkbox', { name: /Send rejection email to candidates/ })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, '3 of 3 updated to Rejected')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(posts.bodies()).toHaveLength(3);                                          // the empty attempt sent nothing
    for (const body of posts.bodies()) {
      expect(body).toEqual({
        new_status: 'Rejected', rejection_reason_cats: ['Missing mandatory skill', 'Short average tenure'],
        rejection_reason_cat: 'Missing mandatory skill; Short average tenure', rejection_reason_detail: 'E2E: bulk reject',
      });
    }
    for (const p of b.people) {
      expect(await getApp(request, p.appId)).toMatchObject({ status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill; Short average tenure' });
    }
    await expect(page.getByText('No candidates match')).toBeVisible();               // Rejected leaves the Active list (it is in Archived Pipeline)
    await expect(selectedBar(page)).toHaveCount(0);
  });

  test('bulk Hold for Future changes only the selected rows and keeps them in the Active list', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    const posts = recordRequests(page, isPost('/status'));
    await openCandidates(page, 'hr', b, 3);
    await selectPeople(page, b.people.slice(0, 2));
    await page.getByRole('button', { name: 'Change Status' }).click();
    const dialog = dialogWith(page, 'Update status');
    await dialog.getByRole('combobox').selectOption('Hold for Future');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, '2 of 2 updated to Hold for Future')).toBeVisible();
    expect(posts.bodies()).toEqual([{ new_status: 'Hold for Future' }, { new_status: 'Hold for Future' }]);
    expect((await getApp(request, b.people[0].appId)).status).toBe('Hold for Future');
    expect((await getApp(request, b.people[1].appId)).status).toBe('Hold for Future');
    expect((await getApp(request, b.people[2].appId)).status).toBe('Active');         // not selected
    await expect(rowOf(page, b.search)).toHaveCount(3);                               // Hold for Future is not archived: all three rows stay
  });

  test('TODAY bulk withdraw takes one reason from a dropdown and stores it in the rejection column, like the single flow', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F']);
    const posts = recordRequests(page, isPost('/status'));
    await openCandidates(page, 'hr', b, 2);
    await headerCheckbox(page).check();
    await page.getByRole('button', { name: 'Change Status' }).click();
    const dialog = dialogWith(page, 'Update status');
    await dialog.getByRole('combobox').first().selectOption('Withdrawn');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Select at least one reason')).toBeVisible();
    await dialog.getByRole('combobox').nth(1).selectOption('Accepted another offer');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, '2 of 2 updated to Withdrawn')).toBeVisible();

    for (const body of posts.bodies()) {
      expect(body).toEqual({ new_status: 'Withdrawn', rejection_reason_cats: ['Accepted another offer'], rejection_reason_cat: 'Accepted another offer' });
    }
    for (const p of b.people) {
      const app = await getApp(request, p.appId);
      expect(app.status).toBe('Withdrawn');
      expect(app.rejection_reason_cat).toBe('Accepted another offer');
      expect(app.withdrawal_reason_cat).toBeNull();                                  // TODAY: see the single-withdraw test in e2e/10
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Gender filter (Active Candidates)', () => {

  test('Male, Female and Not tagged filter the rows; Male + Not tagged is the union; the badge counts and Clear resets', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    const [male, female, unknown] = b.people;
    await openCandidates(page, 'hr', b, 3);
    const genderCell = (name: string) => rowOf(page, name).getByRole('cell').nth(2);   // checkbox, candidate, GENDER
    await expect(genderCell(male.name)).toHaveText('M');
    await expect(genderCell(female.name)).toHaveText('F');
    await expect(genderCell(unknown.name)).toHaveText('—');

    const filter = page.getByRole('button', { name: /^Gender/ });
    await filter.click();
    await expect(page.getByRole('checkbox', { name: 'Male', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Female' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Not tagged' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Male', exact: true }).check();
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, male.name)).toBeVisible();
    await expect(filter).toHaveText(/Gender\s*1/);                                     // the count badge

    const union = page.waitForRequest(r => r.url().includes('/api/applications') && queryValues(r.url(), 'gender').length === 2);
    await page.getByRole('checkbox', { name: 'Not tagged' }).check();
    expect(queryValues((await union).url(), 'gender').sort()).toEqual(['M', 'UNKNOWN']);   // 'Not tagged' travels as the UNKNOWN sentinel
    await expect(rowOf(page, b.search)).toHaveCount(2);
    await expect(rowOf(page, male.name)).toBeVisible();
    await expect(rowOf(page, unknown.name)).toBeVisible();
    await expect(rowOf(page, female.name)).toHaveCount(0);
    await expect(filter).toHaveText(/Gender\s*2/);

    await page.getByRole('checkbox', { name: 'Male', exact: true }).uncheck();                      // Not tagged alone
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, unknown.name)).toBeVisible();

    await page.getByRole('checkbox', { name: 'Not tagged' }).uncheck();
    await page.getByRole('checkbox', { name: 'Female' }).check();                      // Female alone
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, female.name)).toBeVisible();

    await page.getByRole('button', { name: 'Clear gender' }).click();
    await expect(rowOf(page, b.search)).toHaveCount(3);
    await expect(filter).toHaveText(/^Gender$/);                                       // no badge any more
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Archived Pipeline', () => {
  const openPool = async (page: Page, who: Parameters<typeof gotoAs>[1], b: Batch) => {
    await gotoAs(page, who, '/talent-pool');
    await expect(page.getByRole('heading', { name: 'Archived Pipeline' })).toBeVisible();
    await searchAndWait(page, page.getByPlaceholder('Search by name, email, or phone…'), b.search);
  };
  const reject = async (request: APIRequestContext, appId: string, reasons = ['Communication gap']) =>
    expect((await (await hrApi(request)).post(`/api/applications/${appId}/status`, { new_status: 'Rejected', rejection_reason_cats: reasons })).status()).toBe(200);

  test('Hold for Future and Archived are separate modes with their own counts, rows, Status column and Gender column', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U', 'M']);
    const [rejected, withdrawn, held, active] = b.people;
    await reject(request, rejected.appId);
    expect((await (await hrApi(request)).post(`/api/applications/${withdrawn.appId}/status`, { new_status: 'Withdrawn', withdrawal_reason_cat: 'Personal reasons' })).status()).toBe(200);
    expect((await (await hrApi(request)).post(`/api/applications/${held.appId}/status`, { new_status: 'Hold for Future' })).status()).toBe(200);

    await openPool(page, 'hr', b);                                                    // the default mode
    await expect(page.getByText('1 on hold for future roles')).toBeVisible();
    await expect(rowOf(page, held.name)).toBeVisible();
    await expect(rowOf(page, held.name)).toContainText('Hold for Future');
    await expect(rowOf(page, rejected.name)).toHaveCount(0);
    await expect(rowOf(page, active.name)).toHaveCount(0);                            // an Active application is in neither pool

    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(page.getByText('2 archived candidates (rejected/withdrawn)')).toBeVisible();
    await expect(rowOf(page, rejected.name)).toContainText('Rejected');
    await expect(rowOf(page, withdrawn.name)).toContainText('Withdrawn');
    await expect(rowOf(page, held.name)).toHaveCount(0);
    await expect(rowOf(page, rejected.name).getByRole('cell').nth(1)).toHaveText('M');   // CANDIDATE, GENDER
    await expect(rowOf(page, withdrawn.name).getByRole('cell').nth(1)).toHaveText('F');
  });

  test('the archive filters narrow the list: Gender with Not tagged, Role, Tag, and Search; Clear brings rows back', async ({ page, request }) => {
    const b = await makeBatch(request, ['M', 'F', 'U']);
    const other = await makeBatch(request, ['M'], {}, { marker: b.marker, offset: 1 });   // a second role, same marker: the Role filter has something to tell apart
    const all = [...b.people, ...other.people];
    for (const p of all) await reject(request, p.appId);
    const tagged = b.people[0];
    const tag = `e2e-tag-${b.marker}`;
    expect((await (await hrApi(request)).patch(`/api/candidates/${tagged.candidate.id}`, { hr_tags: [tag] })).status()).toBe(200);

    await gotoAs(page, 'hr', '/talent-pool');
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    const search = page.getByPlaceholder('Search by name, email, or phone…');
    await searchAndWait(page, search, b.search);                                      // both batches carry this marker
    await expect(rowOf(page, b.search)).toHaveCount(4);

    // Gender: Female + Not tagged, over both batches
    await page.getByRole('button', { name: /^Gender/ }).click();
    await page.getByRole('checkbox', { name: 'Female' }).check();
    await page.getByRole('checkbox', { name: 'Not tagged' }).check();
    await expect(rowOf(page, b.search)).toHaveCount(2);
    await expect(rowOf(page, b.people[1].name)).toBeVisible();
    await expect(rowOf(page, b.people[2].name)).toBeVisible();
    await expect(rowOf(page, b.people[0].name)).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear gender' }).click();
    await page.getByRole('heading', { name: 'Archived Pipeline' }).click();          // close the panel
    await expect(rowOf(page, b.search)).toHaveCount(4);

    // Role
    await page.getByRole('button', { name: /^Role/ }).click();
    await page.getByRole('checkbox', { name: other.role.title }).check();
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, other.people[0].name)).toBeVisible();
    await page.getByRole('button', { name: 'Clear role' }).click();
    await page.getByRole('heading', { name: 'Archived Pipeline' }).click();
    await expect(rowOf(page, b.search)).toHaveCount(4);

    // Tag (an exact match on the candidate's own tags)
    await page.getByPlaceholder('Tag', { exact: true }).fill(tag);
    await expect(rowOf(page, b.search)).toHaveCount(1);
    await expect(rowOf(page, tagged.name)).toBeVisible();
    await page.getByPlaceholder('Tag', { exact: true }).fill('');
    await expect(rowOf(page, b.search)).toHaveCount(4);

    // Search narrows the headline count too (it counts candidates matching the filters)
    await searchAndWait(page, search, b.people[2].name);
    await expect(page.getByText('1 archived candidates (rejected/withdrawn)')).toBeVisible();
  });

  test('Reactivate links an archived candidate to another live role: the request, toast and the new application', async ({ page, request }) => {
    const from = await makeBatch(request, ['M']);
    const target = await createRole(request, { status: 'Live – Sourcing' });
    cleanup.role(target.id);
    await setRoleStatus(from.role.id, 'Live – Sourcing');                             // the role the candidate already applied to is live too
    const person = from.people[0];
    await reject(request, person.appId);
    const links = recordRequests(page, isPost(`/api/candidates/${person.candidate.id}/applications`));

    await gotoAs(page, 'hr', '/talent-pool');
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await searchAndWait(page, page.getByPlaceholder('Search by name, email, or phone…'), from.search);
    await expect(rowOf(page, person.name)).toHaveCount(1);
    await rowOf(page, person.name).getByRole('button', { name: 'Reactivate' }).click();

    const dialog = dialogWith(page, `Link ${person.name} to a role`);
    const choose = dialog.getByRole('combobox');
    const link = dialog.getByRole('button', { name: 'Link', exact: true });
    await expect(link).toBeDisabled();                                                // no role picked yet
    await expect(choose.locator('option', { hasText: target.title })).toHaveCount(1);          // the other live role is offered ...
    await expect(choose.locator('option', { hasText: from.role.title })).toHaveCount(0);       // ... the one already applied to is not
    await expect(choose.locator('option', { hasText: 'Senior Product Manager' })).toHaveCount(1);   // seeded live roles are
    await choose.selectOption({ label: target.title });
    await link.click();

    await expect(toastWith(page, 'Candidate linked to role')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(links.bodies()).toEqual([{ role_id: target.id, source_channel: 'Talent Pool Reactivation' }]);
    await expect(rowOf(page, person.name)).toHaveCount(2);                            // the list re-read: the archived row and the new one

    const res = await authed(request, await getToken(request, 'hr')).get(`/api/candidates/${person.candidate.id}`);
    const { applications } = await res.json();
    expect(applications).toHaveLength(2);
    const fresh = applications.find((a: { role_id: string }) => a.role_id === target.id);
    expect(fresh).toMatchObject({ stage: 'Applied and Screened', status: 'Active', source_channel: 'Talent Pool Reactivation' });
    expect(applications.find((a: { role_id: string }) => a.role_id === from.role.id).status).toBe('Rejected');   // the archived one is untouched
  });

  test('Reactivate is HR-tier only: a Hiring Manager sees the same rows without the action', async ({ page, request }) => {
    const b = await makeBatch(request, ['F']);
    await reject(request, b.people[0].appId);
    await openPool(page, 'hr', b);
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(rowOf(page, b.people[0].name).getByRole('button', { name: 'Reactivate' })).toBeVisible();

    await openPool(page, 'hm_alex', b);
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(rowOf(page, b.people[0].name)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
  });
});
