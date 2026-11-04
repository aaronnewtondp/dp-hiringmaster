/**
 * E2E — the action modals on a candidate's page (CandidateDetail.tsx and the modals it opens)
 *
 * Every stage / status / feedback action used to be exercised through the API only, so a wiring regression (the wrong payload, a modal that
 * never closes, a missing toast) shipped unseen. Each test here drives the real UI and then checks three things that must agree:
 *   1. the exact request body the browser sent (captured, never inferred),
 *   2. what the user was shown (toast, badge, row),
 *   3. what the API now stores.
 *
 * Every test builds its own role, candidate and application through the API (no scheduled_date anywhere, so no Calendar call), and
 * the stack has no Gmail: an Assignment round's e-mail fails by design (see helpers/e2e-candidates.ts), so nothing is ever sent.
 * Wording is asserted only where it is a button or label the test clicks, or an error message the server owns; Help text and tooltips never.
 *
 * Tests whose title contains TODAY pin what the product does now where that looks unintended; each is listed in the run report.
 */
import { gotoAs } from '../helpers/e2e';
import { authed, getToken, USERS } from '../helpers/api';
import { withDb } from '../helpers/db';
import {
  test, expect, Cleanup, STAGES, createRole, createApplicant, moveToStage, getApp, getRounds, getRefChecks,
  createStandardRound, createAssignmentRound, markAssignmentSent, dialogWith, toastWith, recordRequests, isPost, isPatch,
  expectCandidatePage, hrApi, Applicant,
} from '../helpers/e2e-candidates';
import type { Page, APIRequestContext } from '@playwright/test';

const cleanup = new Cleanup();
test.afterAll(() => cleanup.purge());

interface Arranged extends Applicant { appId: string; role: { id: string; title: string } & Record<string, unknown> }

/** A fresh role (band 10-20 LPA, Hiring Manager "Alex"), a candidate on it, optionally already at `stage`. */
async function arrange(
  request: APIRequestContext,
  { stage, role = {}, candidate = {} }: { stage?: string; role?: Record<string, unknown>; candidate?: Record<string, unknown> } = {},
): Promise<Arranged> {
  const r = await createRole(request, role);
  cleanup.role(r.id);
  const a = await createApplicant(request, r.id, candidate);
  cleanup.email(a.email);
  if (stage) await moveToStage(request, a.application.id, stage);
  return { ...a, appId: a.application.id as string, role: r };
}

async function open(page: Page, who: keyof typeof USERS, a: Arranged) {
  await gotoAs(page, who, `/candidates/${a.candidate.id}`);
  await expectCandidatePage(page, a.name);
}

const stageButton  = (page: Page) => page.getByRole('button', { name: 'Stage', exact: true });
const statusButton = (page: Page) => page.getByRole('button', { name: 'Status', exact: true });
const stageBadge   = (page: Page, stage: string) => page.locator(`span[title="${stage}"]`);
/** The row of one interview round in the Interview rounds list. */
const roundRow = (page: Page, roundName: string) => page.locator('div.rounded-lg.bg-gray-50.border').filter({ hasText: roundName });
const applicationsCard = (page: Page) => page.locator('div.card').filter({ has: page.getByRole('heading', { name: /^Applications \(/ }) });
/** One EditableSection card (they are `card p-5`; the Applications card that can contain one is not). */
const sectionCard = (page: Page, title: string) => page.locator('div.card.p-5').filter({ has: page.getByRole('heading', { name: title, level: 2 }) });

/** Submit feedback for a round straight through the API (as HR), to get a pending round out of the way without moving the stage. */
async function submitFeedbackViaApi(request: APIRequestContext, roundId: string) {
  const res = await (await hrApi(request)).patch(`/api/interviews/${roundId}/feedback`, {
    eval_areas_assessed: ['Technical Knowledge'], scores_per_area: { 'Technical Knowledge': 3 },
    overall_assessment: 'Neutral', confidence_level: 'Medium', round_recommendation: 'Hold',
  });
  expect(res.status(), await res.text()).toBe(200);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Stage modal', () => {

  test('HR moves a candidate to another stage: the request, toast, badge, record and timeline agree', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/stage`));
    await open(page, 'hr', a);

    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    const select = dialog.getByRole('combobox');
    await expect(select).toHaveValue('Applied and Screened');            // opens on the current stage
    await expect(select.locator('option')).toHaveText(STAGES);          // the 11 live stages in order — no retired Resume Review / Shortlisted
    await select.selectOption('Interview Round 2');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, 'Stage updated to Interview Round 2')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(stageBadge(page, 'Interview Round 2')).toBeVisible();   // the application card re-read the record
    expect(posts.bodies()).toEqual([{ new_stage: 'Interview Round 2' }]); // nothing else rides along (no skip reason, no budget reason)

    expect((await getApp(request, a.appId)).stage).toBe('Interview Round 2');
    await page.reload();
    await expect(page.getByText('Stage → Interview Round 2')).toBeVisible();   // the activity timeline has the move
  });

  test('Cancel closes the modal without sending anything', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost('/stage'));
    await open(page, 'hr', a);
    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Founders Round');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    // Opening it again shows the application's own stage, not the abandoned choice; this round trip also gives a stray request time to show up.
    await stageButton(page).click();
    await expect(dialogWith(page, 'Update stage').getByRole('combobox')).toHaveValue('Applied and Screened');
    expect(posts.requests).toHaveLength(0);
    expect((await getApp(request, a.appId)).stage).toBe('Applied and Screened');
  });

  test('a candidate 15%+ over the band cannot be shortlisted to Interview Round 1 without a reason, and the reason is stored', async ({ page, request }) => {
    // band 10-20 LPA: the line is 23 LPA; this candidate expects 30
    const a = await arrange(request, { candidate: { expected_ctc: 30 } });
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/stage`));
    await open(page, 'hr', a);
    await expect(page.getByText('Over Budget')).toBeVisible();           // the badge next to the ₹ figures

    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    const update = dialog.getByRole('button', { name: 'Update', exact: true });
    await expect(dialog.getByRole('combobox')).toHaveCount(1);           // another stage: no reason asked
    await dialog.getByRole('combobox').first().selectOption('Interview Round 2');
    await expect(update).toBeEnabled();

    await dialog.getByRole('combobox').first().selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(2);           // the reason picker appears for Interview Round 1 only
    await expect(update).toBeDisabled();                                 // and Update waits for it
    await dialog.getByRole('combobox').nth(1).selectOption('Leadership-approved exception');
    await expect(update).toBeEnabled();
    await dialog.getByPlaceholder('Optional context…').fill('E2E: approved by the founder');
    await update.click();

    await expect(toastWith(page, 'Stage updated to Interview Round 1')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(posts.bodies()).toEqual([{
      new_stage: 'Interview Round 1',
      budget_exception_reason_cat: 'Leadership-approved exception',
      budget_exception_reason_detail: 'E2E: approved by the founder',
    }]);
    const app = await getApp(request, a.appId);
    expect(app.stage).toBe('Interview Round 1');
    expect(app.budget_exception_reason_cat).toBe('Leadership-approved exception');
    expect(app.budget_exception_reason_detail).toBe('E2E: approved by the founder');
    await page.reload();
    await expect(page.getByText('Stage → Interview Round 1 (over-budget exception: Leadership-approved exception)')).toBeVisible();
  });

  test('a candidate just under the 15% line is shortlisted with no reason at all', async ({ page, request }) => {
    const a = await arrange(request, { candidate: { expected_ctc: 22 } });   // 22 < 23
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/stage`));
    await open(page, 'hr', a);
    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Stage updated to Interview Round 1')).toBeVisible();
    expect(posts.bodies()).toEqual([{ new_stage: 'Interview Round 1' }]);
    expect((await getApp(request, a.appId)).budget_exception_reason_cat).toBeFalsy();
  });

  test('a candidate exactly on the 15% line (23 LPA against a 10-20 band) is already asked for a reason', async ({ page, request }) => {
    const a = await arrange(request, { candidate: { expected_ctc: 23 } });
    await open(page, 'hr', a);
    await expect(page.getByText('Over Budget')).toBeVisible();
    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').first().selectOption('Interview Round 1');
    await expect(dialog.getByRole('combobox')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  });

  test('TODAY the Stage modal has no skip-reason control: a move blocked by pending feedback shows the server\'s reason and waits for the feedback', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Pending Round ${a.role.id}` });
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/stage`));
    await open(page, 'hr', a);

    await stageButton(page).click();
    const dialog = dialogWith(page, 'Update stage');
    await dialog.getByRole('combobox').selectOption('Interview Round 2');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    // The server's own message names the round; the modal stays open and the stage does not move.
    await expect(toastWith(page, 'Feedback is still pending for')).toContainText(round.round_name);
    await expect(dialog).toBeVisible();
    expect((await getApp(request, a.appId)).stage).toBe('Interview Round 1');
    // The only inputs are the stage and (for an over-budget move) the budget reason: nothing lets HR give a reason to skip the gate.
    await expect(dialog.getByRole('combobox')).toHaveCount(1);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);

    await submitFeedbackViaApi(request, round.id);
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Stage updated to Interview Round 2')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // Both attempts carried exactly the same body: the UI never sends skip_reason (the API supports it; no screen offers it).
    expect(posts.bodies()).toEqual([{ new_stage: 'Interview Round 2' }, { new_stage: 'Interview Round 2' }]);
    expect((await getApp(request, a.appId)).stage).toBe('Interview Round 2');
  });

  test('Reference Check: leaving the stage needs a reference; the Add modal validates, records it, and unblocks the move', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Reference Check' });
    const stagePosts = recordRequests(page, isPost(`/api/applications/${a.appId}/stage`));
    const refPosts = recordRequests(page, isPost('/api/ref-checks'));
    await open(page, 'hr', a);
    await expect(page.getByText('No reference checks added yet.')).toBeVisible();

    // blocked: no reference on file
    await stageButton(page).click();
    const stageDialog = dialogWith(page, 'Update stage');
    await stageDialog.getByRole('combobox').selectOption('Pre-Joining Documents');
    await stageDialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Add at least one reference check before advancing this candidate.')).toBeVisible();
    await stageDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(stageDialog).toHaveCount(0);

    // the Add modal: name, number, then success
    await page.getByRole('button', { name: 'Add Reference Check' }).click();
    const dialog = dialogWith(page, 'Add reference check');
    const add = dialog.getByRole('button', { name: 'Add', exact: true });
    await add.click();
    await expect(toastWith(page, 'Reference Name is required')).toBeVisible();
    await dialog.getByPlaceholder('e.g. Priya Sharma').fill('E2E Referee');
    await add.click();
    await expect(toastWith(page, 'Reference Number is required')).toBeVisible();
    await dialog.getByPlaceholder('e.g. +91 98765 43210').fill('+91 90000 11111');
    await dialog.locator('select').nth(0).selectOption('Teammate');
    await dialog.locator('select').nth(1).selectOption('Good');
    await dialog.getByPlaceholder('Notes from the reference call…').fill('E2E: reliable and quick');
    await add.click();

    await expect(toastWith(page, 'Reference check added')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const row = applicationsCard(page).locator('div.rounded-lg.bg-gray-50').filter({ hasText: 'E2E Referee' });
    await expect(row).toContainText('Teammate');
    await expect(row).toContainText('Good');
    await expect(row).toContainText('E2E: reliable and quick');
    expect(refPosts.bodies()).toEqual([{
      application_id: a.appId, reference_name: 'E2E Referee', reference_number: '+91 90000 11111',
      relationship: 'Teammate', reference_call_notes: 'E2E: reliable and quick', feedback: 'Good',
    }]);
    const stored = await getRefChecks(request, a.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ reference_name: 'E2E Referee', relationship: 'Teammate', feedback: 'Good' });

    // now the move goes through
    await stageButton(page).click();
    await stageDialog.getByRole('combobox').selectOption('Pre-Joining Documents');
    await stageDialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Stage updated to Pre-Joining Documents')).toBeVisible();
    expect(stagePosts.bodies()).toEqual([{ new_stage: 'Pre-Joining Documents' }, { new_stage: 'Pre-Joining Documents' }]);
    expect((await getApp(request, a.appId)).stage).toBe('Pre-Joining Documents');
  });

  test('the Add Reference Check control exists only at the Reference Check stage', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    await open(page, 'hr', a);
    await expect(page.getByRole('button', { name: 'Add Reference Check' })).toHaveCount(0);
    expect(await getRefChecks(request, a.appId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Status modal: reject, withdraw, hold', () => {

  test('reject with several reasons: nothing is sent until one is ticked; then every reason is sent and stored, and the Rejected tag lists them', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/status`));
    await open(page, 'hr', a);

    await statusButton(page).click();
    const dialog = dialogWith(page, 'Update status');
    await expect(dialog.getByRole('combobox')).toHaveValue('Active');     // opens on the current status
    await dialog.getByRole('combobox').selectOption('Rejected');
    const reasons = dialog.getByRole('group', { name: /Reasons/ });
    await expect(reasons).toContainText('(select one or more)');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Select at least one reason')).toBeVisible();

    await dialog.getByRole('checkbox', { name: 'Communication gap' }).check();
    await dialog.getByRole('checkbox', { name: 'Compensation mismatch' }).check();
    await expect(reasons).toContainText('(2 selected)');
    await dialog.getByPlaceholder('Additional detail (optional)').fill('E2E: two gaps');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, 'Status updated to Rejected')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // one POST in total: the empty attempt never left the browser. The body carries the array AND the joined string (old backends).
    expect(posts.bodies()).toEqual([{
      new_status: 'Rejected',
      rejection_reason_cats: ['Communication gap', 'Compensation mismatch'],
      rejection_reason_cat: 'Communication gap; Compensation mismatch',
      rejection_reason_detail: 'E2E: two gaps',
    }]);
    const app = await getApp(request, a.appId);
    expect(app).toMatchObject({ status: 'Rejected', rejection_reason_cat: 'Communication gap; Compensation mismatch', rejection_reason_detail: 'E2E: two gaps' });

    // the Rejected tag opens the reasons as a list
    await page.getByTitle('Click to see the rejection reason').click();
    const popup = dialogWith(page, 'Rejection reason');
    await expect(popup.getByRole('listitem')).toHaveText(['Communication gap', 'Compensation mismatch']);
    await expect(popup).toContainText('E2E: two gaps');
    await popup.getByRole('button', { name: 'Close' }).click();
    await expect(popup).toHaveCount(0);
  });

  test('rejecting with a single reason is stored as that one reason, and the rejection e-mail stays off unless ticked', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/status`));
    await open(page, 'hr', a);
    await statusButton(page).click();
    const dialog = dialogWith(page, 'Update status');
    await dialog.getByRole('combobox').selectOption('Rejected');
    await dialog.getByRole('checkbox', { name: 'Short average tenure' }).check();
    // the draft appears once a reason is chosen, and is OFF by default; nothing in it is sent while it is off
    await expect(dialog.getByRole('checkbox', { name: /Send rejection email/ })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Status updated to Rejected')).toBeVisible();
    expect(posts.bodies()).toEqual([{ new_status: 'Rejected', rejection_reason_cats: ['Short average tenure'], rejection_reason_cat: 'Short average tenure' }]);
    expect((await getApp(request, a.appId)).rejection_reason_cat).toBe('Short average tenure');
    await page.getByTitle('Click to see the rejection reason').click();
    await expect(dialogWith(page, 'Rejection reason')).toContainText('Short average tenure');
    await expect(dialogWith(page, 'Rejection reason').getByRole('listitem')).toHaveCount(0);   // one reason is plain text, not a list
  });

  test('TODAY withdraw needs exactly one reason (a dropdown, no e-mail draft) and the reason is stored in the rejection column', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/status`));
    await open(page, 'hr', a);
    await statusButton(page).click();
    const dialog = dialogWith(page, 'Update status');
    await dialog.getByRole('combobox').first().selectOption('Withdrawn');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);            // a single choice, not the multi-reason list
    const reason = dialog.getByRole('combobox').nth(1);
    await expect(reason.locator('option')).toHaveCount(8);               // the placeholder + 7 withdrawal reasons

    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Select at least one reason')).toBeVisible();
    await reason.selectOption('Process too slow');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(toastWith(page, 'Status updated to Withdrawn')).toBeVisible();
    expect(posts.bodies()).toEqual([{ new_status: 'Withdrawn', rejection_reason_cats: ['Process too slow'], rejection_reason_cat: 'Process too slow' }]);
    const app = await getApp(request, a.appId);
    expect(app.status).toBe('Withdrawn');
    // TODAY: the UI sends a withdrawal's reason in the REJECTION fields, so withdrawal_reason_cat (which the API supports) stays empty.
    expect(app.rejection_reason_cat).toBe('Process too slow');
    expect(app.withdrawal_reason_cat).toBeNull();
  });

  test('Hold for Future sends no reasons even after Rejected was ticked, and Active brings the application back', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/status`));
    await open(page, 'hr', a);

    await statusButton(page).click();
    const dialog = dialogWith(page, 'Update status');
    await dialog.getByRole('combobox').selectOption('Rejected');
    await dialog.getByRole('checkbox', { name: 'Missing mandatory skill' }).check();
    await dialog.getByRole('combobox').selectOption('Hold for Future');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);            // the reasons UI is gone
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Status updated to Hold for Future')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const held = await getApp(request, a.appId);
    expect(held.status).toBe('Hold for Future');
    expect(held.rejection_reason_cat).toBeNull();                         // the leftover tick did not ride along

    await statusButton(page).click();
    await expect(dialogWith(page, 'Update status').getByRole('combobox')).toHaveValue('Hold for Future');
    await dialogWith(page, 'Update status').getByRole('combobox').selectOption('Active');
    await dialogWith(page, 'Update status').getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toastWith(page, 'Status updated to Active')).toBeVisible();
    expect(posts.bodies()).toEqual([{ new_status: 'Hold for Future' }, { new_status: 'Active' }]);
    expect((await getApp(request, a.appId)).status).toBe('Active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Founder flag and screening notes', () => {

  test('flag for Founder Review with a note, then clear it: requests, button state, record and the Leadership task', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost(`/api/applications/${a.appId}/founder-flag`));
    const openFounderTasks = () => withDb(async c => (await c.query(
      `SELECT count(*)::int AS n FROM pending_actions WHERE application_id = $1 AND action_type = 'Founder Review' AND resolved = false`, [a.appId])).rows[0].n);
    await open(page, 'hr', a);

    await page.getByTitle('Flag for Founder Review').click();
    const dialog = dialogWith(page, 'Flag for Founder Review');
    await dialog.getByPlaceholder('Note (optional)').fill('E2E: strong profile');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(toastWith(page, 'Flagged for Founder Review')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTitle(/^Flagged for Founder Review.*Click to clear the flag\./)).toBeVisible();   // the star now clears
    const flagged = await getApp(request, a.appId);
    expect(flagged).toMatchObject({ founder_review_flag: true, founder_review_note: 'E2E: strong profile' });
    expect(await openFounderTasks()).toBe(1);                                   // Leadership has something to review

    await page.getByTitle(/^Flagged for Founder Review.*Click to clear the flag\./).click();
    const clearDialog = dialogWith(page, 'Clear Founder Review flag');
    await clearDialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(toastWith(page, 'Founder Review flag cleared')).toBeVisible();
    await expect(page.getByTitle('Flag for Founder Review')).toBeVisible();
    expect(posts.bodies()).toEqual([{ set: true, note: 'E2E: strong profile' }, { set: false }]);
    expect((await getApp(request, a.appId)).founder_review_flag).toBe(false);
    expect(await openFounderTasks()).toBe(0);                                   // and it was taken away again
  });

  test('Cancel on the Founder modal changes nothing', async ({ page, request }) => {
    const a = await arrange(request);
    const posts = recordRequests(page, isPost('/founder-flag'));
    await open(page, 'hr', a);
    await page.getByTitle('Flag for Founder Review').click();
    const dialog = dialogWith(page, 'Flag for Founder Review');
    await dialog.getByPlaceholder('Note (optional)').fill('E2E: never sent');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTitle('Flag for Founder Review')).toBeVisible();
    expect(posts.requests).toHaveLength(0);
    expect((await getApp(request, a.appId)).founder_review_flag).toBeFalsy();
  });

  test('HR adds screening notes: only the changed fields are sent, the section shows by default afterwards, and a Hiring Manager reads the summary', async ({ page, request }) => {
    const a = await arrange(request);
    const patches = recordRequests(page, isPatch(`/api/applications/${a.appId}/notes`));
    await open(page, 'hr', a);

    await expect(page.getByRole('heading', { name: 'Screening & Risk Notes' })).toHaveCount(0);   // hidden until asked for
    await page.getByRole('button', { name: '+ Add HR Screening Notes' }).click();
    const section = sectionCard(page, 'Screening & Risk Notes');
    await section.getByRole('button', { name: 'Edit Screening & Risk Notes' }).click();
    await section.locator('label:text-is("Recruiter Summary") + textarea').fill('E2E: solid communicator');
    await section.locator('label:text-is("Key Concerns") + textarea').fill('E2E: notice period');
    await section.locator('label:text-is("Priority Override") + select').selectOption('High');
    await section.locator('label:text-is("Override Reason") + input').fill('E2E: urgent role');
    await section.getByRole('button', { name: 'Save' }).click();

    await expect(toastWith(page, 'Screening & Risk Notes updated')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Edit Screening & Risk Notes' })).toBeVisible();
    await expect(section).toContainText('E2E: solid communicator');
    expect(patches.bodies()).toEqual([{
      hr_recruiter_summary: 'E2E: solid communicator', hr_key_concerns: 'E2E: notice period',
      hr_priority_override: 'High', hr_priority_override_reason: 'E2E: urgent role',
    }]);
    const app = await getApp(request, a.appId);
    expect(app).toMatchObject({ hr_recruiter_summary: 'E2E: solid communicator', hr_key_concerns: 'E2E: notice period', hr_priority_override: 'High' });

    // with a note on file the section is open from the start; the override left a line in the timeline
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Screening & Risk Notes', level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add HR Screening Notes' })).toHaveCount(0);
    await expect(page.getByText('HR Priority → High: E2E: urgent role')).toBeVisible();

    // a Hiring Manager gets the summary as a quote, never the editable section or the internal notes
    await open(page, 'hm_alex', a);
    await expect(page.getByText('"E2E: solid communicator"')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Screening & Risk Notes' })).toHaveCount(0);
    await expect(page.getByText('E2E: notice period')).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Interview rounds: feedback', () => {

  async function fillFeedback(page: Page, dialog: ReturnType<typeof dialogWith>, scores: Record<string, number>, recommendation: string) {
    for (const [area, n] of Object.entries(scores)) {
      await dialog.locator('div.bg-gray-50', { hasText: area }).getByRole('button', { name: String(n), exact: true }).click();
    }
    await dialog.locator('select').nth(0).selectOption('Positive');
    await dialog.locator('select').nth(1).selectOption('High');
    await dialog.locator('select').nth(2).selectOption(recommendation);
  }

  test('HR submits feedback: submit waits for every field, the body and the row agree, and a Hold does not move the stage', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Tech ${a.role.id}`, focus_areas: ['Technical Knowledge', 'Problem Solving'] });
    const patches = recordRequests(page, isPatch(`/api/interviews/${round.id}/feedback`));
    await open(page, 'hr', a);

    const row = roundRow(page, round.round_name);
    await expect(row).toContainText('Pending');
    await row.getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);
    await expect(dialog).toContainText(round.round_name);
    await expect(dialog).toContainText(a.name);
    const submit = dialog.getByRole('button', { name: 'Submit feedback' });
    await expect(submit).toBeDisabled();

    await dialog.locator('div.bg-gray-50', { hasText: 'Technical Knowledge' }).getByRole('button', { name: '4', exact: true }).click();
    await expect(submit).toBeDisabled();                                   // one area is still unscored
    await dialog.locator('div.bg-gray-50', { hasText: 'Problem Solving' }).getByRole('button', { name: '5', exact: true }).click();
    await expect(dialog.getByText(/Computed overall score/)).toContainText('4.5 / 5.0');
    await expect(submit).toBeDisabled();                                   // the three selects are still empty
    await dialog.locator('select').nth(0).selectOption('Positive');
    await dialog.locator('select').nth(1).selectOption('High');
    await dialog.locator('select').nth(2).selectOption('Hold');
    await dialog.getByPlaceholder('Strong areas, standout moments…').fill('E2E: strong systems thinking');
    await dialog.getByPlaceholder('Concerns, risks, gaps observed…').fill('E2E: thin on SQL');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(toastWith(page, 'Feedback submitted')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(patches.bodies()).toEqual([{
      eval_areas_assessed: ['Technical Knowledge', 'Problem Solving'],
      scores_per_area: { 'Technical Knowledge': 4, 'Problem Solving': 5 },
      overall_assessment: 'Positive', confidence_level: 'High', round_recommendation: 'Hold',
      strengths_observed: 'E2E: strong systems thinking', key_concerns: 'E2E: thin on SQL',
      unresolved_questions: null, notes: null,
    }]);
    await expect(row).toContainText('Submitted');
    await expect(row).toContainText('Positive · Hold');
    await expect(row).toContainText('Score: 4.5/5');
    await expect(row.getByRole('button', { name: 'Submit feedback' })).toHaveCount(0);   // nothing left to submit
    await row.getByTitle('Show full feedback').click();
    await expect(row).toContainText('Technical Knowledge: 4/5');
    await expect(row).toContainText('E2E: strong systems thinking');
    await expect(row).toContainText('E2E: thin on SQL');

    const [stored] = await getRounds(request, a.appId);
    expect(stored).toMatchObject({ feedback_status: 'Submitted', overall_assessment: 'Positive', round_recommendation: 'Hold', confidence_level: 'High' });
    expect(Number(stored.overall_round_score)).toBe(4.5);
    expect((await getApp(request, a.appId)).stage).toBe('Interview Round 1');   // a Hold is not positive enough to advance
  });

  test('positive feedback (Proceed, average above 2.5) advances the candidate and says so', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Adv ${a.role.id}`, focus_areas: ['Technical Knowledge'] });
    await open(page, 'hr', a);
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);
    await fillFeedback(page, dialog, { 'Technical Knowledge': 4 }, 'Proceed');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();

    await expect(toastWith(page, 'Feedback submitted')).toBeVisible();
    await expect(toastWith(page, 'Positive feedback — candidate auto-advanced to Interview Round 2')).toBeVisible();
    await expect.poll(async () => (await getApp(request, a.appId)).stage).toBe('Interview Round 2');
    await page.reload();
    await expectCandidatePage(page, a.name);
    await expect(stageBadge(page, 'Interview Round 2')).toBeVisible();
  });

  test('TODAY after an auto-advance the candidate page keeps showing the old stage until it is reloaded', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Stale ${a.role.id}`, focus_areas: ['Technical Knowledge'] });
    await open(page, 'hr', a);
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);
    await fillFeedback(page, dialog, { 'Technical Knowledge': 5 }, 'Proceed');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(toastWith(page, 'Positive feedback — candidate auto-advanced to Interview Round 2')).toBeVisible();
    await expect.poll(async () => (await getApp(request, a.appId)).stage).toBe('Interview Round 2');

    // The feedback modal only refreshes the rounds, not the candidate: the badge (and the strip above it) still say Interview Round 1.
    await expect(roundRow(page, round.round_name)).toContainText('Submitted');
    await expect(stageBadge(page, 'Interview Round 1')).toBeVisible();
    await expect(stageBadge(page, 'Interview Round 2')).toHaveCount(0);
    await page.reload();
    await expectCandidatePage(page, a.name);
    await expect(stageBadge(page, 'Interview Round 2')).toBeVisible();
  });

  test('a low score with Proceed does not advance: the 2.5 midpoint rule', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Low ${a.role.id}`, focus_areas: ['Technical Knowledge'] });
    await open(page, 'hr', a);
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);
    await fillFeedback(page, dialog, { 'Technical Knowledge': 2 }, 'Proceed');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(toastWith(page, 'Feedback submitted')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(toastWith(page, /auto-advanced/)).toHaveCount(0);
    expect((await getApp(request, a.appId)).stage).toBe('Interview Round 1');
  });

  test('areas can be removed and a custom one added: only the selected areas are scored and sent', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `Areas ${a.role.id}`, focus_areas: ['Technical Knowledge', 'Problem Solving'] });
    const patches = recordRequests(page, isPatch(`/api/interviews/${round.id}/feedback`));
    await open(page, 'hr', a);
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);

    await dialog.locator('div.bg-gray-50', { hasText: 'Problem Solving' }).getByTitle('Remove area').click();
    await expect(dialog.getByRole('button', { name: '+ Problem Solving' })).toBeVisible();   // it can be brought back
    await dialog.getByPlaceholder('Add custom area…').fill('E2E Custom Area');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.locator('div.bg-gray-50', { hasText: 'Technical Knowledge' }).getByRole('button', { name: '3', exact: true }).click();
    await dialog.locator('div.bg-gray-50', { hasText: 'E2E Custom Area' }).getByRole('button', { name: '5', exact: true }).click();
    await dialog.locator('select').nth(0).selectOption('Neutral');
    await dialog.locator('select').nth(1).selectOption('Medium');
    await dialog.locator('select').nth(2).selectOption('Hold');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(toastWith(page, 'Feedback submitted')).toBeVisible();
    expect(patches.bodies()[0]).toMatchObject({
      eval_areas_assessed: ['Technical Knowledge', 'E2E Custom Area'],
      scores_per_area: { 'Technical Knowledge': 3, 'E2E Custom Area': 5 },
    });
    const [stored] = await getRounds(request, a.appId);
    expect(Number(stored.overall_round_score)).toBe(4);
  });

  test('a Hiring Manager listed on the round submits feedback', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `HM listed ${a.role.id}`, interviewer_emails: [USERS.hm_alex.email], focus_areas: ['Technical Knowledge'] });
    await open(page, 'hm_alex', a);
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();
    const dialog = dialogWith(page, /Interview Feedback/);
    await fillFeedback(page, dialog, { 'Technical Knowledge': 3 }, 'Hold');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(toastWith(page, 'Feedback submitted')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(roundRow(page, round.round_name)).toContainText('Submitted');
    expect((await getRounds(request, a.appId))[0].feedback_status).toBe('Submitted');
  });

  test('TODAY a Hiring Manager not listed on the round still sees Submit feedback; the server refuses and the modal says why', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const round = await createStandardRound(request, a.appId, { round_name: `HM other ${a.role.id}`, interviewer_emails: [USERS.hm_alex.email], focus_areas: ['Technical Knowledge'] });
    await open(page, 'hm_satyadev', a);                                    // Satyadev is not on this round
    await roundRow(page, round.round_name).getByRole('button', { name: 'Submit feedback' }).click();   // TODAY: the button is not hidden
    const dialog = dialogWith(page, /Interview Feedback/);
    await fillFeedback(page, dialog, { 'Technical Knowledge': 3 }, 'Hold');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();

    await expect(toastWith(page, 'You are not an assigned interviewer for this round.')).toBeVisible();
    await expect(dialog).toBeVisible();                                    // the modal stays open on a refusal
    expect((await getRounds(request, a.appId))[0].feedback_status).toBe('Pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Assignment round', () => {

  test('Send Assignment: every required field is checked in the browser, the real request is exact, and a failed e-mail leaves a retry', async ({ page, request }) => {
    const roleLink = 'https://example.invalid/role-assignment';
    const a = await arrange(request, { stage: 'Assignment Round', candidate: { email: `e2ec+${Date.now().toString(36)}@e2e-no-mailbox.invalid` } });
    expect((await (await hrApi(request)).patch(`/api/roles/${a.role.id}`, { approval_summary_link: roleLink })).status()).toBe(200);
    const creates = recordRequests(page, isPost('/api/interviews'));
    await open(page, 'hr', a);

    await page.getByRole('button', { name: 'Send Assignment', exact: true }).click();
    const dialog = dialogWith(page, 'Send Assignment');
    await expect(dialog).toContainText(a.email);                                         // To:
    await expect(dialog).toContainText(`DigitalPaani ${a.role.title} Assignment - ${a.name}`);   // Subject:
    const link = dialog.getByPlaceholder(/Autofilled from the role/);
    await expect(link).toHaveValue(roleLink);                                            // filled from the role's Assignment Link
    const body = dialog.getByPlaceholder(/thanks for your time so far/);
    const cc = dialog.getByPlaceholder('e.g. alex@digitalpaani.com, satyadev@digitalpaani.com');
    const send = dialog.getByRole('button', { name: 'Send Assignment', exact: true });

    await send.click();
    await expect(toastWith(page, 'Mail Body Content is required')).toBeVisible();
    await body.fill('E2E: please complete the attached exercise.');
    await link.fill('');
    await send.click();
    await expect(toastWith(page, 'Assignment Link is required')).toBeVisible();
    await link.fill(roleLink);
    await cc.fill('not-an-email');
    await send.click();
    await expect(toastWith(page, '"not-an-email" doesn\'t look like a valid email address')).toBeVisible();

    await cc.fill('e2e-cc-one@example.invalid, e2e-cc-two@example.invalid');
    await dialog.getByPlaceholder('Google Drive links, comma-separated').fill('https://example.invalid/doc-1');
    await send.click();

    // the e-mail cannot go out on this stack: the round is saved and the failure is shown, not hidden
    await expect(toastWith(page, 'Assignment round saved, but the email failed to send')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(creates.bodies()).toEqual([{                                                  // the three refused attempts never reached the API
      application_id: a.appId, round_type: 'Assignment', round_name: 'Assignment Round', round_number: 1,
      mail_body_content: 'E2E: please complete the attached exercise.', cc: ['e2e-cc-one@example.invalid', 'e2e-cc-two@example.invalid'],
      assignment_link: roleLink, supporting_documentation: 'https://example.invalid/doc-1',
    }]);
    const [round] = await getRounds(request, a.appId);
    expect(round).toMatchObject({
      round_type: 'Assignment', assignment_link: roleLink, assignment_mail_body: 'E2E: please complete the attached exercise.',
      assignment_cc: ['e2e-cc-one@example.invalid', 'e2e-cc-two@example.invalid'], assignment_supporting_docs: 'https://example.invalid/doc-1',
    });
    expect(round.assignment_send_date).toBeNull();
    expect(round.assignment_email_error).toBeTruthy();

    const row = roundRow(page, 'Assignment Round');
    await expect(row).toContainText('Assignment email failed to send');
    await expect(row.getByRole('button', { name: 'Send Assignment', exact: true })).toHaveCount(0);   // the stage-level button is not a row action

    // retry: the same form, filled from what was last tried; it re-sends to the round's own endpoint
    const retries = recordRequests(page, isPost(`/api/interviews/${round.id}/assignment-send`));
    await row.getByRole('button', { name: 'Send assignment', exact: true }).click();
    const retry = dialogWith(page, 'Retry assignment send');
    await expect(retry.getByPlaceholder(/thanks for your time so far/)).toHaveValue('E2E: please complete the attached exercise.');
    await expect(retry.getByPlaceholder(/Autofilled from the role/)).toHaveValue(roleLink);
    await expect(retry.getByPlaceholder('e.g. alex@digitalpaani.com, satyadev@digitalpaani.com')).toHaveValue('e2e-cc-one@example.invalid, e2e-cc-two@example.invalid');
    await retry.getByRole('button', { name: 'Send Assignment', exact: true }).click();
    await expect(toastWith(page, 'Assignment round saved, but the email failed to send').last()).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(retries.bodies()).toEqual([{
      mail_body_content: 'E2E: please complete the attached exercise.', cc: ['e2e-cc-one@example.invalid', 'e2e-cc-two@example.invalid'],
      assignment_link: roleLink, supporting_documentation: 'https://example.invalid/doc-1',
    }]);
    expect(await getRounds(request, a.appId)).toHaveLength(1);                            // a retry never makes a second round
  });

  test('a sent assignment: Record submission validates the link, then Record outcome scores the five rubric items', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Assignment Round', candidate: { email: `e2ec+${Date.now().toString(36)}@e2e-no-mailbox.invalid` } });
    const round = await createAssignmentRound(request, a.appId);
    await markAssignmentSent(round.id);                                                  // what a real send writes; this stack cannot send
    const submits = recordRequests(page, isPost(`/api/interviews/${round.id}/assignment-submit`));
    const outcomes = recordRequests(page, isPatch(`/api/interviews/${round.id}/feedback`));
    await open(page, 'hr', a);

    const row = roundRow(page, 'Assignment Round');
    await expect(row).toContainText(/Due /);                                              // the deadline pill
    await row.getByRole('button', { name: 'Record submission' }).click();
    const submitDialog = dialogWith(page, 'Record submission');
    await submitDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toastWith(page, 'Submission link is required')).toBeVisible();
    await submitDialog.getByPlaceholder('Drive/repo link to the submission').fill('https://example.invalid/e2e-submission');
    await submitDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toastWith(page, 'Submission recorded')).toBeVisible();
    await expect(submitDialog).toHaveCount(0);
    expect(submits.bodies()).toEqual([{ submission_link: 'https://example.invalid/e2e-submission' }]);
    await expect(row.getByRole('link', { name: 'Submission link' })).toHaveAttribute('href', 'https://example.invalid/e2e-submission');
    await expect(row.getByRole('button', { name: 'Record submission' })).toHaveCount(0);   // replaced by the outcome step

    await row.getByRole('button', { name: 'Record outcome' }).click();
    const dialog = dialogWith(page, /Assignment Outcome/);
    const save = dialog.getByRole('button', { name: 'Save outcome' });
    await expect(save).toBeDisabled();
    const rubric = { 'Technical Accuracy': 5, 'Problem Solving': 4, 'Clarity & Structure': 4, 'Practical Thinking': 3, 'Completeness': 3 };
    for (const [item, n] of Object.entries(rubric)) {
      await dialog.locator('div.bg-gray-50', { hasText: item }).getByRole('button', { name: String(n), exact: true }).click();
    }
    await expect(save).toBeDisabled();                                                   // no outcome chosen yet
    await expect(dialog.getByText(/Weighted overall score/)).toContainText('4.2 / 5.0');   // 40/25/15/10/10 weights
    await dialog.locator('select').selectOption('Assignment Resent');
    await dialog.getByPlaceholder('Anything worth flagging about the submission…').fill('E2E: resubmit with tests');
    await expect(save).toBeEnabled();
    await save.click();

    await expect(toastWith(page, 'Assignment outcome recorded')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(outcomes.bodies()).toEqual([{
      assignment_outcome: 'Assignment Resent',
      score_technical_accuracy: 5, score_problem_solving: 4, score_clarity: 4, score_practical_thinking: 3, score_completeness: 3,
      assignment_notes: 'E2E: resubmit with tests',
    }]);
    await expect(row).toContainText('Assignment Resent · 4.2/5');
    const [stored] = await getRounds(request, a.appId);
    expect(stored).toMatchObject({ assignment_outcome: 'Assignment Resent', feedback_status: 'Submitted' });
    expect(Number(stored.assignment_overall_score)).toBeCloseTo(4.2, 5);
    expect((await getApp(request, a.appId)).stage).toBe('Assignment Round');             // resent is not an advance
  });

  test('an approved assignment outcome above 2.5 advances the candidate and says so', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Assignment Round', candidate: { email: `e2ec+${Date.now().toString(36)}@e2e-no-mailbox.invalid` } });
    const round = await createAssignmentRound(request, a.appId);
    await markAssignmentSent(round.id);
    await (await hrApi(request)).post(`/api/interviews/${round.id}/assignment-submit`, { submission_link: 'https://example.invalid/e2e-submission-2' });
    await open(page, 'hr', a);

    await roundRow(page, 'Assignment Round').getByRole('button', { name: 'Record outcome' }).click();
    const dialog = dialogWith(page, /Assignment Outcome/);
    for (const item of ['Technical Accuracy', 'Problem Solving', 'Clarity & Structure', 'Practical Thinking', 'Completeness']) {
      await dialog.locator('div.bg-gray-50', { hasText: item }).getByRole('button', { name: '4', exact: true }).click();
    }
    await dialog.locator('select').selectOption('Approved for Next Round');
    await dialog.getByRole('button', { name: 'Save outcome' }).click();
    await expect(toastWith(page, 'Assignment outcome recorded')).toBeVisible();
    await expect(toastWith(page, 'Positive outcome — candidate auto-advanced to Founders Round')).toBeVisible();
    await expect.poll(async () => (await getApp(request, a.appId)).stage).toBe('Founders Round');
    await page.reload();
    await expectCandidatePage(page, a.name);
    await expect(stageBadge(page, 'Founders Round')).toBeVisible();   // (until this reload the page still showed Assignment Round: see the TODAY test above)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Persona differences on the candidate page', () => {

  test('a Hiring Manager of the role sees the pipeline and the rounds but none of the HR controls', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    await createStandardRound(request, a.appId, { round_name: `Seen ${a.role.id}` });
    await (await hrApi(request)).post(`/api/applications/${a.appId}/founder-flag`, { set: true, note: 'E2E' });
    await open(page, 'hm_alex', a);

    await expect(applicationsCard(page).getByText(a.role.title)).toBeVisible();          // the application is there to read
    await expect(roundRow(page, `Seen ${a.role.id}`)).toBeVisible();
    await expect(stageButton(page)).toHaveCount(0);
    await expect(statusButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add Application' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Schedule round' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ Add HR Screening Notes' })).toHaveCount(0);
    await expect(page.getByTitle(/Click to clear the flag\./)).toHaveCount(0);           // the flag is shown, but not as a control
    await expect(page.getByTitle('Flag for Founder Review')).toHaveCount(0);
    await expect(applicationsCard(page).getByText('Founder', { exact: true })).toBeVisible();
  });

  test('a Hiring Manager gets no Send Assignment and no Add Reference Check at the stages that offer them to HR', async ({ page, request }) => {
    const assignment = await arrange(request, { stage: 'Assignment Round' });
    await open(page, 'hr', assignment);
    await expect(page.getByRole('button', { name: 'Send Assignment', exact: true })).toBeVisible();   // the HR baseline: it is there
    await open(page, 'hm_alex', assignment);
    await expect(page.getByRole('button', { name: 'Send Assignment', exact: true })).toHaveCount(0);

    const reference = await arrange(request, { stage: 'Reference Check' });
    await open(page, 'hr', reference);
    await expect(page.getByRole('button', { name: 'Add Reference Check' })).toBeVisible();
    await open(page, 'hm_alex', reference);
    await expect(page.getByRole('button', { name: 'Add Reference Check' })).toHaveCount(0);
  });

  test('compensation is shown to the Hiring Manager named on the role and hidden from another Hiring Manager', async ({ page, request }) => {
    const a = await arrange(request, { candidate: { expected_ctc: 15, current_ctc_fixed: 12 } });   // the role's Hiring Manager is "Alex"
    await open(page, 'hm_alex', a);
    const comp = sectionCard(page, 'Compensation');
    await expect(comp).toContainText('Expected CTC');
    await expect(comp).toContainText('15');
    await expect(applicationsCard(page)).toContainText('₹12L → ₹15L');

    await open(page, 'hm_satyadev', a);
    const hidden = sectionCard(page, 'Compensation');
    await expect(hidden).toContainText('Notice Period');                                  // the section is there, the money is not
    await expect(hidden).not.toContainText('Expected CTC');
    await expect(hidden).not.toContainText('Current CTC');
    await expect(applicationsCard(page)).not.toContainText('₹');
  });

  test('TODAY a Hiring Manager still sees the edit pencils; saving is refused by the server and nothing changes', async ({ page, request }) => {
    const a = await arrange(request, { candidate: { phone: '+91 91111 11111' } });
    await open(page, 'hm_alex', a);
    const identity = sectionCard(page, 'Identity');
    await identity.getByRole('button', { name: 'Edit Identity' }).click();               // TODAY: not hidden for a Hiring Manager
    await identity.locator('label:text-is("Phone") + input').fill('+91 92222 22222');
    await identity.getByRole('button', { name: 'Save' }).click();
    await expect(toastWith(page, 'Failed to update Identity')).toBeVisible();
    const res = await authed(request, await getToken(request, 'hr')).get(`/api/candidates/${a.candidate.id}`);
    expect((await res.json()).candidate.phone).toBe('+91 91111 11111');
  });

  test('the server refuses what the Hiring Manager page hides: founder flag, notes and a status change after Applied and Screened are 403, and an HR reject without a reason is 400', async ({ request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    const hm = authed(request, await getToken(request, 'hm_alex'));
    const hr = await hrApi(request);

    const flag = await hm.post(`/api/applications/${a.appId}/founder-flag`, { set: true, note: 'E2E' });
    expect(flag.status(), await flag.text()).toBe(403);
    const notes = await hm.patch(`/api/applications/${a.appId}/notes`, { hr_recruiter_summary: 'E2E not allowed' });
    expect(notes.status(), await notes.text()).toBe(403);
    const reject = await hm.post(`/api/applications/${a.appId}/status`, { new_status: 'Rejected', rejection_reason_cat: 'Skills mismatch' });
    expect(reject.status(), await reject.text()).toBe(403);

    // The same three calls change nothing for HR's view of the record.
    const record = await getApp(request, a.appId);
    expect(record.status).toBe('Active');
    expect(record.founder_flag).toBeFalsy();
    expect(record.hr_recruiter_summary ?? null).toBeNull();

    // HR itself cannot reject or withdraw without a reason, whatever the page does.
    for (const new_status of ['Rejected', 'Withdrawn']) {
      const res = await hr.post(`/api/applications/${a.appId}/status`, { new_status });
      expect(res.status(), `${new_status}: ${await res.text()}`).toBe(400);
    }
    expect((await getApp(request, a.appId)).status).toBe('Active');
  });

  test('Leadership has every HR control on the candidate page', async ({ page, request }) => {
    const a = await arrange(request, { stage: 'Interview Round 1' });
    await open(page, 'leadership', a);
    await expect(stageButton(page)).toBeVisible();
    await expect(statusButton(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Application' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule round' })).toBeVisible();
    await expect(page.getByTitle('Flag for Founder Review')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add HR Screening Notes' })).toBeVisible();
  });
});
