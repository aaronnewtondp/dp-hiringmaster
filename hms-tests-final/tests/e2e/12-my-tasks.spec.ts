/**
 * E2E — My Tasks (/my-tasks): the HR queue, "Ready for Review" (the embedded Scorecard Summary table) and its filters, the Portfolio >= 7.5
 * toggle, Retry scoring, the Leadership user who is also a role's Hiring Manager, a role with two Hiring Managers, and a Hiring Manager's own page.
 * tests/e2e/08 covers only the Sourcing box and the alerts-only Leadership box; the db specs (10, 11, 12) cover the same rules through the API.
 *
 * Data: written by SQL (helpers/e2e-roles.ts `Fixtures`) — a score, a stage-entry time, a portfolio flag and a Founder flag have no API — and
 * removed again in afterAll. Every fixture group has its OWN run id, which is part of every candidate name and role title, so a test narrows
 * the table with the search box to exactly its group and nothing a neighbour or an earlier run left behind can change a count.
 * The SLA engine is triggered through the cron route (POST /api/cron/sla-check, dev secret), never waited for.
 * No Anthropic key and no Google: nothing here scores a resume. The one button that would (Retry scoring) is asserted against whatever
 * the backend reports, see its group.
 */
import { test, expect, Page } from '@playwright/test';
import { Client } from 'pg';
import { uid, getToken, authed, FRONTEND_BASE, USERS } from '../helpers/api';
import { newClient } from '../helpers/db';
import { expectNoPageErrors, gotoAs } from '../helpers/e2e';
import {
  Fixtures, CreatedApp, CreatedRole, FEEDBACK_DUE_TYPES, SHORTLIST_PENDING, candidateLinksInTable, expectBoxCount, openBox, openPendingRows,
  pinPendingRows, recordRequests, runSlaSweep, searchFor, setFilter, tableRowOf, taskBox,
} from '../helpers/e2e-roles';

const RUN = uid();
let db: Client;
const groups: Fixtures[] = [];

/** A fixture group: its own run id (the search marker for the table) and its own cleanup. */
function group(name: string): Fixtures {
  const fx = new Fixtures(db, `${RUN}-${name}`, `E2E ${name}`);
  groups.push(fx);
  return fx;
}

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  db = newClient();
  await db.connect();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  for (const fx of groups) await fx.cleanup();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const scorecardRow = (page: Page, app: CreatedApp) => tableRowOf(page, app.candidateName);
/** The second table row of an application, the one holding "View Highlights and Summary". */
const highlightsRowOf = (page: Page, app: CreatedApp) => scorecardRow(page, app).locator('xpath=following-sibling::tr[1]');

/** One entry of an "Other pending actions" list: the nearest block around the candidate's link that also names the action. */
const queueEntry = (page: Page, app: CreatedApp, actionType: string) =>
  page.getByRole('link', { name: app.candidateName, exact: true })
    .locator(`xpath=ancestor::div[.//p[normalize-space()="${actionType}"]][1]`);

type PendingBody = { actions: { action_type: string; owner_type: string; application_id: string | null }[]; alerts: { action_type: string; description: string }[]; hm_roles: { id: string; title: string }[] };
async function pendingFor(page: Page, who: keyof typeof USERS): Promise<PendingBody> {
  const res = await authed(page.request, await getToken(page.request, who)).get('/api/dashboard/pending');
  expect(res.status()).toBe(200);
  return res.json();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('HR/Admin: the pending-action queue', () => {
  let fxQ: Fixtures;
  let role: CreatedRole, agingRole: CreatedRole;
  let stale: CreatedApp, fresh: CreatedApp, idle: CreatedApp;

  test.beforeAll(async ({ request }) => {
    fxQ = group('Queue');
    role = await fxQ.role('role', { hm: 'Alex', priority: 'P1' });
    // Red Alert on its Close Target: the sweep raises a company-wide 'Role aging alert' (Leadership-owned, nobody can resolve it here).
    agingRole = await fxQ.role('aging', { priority: 'P1', openedDaysAgo: 200, targetClosedDaysAgo: 100 });
    stale = await fxQ.app(await fxQ.candidate('stale'), role, { score: 7, hoursInStage: 60 });                        // 60 h at Applied and Screened (48 h allowed)
    fresh = await fxQ.app(await fxQ.candidate('fresh'), role, { score: 7, hoursInStage: 0 });
    idle  = await fxQ.app(await fxQ.candidate('idle'), role, { score: 7, stage: 'Interview Round 1', hoursInStage: 60 });   // no interview booked after 60 h

    await runSlaSweep(request);

    // The preconditions are asserted against the database, so a test below can never pass on a row the engine did not make.
    const staleRows = await openPendingRows(db, stale.id);
    const row = staleRows.find(r => r.action_type === SHORTLIST_PENDING);
    expect(row, 'the sweep raised no Resume Shortlist Pending row for the 60 h old application').toBeTruthy();
    expect(row!.owner_type).toBe('Hiring Manager');
    expect(row!.responsible_person).toBe('Alex');
    expect(await openPendingRows(db, fresh.id), 'a fresh application must have no open row').toEqual([]);
    expect((await openPendingRows(db, idle.id)).map(r => r.action_type)).toContain('Interview 1 Not Scheduled');
    const alert = await db.query(`SELECT 1 FROM pending_actions WHERE role_id = $1 AND action_type = 'Role aging alert' AND resolved = false`, [agingRole.id]);
    expect(alert.rowCount, 'the sweep raised no Role aging alert for the role 100 days past its Close Target').toBe(1);
  });

  test.beforeEach(async () => {
    await pinPendingRows(db, { appIds: [stale.id, fresh.id, idle.id], roleIds: [agingRole.id] });
  });

  test('a backdated application shows up under Other Pending Actions with its candidate and role, linked to the candidate; a fresh one has no entry', async ({ page }) => {
    const errors = expectNoPageErrors(page);
    await gotoAs(page, 'hr', '/my-tasks');
    await openBox(page, 'Other Pending Actions');
    await expect(page.getByRole('heading', { name: 'Other pending actions' })).toBeVisible();

    const link = page.getByRole('link', { name: stale.candidateName, exact: true });
    await expect(link).toHaveAttribute('href', `/candidates/${stale.candidateId}`);
    const entry = queueEntry(page, stale, SHORTLIST_PENDING);
    await expect(entry).toContainText(/Resume Shortlist Pending — \d+h overdue/);
    await expect(entry).toContainText(stale.roleTitle);
    // HR is not narrowed to one owner: the HR/Recruiter-owned row of the same run is there too
    await expect(queueEntry(page, idle, 'Interview 1 Not Scheduled')).toContainText(/Interview 1 Not Scheduled — \d+h overdue/);
    // the engine, not the list of every candidate: the application that is not overdue has no entry
    await expect(page.getByRole('link', { name: fresh.candidateName, exact: true })).toHaveCount(0);

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/candidates/${stale.candidateId}$`));
    await expect(page.getByRole('heading', { name: stale.candidateName, level: 1 })).toBeVisible();
    errors.check();
  });

  test('the box numbers are the server\'s: Feedback Due and Other Pending Actions split the queue by action type, role-aging alerts are listed apart and not counted', async ({ page }) => {
    await gotoAs(page, 'hr', '/my-tasks');
    const body = await pendingFor(page, 'hr');
    const feedback = body.actions.filter(a => FEEDBACK_DUE_TYPES.includes(a.action_type)).length;
    const other = body.actions.length - feedback;
    expect(body.actions.some(a => a.action_type === 'Role aging alert'), 'an alert must never be among the countable actions').toBe(false);
    expect(body.alerts.some(a => a.description.includes(agingRole.title)), 'the aging alert of the throwaway role is in the alerts list').toBe(true);

    await expectBoxCount(page, 'Other Pending Actions', other);
    await expectBoxCount(page, 'Feedback Due', feedback);
    // HR keeps the "Other Pending Actions" name (not "Leadership Alerts"); the alerts have a panel of their own, count in its heading
    await expect(taskBox(page, 'Leadership Alerts')).toHaveCount(0);
    await openBox(page, 'Other Pending Actions');
    await expect(page.getByRole('heading', { name: `Leadership Alerts (${body.alerts.length})` })).toBeVisible();
    await expect(page.getByText(new RegExp(`${agingRole.title} \\(P1\\) — \\d+ days overdue on Close Target`))).toBeVisible();
  });

  test('a resolved row leaves the queue: rejecting the candidate clears their entry', async ({ page }) => {
    const gone = await fxQ.app(await fxQ.candidate('rejected-later'), role, { score: 7, hoursInStage: 60 });
    await runSlaSweep(page.request);
    expect((await openPendingRows(db, gone.id)).map(r => r.action_type)).toContain(SHORTLIST_PENDING);
    await pinPendingRows(db, { appIds: [gone.id] });
    await gotoAs(page, 'hr', '/my-tasks');
    await openBox(page, 'Other Pending Actions');
    await expect(page.getByRole('link', { name: gone.candidateName, exact: true })).toBeVisible();

    const res = await authed(page.request, await getToken(page.request, 'hr')).post(`/api/applications/${gone.id}/status`, { new_status: 'Rejected', rejection_reason_cats: ['Communication gap'] });
    expect(res.status()).toBe(200);
    await page.reload();
    await openBox(page, 'Other Pending Actions');
    await expect(page.getByRole('heading', { name: 'Other pending actions' })).toBeVisible();
    await expect(page.getByRole('link', { name: gone.candidateName, exact: true })).toHaveCount(0);
    expect(await openPendingRows(db, gone.id)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Ready for Review (HR/Admin): the table, its scope and its filters', () => {
  let fxT: Fixtures, marker: string;
  let role: CreatedRole;
  let hi: CreatedApp, mid: CreatedApp, over: CreatedApp, none: CreatedApp, later: CreatedApp, rej: CreatedApp, unscoredLater: CreatedApp;

  test.beforeAll(async () => {
    fxT = group('Table');
    marker = fxT.run;
    role = await fxT.role('role', { hm: 'Alex', priority: 'P2', ctcBand: '10-20 LPA' });   // band max 20 -> 15% over = 23
    hi    = await fxT.app(await fxT.candidate('hi',  { gender: 'M', expectedCtc: 15, currentCtc: 12, noticeDays: 30, company: 'Acme Utilities', industry: 'Water' }), role,
      { score: 8.4, strengths: ['Owns the IoT pipeline end to end'], redFlags: ['Short tenure at last employer'], summary: 'Strong product instincts for field software.' });
    mid   = await fxT.app(await fxT.candidate('mid', { gender: 'F', expectedCtc: 22 }), role, { score: 5 });                        // over the band (20) but under the 15% line (23)
    over  = await fxT.app(await fxT.candidate('over', { gender: null, expectedCtc: 40 }), role, { score: 6 });                      // far over: hidden by In-budget only
    none  = await fxT.app(await fxT.candidate('none', { gender: null }), role, { score: null });                                    // automatic scoring never completed
    later = await fxT.app(await fxT.candidate('later', { gender: 'M' }), role, { score: 7, stage: 'Interview Round 1' });           // scored, past the shortlist decision
    rej   = await fxT.app(await fxT.candidate('rej', { gender: 'F' }), role, { score: 6, status: 'Rejected' });
    unscoredLater = await fxT.app(await fxT.candidate('unscored-later'), role, { score: null, stage: 'Interview Round 1' });         // not scored and past Applied and Screened: never listed
  });

  test('the list is the scored candidates of every stage plus every Applied-and-Screened one, Active by default; actions exist only where a decision is due', async ({ page }) => {
    const errors = expectNoPageErrors(page);
    await gotoAs(page, 'hr', '/my-tasks');
    await searchFor(page, marker);
    await expect(scorecardRow(page, hi)).toBeVisible();
    for (const shown of [hi, mid, over, none, later]) await expect(scorecardRow(page, shown)).toBeVisible();
    for (const hidden of [rej, unscoredLater]) await expect(scorecardRow(page, hidden)).toHaveCount(0);

    // the "Ready for Review" number is what is waiting for a decision: the four Applied-and-Screened rows, not the row at a later stage
    await expectBoxCount(page, 'Ready for Review', 4);
    // a row's own numbers: average to one decimal, gender tag, over-budget flag where the expectation is over the band
    await expect(scorecardRow(page, hi)).toContainText('8.4');
    await expect(scorecardRow(page, hi)).not.toContainText('Over Budget');
    await expect(scorecardRow(page, mid)).toContainText('Over Budget');
    await expect(scorecardRow(page, none)).toContainText('—');                                                                       // no average, no verdict
    // actions: the three decision buttons and a checkbox only on Applied and Screened
    for (const decided of [hi, mid, over, none]) {
      const row = scorecardRow(page, decided);
      await expect(row.getByRole('button', { name: 'Shortlist' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Reject' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Hold for future roles' })).toBeVisible();
      await expect(row.getByRole('checkbox')).toBeVisible();
    }
    await expect(scorecardRow(page, later).getByRole('button')).toHaveCount(0);                                                     // no decision is due at Interview Round 1 (and only Leadership gets the stage button)
    await expect(scorecardRow(page, later).getByRole('checkbox')).toHaveCount(0);
    errors.check();
  });

  test('View Highlights and Summary opens the strengths, red flags and summary of that application, and Hide closes them', async ({ page }) => {
    await gotoAs(page, 'hr', '/my-tasks');
    await searchFor(page, marker);
    const toggle = highlightsRowOf(page, hi).getByRole('button', { name: 'View Highlights and Summary' });
    await toggle.click();
    const detail = scorecardRow(page, hi).locator('xpath=following-sibling::tr[2]');
    await expect(detail).toContainText('Owns the IoT pipeline end to end');
    await expect(detail).toContainText('Short tenure at last employer');
    await expect(detail).toContainText('Strong product instincts for field software.');
    await highlightsRowOf(page, hi).getByRole('button', { name: 'Hide Highlights and Summary' }).click();
    await expect(page.getByText('Owns the IoT pipeline end to end')).toHaveCount(0);
  });

  test('Status filter replaces the Active default, Gender filter (incl. Not tagged) and In-budget only narrow the list, Average Score sorts it', async ({ page }) => {
    await gotoAs(page, 'hr', '/my-tasks');
    await searchFor(page, marker);
    await expect(scorecardRow(page, hi)).toBeVisible();

    // Status: Rejected is reachable only by asking for it, and then Active is no longer shown
    await setFilter(page, 'Status', { check: ['Rejected'] });
    await expect(scorecardRow(page, rej)).toBeVisible();
    await expect(scorecardRow(page, hi)).toHaveCount(0);
    await setFilter(page, 'Status', { uncheck: ['Rejected'] });
    await expect(scorecardRow(page, hi)).toBeVisible();
    await expect(scorecardRow(page, rej)).toHaveCount(0);

    // Gender: Male = hi + later; Female = mid; Not tagged = over + none (a SQL NULL needs its own branch on the server)
    await setFilter(page, 'Gender', { check: ['Male'] });
    await expect(scorecardRow(page, hi)).toBeVisible();
    await expect(scorecardRow(page, later)).toBeVisible();
    await expect(scorecardRow(page, mid)).toHaveCount(0);
    await setFilter(page, 'Gender', { uncheck: ['Male'], check: ['Female'] });
    await expect(scorecardRow(page, mid)).toBeVisible();
    await expect(scorecardRow(page, hi)).toHaveCount(0);
    await setFilter(page, 'Gender', { check: ['Not tagged'] });                                                                     // Female + Not tagged: the union
    await expect(scorecardRow(page, mid)).toBeVisible();
    await expect(scorecardRow(page, over)).toBeVisible();
    await expect(scorecardRow(page, none)).toBeVisible();
    await expect(scorecardRow(page, hi)).toHaveCount(0);
    await setFilter(page, 'Gender', { uncheck: ['Female', 'Not tagged'] });                                                         // nothing selected: back to all
    await expect(scorecardRow(page, hi)).toBeVisible();

    // In-budget only hides what is 15%+ over the band (40 > 23) and keeps what is merely over (22) or cannot be judged (no expectation)
    await page.getByRole('button', { name: 'In-budget only' }).click();
    await expect(scorecardRow(page, over)).toHaveCount(0);
    for (const kept of [hi, mid, none]) await expect(scorecardRow(page, kept)).toBeVisible();
    await page.getByRole('button', { name: 'In-budget only' }).click();
    await expect(scorecardRow(page, over)).toBeVisible();

    // Sort by Average Score: descending first (unscored last), ascending on the second press
    const order = async () => (await candidateLinksInTable(page, marker)).map(n => n.replace(`E2E Table `, '').replace(` ${marker}`, ''));
    await page.getByRole('button', { name: 'Average Score' }).click();
    expect(await order()).toEqual(['hi', 'later', 'over', 'mid', 'none']);
    await page.getByRole('button', { name: 'Average Score' }).click();
    expect(await order()).toEqual(['none', 'mid', 'over', 'later', 'hi']);
  });

  test('Role filter by link: arriving from a role\'s Scorecard Summary button scopes the list to that role, and View all roles clears it', async ({ page }) => {
    const other = await fxT.role('other-role', { hm: 'Alex' });
    const otherApp = await fxT.app(await fxT.candidate('on-other-role'), other, { score: 6 });
    await gotoAs(page, 'hr', `/my-tasks?role_id=${role.id}`);
    await searchFor(page, marker);
    await expect(page.getByText('Filtered to')).toContainText(role.title);
    await expect(scorecardRow(page, hi)).toBeVisible();
    await expect(scorecardRow(page, otherApp)).toHaveCount(0);
    await page.getByRole('button', { name: 'View all roles' }).click();
    await expect(scorecardRow(page, otherApp)).toBeVisible();
    await expect(page.getByText('Filtered to')).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Ready for Review: the decision buttons', () => {
  let fxD: Fixtures, role: CreatedRole;

  test.beforeAll(async () => {
    fxD = group('Decide');
    role = await fxD.role('role', { hm: 'Alex', ctcBand: '10-20 LPA' });
  });

  async function openList(page: Page, who: 'hr' | 'hm_alex', app: CreatedApp) {
    await gotoAs(page, who, '/my-tasks');
    await searchFor(page, app.candidateName);
    await expect(scorecardRow(page, app)).toBeVisible();
  }

  test('Shortlist moves the candidate straight to Interview Round 1, tells the Hiring Manager, and takes the row out of the waiting count', async ({ page }) => {
    const app = await fxD.app(await fxD.candidate('shortlist-me', { expectedCtc: 15 }), role, { score: 7 });
    await openList(page, 'hr', app);
    await expectBoxCount(page, 'Ready for Review', 1);
    const posts = recordRequests(page, r => r.method === 'POST' && r.url.endsWith(`/applications/${app.id}/stage`));
    await scorecardRow(page, app).getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.getByText('Candidate shortlisted')).toBeVisible();
    await expect(scorecardRow(page, app).getByRole('button', { name: 'Shortlist' })).toHaveCount(0);                                  // no longer at the decision stage
    await expectBoxCount(page, 'Ready for Review', 0);

    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body!)).toMatchObject({ new_stage: 'Interview Round 1' });
    const row = (await db.query(`SELECT stage, status FROM applications WHERE id = $1`, [app.id])).rows[0];
    expect(row).toEqual({ stage: 'Interview Round 1', status: 'Active' });
    const hmRow = (await openPendingRows(db, app.id)).find(r => r.action_type === 'HM shortlist review');
    expect(hmRow, 'shortlisting raises the Hiring Manager\'s review task').toBeTruthy();
    expect(hmRow!.responsible_person).toBe('Alex');
  });

  test('a candidate 15%+ over the band cannot be shortlisted without a reason: the exception dialog asks for one and the reason is stored', async ({ page }) => {
    const app = await fxD.app(await fxD.candidate('way-over', { expectedCtc: 40 }), role, { score: 7 });
    await openList(page, 'hr', app);
    const posts = recordRequests(page, r => r.method === 'POST' && r.url.endsWith(`/applications/${app.id}/stage`));
    await scorecardRow(page, app).getByRole('button', { name: 'Shortlist' }).click();
    const modal = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'This candidate is 15%+ over budget' }) });
    await expect(modal).toBeVisible();
    expect(posts, 'nothing is sent before a reason is chosen').toHaveLength(0);
    await expect(modal.getByRole('button', { name: 'Shortlist' })).toBeDisabled();
    await modal.getByRole('combobox').selectOption('Leadership-approved exception');
    await modal.getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.getByText('Candidate shortlisted')).toBeVisible();
    await expect(modal).toHaveCount(0);
    const row = (await db.query(`SELECT stage, budget_exception_reason_cat AS reason FROM applications WHERE id = $1`, [app.id])).rows[0];
    expect(row).toEqual({ stage: 'Interview Round 1', reason: 'Leadership-approved exception' });
  });

  test('Hold for future roles puts the candidate on hold and removes them from the default (Active) list', async ({ page }) => {
    const app = await fxD.app(await fxD.candidate('hold-me'), role, { score: 6 });
    await openList(page, 'hr', app);
    await scorecardRow(page, app).getByRole('button', { name: 'Hold for future roles' }).click();
    await expect(page.getByText('Put on hold for future roles')).toBeVisible();
    await expect(scorecardRow(page, app)).toHaveCount(0);
    expect((await db.query(`SELECT status FROM applications WHERE id = $1`, [app.id])).rows[0].status).toBe('Hold for Future');
  });

  test('Reject needs at least one reason, takes several, and stores them as one joined value', async ({ page }) => {
    const app = await fxD.app(await fxD.candidate('reject-me'), role, { score: 4 });
    await openList(page, 'hr', app);
    await scorecardRow(page, app).getByRole('button', { name: 'Reject' }).click();
    const modal = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Reject candidate' }) });
    await expect(modal).toBeVisible();
    const confirm = modal.getByRole('button', { name: 'Reject', exact: true });
    await expect(confirm).toBeDisabled();
    await modal.getByLabel('Missing mandatory skill').check();
    await modal.getByLabel('Communication gap').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText('1 of 1 rejected')).toBeVisible();
    await expect(scorecardRow(page, app)).toHaveCount(0);
    const row = (await db.query(`SELECT status, rejection_reason_cat AS reasons FROM applications WHERE id = $1`, [app.id])).rows[0];
    expect(row.status).toBe('Rejected');
    expect(row.reasons.split('; ').sort()).toEqual(['Communication gap', 'Missing mandatory skill']);
  });

  test('selecting several rows shows the bulk bar with the count, and Hold for Future acts on exactly those rows', async ({ page }) => {
    const a = await fxD.app(await fxD.candidate('bulk-a'), role, { score: 6 });
    const b = await fxD.app(await fxD.candidate('bulk-b'), role, { score: 6 });
    const c = await fxD.app(await fxD.candidate('bulk-c'), role, { score: 6 });
    await gotoAs(page, 'hr', '/my-tasks');
    await searchFor(page, `${fxD.run}`);
    for (const app of [a, b, c]) await expect(scorecardRow(page, app)).toBeVisible();
    await scorecardRow(page, a).getByRole('checkbox').check();
    await scorecardRow(page, b).getByRole('checkbox').check();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Hold for Future', exact: true }).click();
    await expect(page.getByText('2 of 2 put on hold')).toBeVisible();
    await expect(scorecardRow(page, a)).toHaveCount(0);
    await expect(scorecardRow(page, b)).toHaveCount(0);
    await expect(scorecardRow(page, c)).toBeVisible();                                                                              // the unticked row is untouched
    const statuses = (await db.query(`SELECT id, status FROM applications WHERE id = ANY($1) ORDER BY id`, [[a.id, b.id, c.id]])).rows;
    expect(Object.fromEntries(statuses.map(r => [r.id, r.status]))).toEqual({ [a.id]: 'Hold for Future', [b.id]: 'Hold for Future', [c.id]: 'Active' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Portfolio >= 7.5 toggle', () => {
  let fxP: Fixtures;
  let flagged: CreatedRole, plain: CreatedRole;
  let p9: CreatedApp, p8: CreatedApp, p7: CreatedApp, pUnscored: CreatedApp, plainApp: CreatedApp;
  const toggle = (page: Page) => page.getByRole('button', { name: 'Portfolio ≥ 7.5' });

  test.beforeAll(async () => {
    fxP = group('Portfolio');
    flagged = await fxP.role('flagged', { hm: 'Alex', portfolio: { kind: 'design_portfolio' } });          // roles.portfolio_analysis_enabled = true, set by SQL like production
    plain   = await fxP.role('plain', { hm: 'Satyadev' });
    const done = (score: number | null, status: string) => ({ portfolio: { score, status } });
    p9 = await fxP.app(await fxP.candidate('p9'), flagged, { score: 7, ...done(9, 'completed') });
    p8 = await fxP.app(await fxP.candidate('p8'), flagged, { score: 7, ...done(8, 'completed') });
    p7 = await fxP.app(await fxP.candidate('p7'), flagged, { score: 7, ...done(7, 'completed') });
    pUnscored = await fxP.app(await fxP.candidate('p-unscored'), flagged, { score: 7, ...done(null, 'unreviewable') });
    plainApp = await fxP.app(await fxP.candidate('on-plain-role'), plain, { score: 7 });
    // the Satyadev checks below need him to own no flagged role at all
    const stray = await db.query(
      `SELECT id FROM roles WHERE portfolio_analysis_enabled AND id <> $1 AND hiring_manager_name ILIKE '%satyadev%'`, [flagged.id]);
    expect(stray.rows, 'a leftover role flagged for portfolio review names Satyadev as Hiring Manager; remove it').toEqual([]);
  });

  test('the toggle is offered only where a portfolio-reviewed role can be in the list: hidden for a role without review, shown for one with it, shown with no role filter', async ({ page }) => {
    await gotoAs(page, 'hr', `/my-tasks?role_id=${plain.id}`);
    await expect(page.getByPlaceholder('Search candidate or role…')).toBeVisible();
    await expect(page.getByText('Filtered to')).toContainText(plain.title);
    await expect(toggle(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'View all roles' }).click();                                                              // no role filter: the flagged role is in scope
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

    await gotoAs(page, 'hr', `/my-tasks?role_id=${flagged.id}`);
    await expect(toggle(page)).toBeVisible();
  });

  test('turning it on asks the server for portfolio scores of 7.5 or more: 9 and 8 stay, 7 and "not scored" go, a note says so and Turn off restores the list', async ({ page }) => {
    const queries = recordRequests(page, r => r.method === 'GET' && /\/api\/applications\?/.test(r.url));
    await gotoAs(page, 'hr', `/my-tasks?role_id=${flagged.id}`);
    for (const a of [p9, p8, p7, pUnscored]) await expect(scorecardRow(page, a)).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Portfolio' })).toBeVisible();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(q => !q.url.includes('min_portfolio_score'))).toBe(true);

    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('portfolio-filter-note')).toBeVisible();
    await expect(scorecardRow(page, p7)).toHaveCount(0);
    await expect(scorecardRow(page, pUnscored)).toHaveCount(0);
    await expect(scorecardRow(page, p9)).toBeVisible();
    await expect(scorecardRow(page, p8)).toBeVisible();
    const filtered = queries[queries.length - 1];
    expect(new URL(filtered.url).searchParams.get('min_portfolio_score')).toBe('7.5');                                              // applied in SQL, not after the 500-row cap
    await expect(scorecardRow(page, p9)).toContainText('9');

    await page.getByTestId('portfolio-filter-note').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByTestId('portfolio-filter-note')).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    for (const a of [p9, p8, p7, pUnscored]) await expect(scorecardRow(page, a)).toBeVisible();
  });

  test('a remembered "on" is applied only while the control is shown: on a role without review the list is not narrowed and nothing is requested with the filter', async ({ page }) => {
    await gotoAs(page, 'hr', `/my-tasks?role_id=${flagged.id}`);
    await toggle(page).click();
    await expect(page.getByTestId('portfolio-filter-note')).toBeVisible();
    // the choice survives navigating away and back (session storage), still on for the flagged role ...
    await page.goto(`${FRONTEND_BASE}/dashboard`);
    await page.goBack();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

    // ... but for a role that has no portfolio review the toggle is gone, the note is gone and the request carries no minimum
    const queries = recordRequests(page, r => r.method === 'GET' && /\/api\/applications\?/.test(r.url));
    await page.goto(`${FRONTEND_BASE}/my-tasks?role_id=${plain.id}`);
    await expect(scorecardRow(page, plainApp)).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.getByTestId('portfolio-filter-note')).toHaveCount(0);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter(q => q.url.includes('min_portfolio_score'))).toEqual([]);
  });

  test('a Hiring Manager gets the toggle only for their own portfolio-reviewed role: Alex (owns it) yes, Satyadev (does not) no', async ({ page }) => {
    await gotoAs(page, 'hm_alex', '/my-tasks');
    await expect(toggle(page)).toBeVisible();
    await gotoAs(page, 'hm_satyadev', '/my-tasks');
    await expect(page.getByPlaceholder('Search candidate or role…')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Gender/ })).toBeVisible();                                                       // the filter bar has rendered
    await expect(toggle(page)).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Retry scoring', () => {
  let fxR: Fixtures, role: CreatedRole;
  let u1: CreatedApp, u2: CreatedApp, scored: CreatedApp;
  const retry = (page: Page) => page.getByRole('button', { name: 'Retry scoring' });

  test.beforeAll(async () => {
    fxR = group('Retry');
    role = await fxR.role('role', { hm: 'Alex' });
    u1 = await fxR.app(await fxR.candidate('unscored-1'), role, { score: null });
    u2 = await fxR.app(await fxR.candidate('unscored-2'), role, { score: null });
    scored = await fxR.app(await fxR.candidate('scored'), role, { score: 7 });
  });

  test('HR sees how many candidates have no score and Retry scoring asks the server for exactly those applications, once each', async ({ page }) => {
    const posts = recordRequests(page, r => r.method === 'POST' && /\/applications\/[^/]+\/retry-scoring$/.test(r.url));
    const answers: Record<string, { scored?: boolean }> = {};
    page.on('response', async res => {
      const m = /\/applications\/([^/]+)\/retry-scoring$/.exec(res.url());
      if (m && res.request().method() === 'POST') answers[m[1]] = (await res.json()).resumeiq;
    });
    await gotoAs(page, 'hr', '/my-tasks');
    await searchFor(page, fxR.run);
    await expect(scorecardRow(page, scored)).toBeVisible();
    await expect(page.getByText('2 candidates without a ResumeIQ score')).toBeVisible();
    await expect(scorecardRow(page, u1)).toBeVisible();

    await retry(page).click();
    await expect(page.getByText('2 of 2 retried')).toBeVisible();
    expect(posts.map(p => p.url.split('/applications/')[1].split('/')[0]).sort()).toEqual([u1.id, u2.id].sort());                    // never the scored one
    await expect.poll(() => Object.keys(answers).sort()).toEqual([u1.id, u2.id].sort());

    // The list then shows whatever the backend reported. With no Anthropic key (the isolated stack) scoring cannot happen: the answer says so,
    // the rows stay unscored and the banner stays. With a key (a live run) the rows are scored and the banner is gone. Either way, UI == server.
    const scoredNow = (await db.query(`SELECT id, score_avg FROM applications WHERE id = ANY($1)`, [[u1.id, u2.id]])).rows;
    for (const r of scoredNow) expect(r.score_avg !== null, `application ${r.id}: the stored score must agree with the answer`).toBe(answers[r.id].scored === true);
    if (Object.values(answers).every(a => a.scored === false)) {
      await expect(page.getByText('2 candidates without a ResumeIQ score')).toBeVisible();
      await expect(retry(page)).toBeVisible();
      await expect(scorecardRow(page, u1)).toContainText('—');
    } else {
      await expect(page.getByText(/candidates? without a ResumeIQ score/)).toHaveCount(0);
    }
  });

  test('a Hiring Manager sees the same unscored candidate but cannot retry: no banner, no button, and the server says 403', async ({ page }) => {
    await gotoAs(page, 'hm_alex', '/my-tasks');
    await searchFor(page, fxR.run);
    await expect(scorecardRow(page, u1)).toBeVisible();
    await expect(scorecardRow(page, scored)).toBeVisible();
    await expect(page.getByText(/without a ResumeIQ score/)).toHaveCount(0);
    await expect(retry(page)).toHaveCount(0);
    const res = await authed(page.request, await getToken(page.request, 'hm_alex')).post(`/api/applications/${u1.id}/retry-scoring`, {});
    expect(res.status()).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Leadership user who is also a role\'s Hiring Manager', () => {
  let fxL: Fixtures, leaderName = '';
  let own: CreatedRole, other: CreatedRole;
  let ownStale: CreatedApp, ownFresh: CreatedApp, otherStale: CreatedApp, otherFlagged: CreatedApp, otherPlain: CreatedApp;

  test.beforeAll(async ({ request }) => {
    fxL = group('Leader');
    leaderName = (await db.query(`SELECT name FROM users WHERE email = $1`, [USERS.leadership.email])).rows[0].name;
    own   = await fxL.role('own', { hm: leaderName, priority: 'P1' });                // the Leadership user IS the named Hiring Manager
    other = await fxL.role('other', { hm: 'Someone Else', priority: 'P1' });
    ownStale     = await fxL.app(await fxL.candidate('own-stale'), own, { score: 7, hoursInStage: 60 });
    ownFresh     = await fxL.app(await fxL.candidate('own-fresh'), own, { score: 7 });
    otherStale   = await fxL.app(await fxL.candidate('other-stale'), other, { score: 7, hoursInStage: 60 });
    otherFlagged = await fxL.app(await fxL.candidate('other-flagged'), other, { score: 7, founderFlag: true });
    otherPlain   = await fxL.app(await fxL.candidate('other-plain'), other, { score: 7 });
    await runSlaSweep(request);
    expect((await openPendingRows(db, ownStale.id)).map(r => r.action_type)).toContain(SHORTLIST_PENDING);
    expect((await openPendingRows(db, otherStale.id)).map(r => r.action_type)).toContain(SHORTLIST_PENDING);
    // a Hiring-Manager row that merely NAMES the leader on somebody else's role (the shape you get as an interviewer elsewhere)
    await db.query(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person)
       VALUES ('Hiring Manager', 'High', 'HM shortlist review', 'named, not their role', $1, $2, $3, 0, $4, $5)`,
      [otherPlain.id, otherPlain.candidateName, other.title, other.id, leaderName]);
  });

  test.beforeEach(async () => {
    await pinPendingRows(db, { appIds: [ownStale.id, otherStale.id, otherPlain.id] });
  });

  test('the box is "Other Pending Actions" (not the alerts-only one), a note names the role, and the queue holds the role\'s Hiring Manager rows and nothing from other roles', async ({ page }) => {
    const errors = expectNoPageErrors(page);
    await gotoAs(page, 'leadership', '/my-tasks');
    await expect(taskBox(page, 'Other Pending Actions')).toBeVisible();
    await expect(taskBox(page, 'Leadership Alerts')).toHaveCount(0);
    const note = page.getByTestId('hm-roles-note');
    await expect(note).toContainText(own.title);
    await expect(note).not.toContainText(other.title);

    await openBox(page, 'Other Pending Actions');
    await expect(page.getByRole('link', { name: ownStale.candidateName, exact: true })).toHaveAttribute('href', `/candidates/${ownStale.candidateId}`);
    await expect(queueEntry(page, ownStale, SHORTLIST_PENDING)).toContainText(own.title);
    await expect(page.getByRole('link', { name: otherStale.candidateName, exact: true })).toHaveCount(0);                              // somebody else's role
    await expect(page.getByRole('link', { name: otherPlain.candidateName, exact: true })).toHaveCount(0);                              // a row that only names them
    await expect(page.getByRole('link', { name: ownFresh.candidateName, exact: true })).toHaveCount(0);                               // not overdue
    // the number is the server's: the countable (non-alert) rows
    const body = await pendingFor(page, 'leadership');
    expect(body.hm_roles.map(r => r.id)).toContain(own.id);
    expect(body.hm_roles.map(r => r.id)).not.toContain(other.id);
    await expectBoxCount(page, 'Other Pending Actions', body.actions.filter(a => !FEEDBACK_DUE_TYPES.includes(a.action_type)).length);
    errors.check();
  });

  test('Ready for Review is Founder-flagged candidates PLUS every candidate of the role they are Hiring Manager of', async ({ page }) => {
    await gotoAs(page, 'leadership', '/my-tasks');
    await searchFor(page, fxL.run);
    for (const shown of [ownStale, ownFresh, otherFlagged]) await expect(scorecardRow(page, shown)).toBeVisible();
    await expect(scorecardRow(page, otherPlain)).toHaveCount(0);                                                                       // unflagged, and somebody else's role
    await expect(scorecardRow(page, otherStale)).toHaveCount(0);
    await expectBoxCount(page, 'Ready for Review', 3);
  });

  test('it is not a persona switch: no role lock and no comp hiding for them, and HR sees neither the note nor the role-scoped queue', async ({ page }) => {
    const me = await (await authed(page.request, await getToken(page.request, 'leadership')).get('/api/auth/me')).json();
    expect((me.user ?? me).persona).toBe('leadership');
    const roles = await (await authed(page.request, await getToken(page.request, 'leadership')).get('/api/roles')).json();
    const seen = (roles.roles as { id: string; ctc_band?: string }[]).find(r => r.id === other.id);
    expect(seen?.ctc_band, 'Leadership still sees the compensation of a role that is not theirs').toBe('20-25 LPA');

    await gotoAs(page, 'hr', '/my-tasks');
    await expect(page.getByRole('button', { name: /^Ready for Review/ })).toBeVisible();
    await expect(page.getByTestId('hm-roles-note')).toHaveCount(0);
  });

  test('when the pending-actions request fails the page says it cannot tell which roles they manage (Founder-flagged only) and Retry brings the full view back', async ({ page }) => {
    let fail = true;
    await page.route('**/api/dashboard/pending', route => (fail ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.continue()));
    await gotoAs(page, 'leadership', '/my-tasks');
    await expect(page.getByRole('alert')).toBeVisible();
    await searchFor(page, fxL.run);
    await expect(scorecardRow(page, otherFlagged)).toBeVisible();
    await expect(scorecardRow(page, ownFresh)).toHaveCount(0);                                                                         // the narrower list, not pretending to be everything
    fail = false;
    await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('hm-roles-note')).toContainText(own.title);
    await expect(scorecardRow(page, ownFresh)).toBeVisible();
  });

  test('control: when nobody names them as Hiring Manager they get the alerts-only box, no note, and Ready for Review is Founder-flagged candidates only', async ({ page }) => {
    await db.query(`UPDATE roles SET hiring_manager_name = $2 WHERE id = $1`, [own.id, `Nobody ${fxL.run}`]);
    try {
      const body = await pendingFor(page, 'leadership');
      expect(body.hm_roles, 'precondition: no OTHER role may name the Leadership user as Hiring Manager (clean up leftover roles)').toEqual([]);
      await gotoAs(page, 'leadership', '/my-tasks');
      await expect(taskBox(page, 'Leadership Alerts')).toBeVisible();
      await expect(taskBox(page, 'Other Pending Actions')).toHaveCount(0);
      await expect(page.getByTestId('hm-roles-note')).toHaveCount(0);
      await searchFor(page, fxL.run);
      await expect(scorecardRow(page, otherFlagged)).toBeVisible();
      await expect(scorecardRow(page, ownFresh)).toHaveCount(0);
      await expect(scorecardRow(page, ownStale)).toHaveCount(0);
    } finally {
      await db.query(`UPDATE roles SET hiring_manager_name = $2 WHERE id = $1`, [own.id, leaderName]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('A role with two Hiring Managers', () => {
  let fxC: Fixtures;
  let both: CreatedRole, lookalike: CreatedRole, neither: CreatedRole;
  let bothApp: CreatedApp, lookApp: CreatedApp, neitherApp: CreatedApp;

  test.beforeAll(async ({ request }) => {
    fxC = group('CoHM');
    both      = await fxC.role('both', { hm: 'Alex, Satyadev', priority: 'P1' });                       // the seeded Hiring Managers Alex and Satyadev
    lookalike = await fxC.role('lookalike', { hm: 'Alexander, Satyadev Kumar', priority: 'P1' });          // look-alikes: neither is Alex or Satyadev
    neither   = await fxC.role('neither', { hm: 'Someone Else & Nalin', priority: 'P1' });                 // two other people entirely
    bothApp    = await fxC.app(await fxC.candidate('on-both'), both, { score: 7, hoursInStage: 60 });
    lookApp    = await fxC.app(await fxC.candidate('on-lookalike'), lookalike, { score: 7, hoursInStage: 60 });
    neitherApp = await fxC.app(await fxC.candidate('on-neither'), neither, { score: 7, hoursInStage: 60 });
    await runSlaSweep(request);
    for (const a of [bothApp, lookApp, neitherApp]) expect((await openPendingRows(db, a.id)).map(r => r.action_type)).toContain(SHORTLIST_PENDING);
    expect((await openPendingRows(db, bothApp.id)).find(r => r.action_type === SHORTLIST_PENDING)!.responsible_person).toBe('Alex, Satyadev');   // the engine copies the whole field
  });

  test.beforeEach(async () => {
    await pinPendingRows(db, { appIds: [bothApp.id, lookApp.id, neitherApp.id] });
  });

  for (const who of ['hm_alex', 'hm_satyadev'] as const) {
    test(`${who}: the task of a role they share is in their queue and in Ready for Review; a role that names two other people is in neither`, async ({ page }) => {
      await gotoAs(page, who, '/my-tasks');
      await searchFor(page, fxC.run);
      await expect(scorecardRow(page, bothApp)).toBeVisible();
      await expect(scorecardRow(page, neitherApp)).toHaveCount(0);
      await expect(scorecardRow(page, lookApp)).toHaveCount(0);                                                                      // Ready for Review matches whole names: "Alexander" is not "Alex"
      await expectBoxCount(page, 'Ready for Review', 1);

      await openBox(page, 'Other Pending Actions');
      await expect(page.getByRole('link', { name: bothApp.candidateName, exact: true })).toHaveAttribute('href', `/candidates/${bothApp.candidateId}`);
      await expect(page.getByRole('link', { name: neitherApp.candidateName, exact: true })).toHaveCount(0);
    });
  }

  test('TODAY: the queue (unlike Ready for Review and the role page) matches a name as a SUBSTRING of the row\'s Hiring Manager text, so both Alex and Satyadev also get the task of the look-alike role', async ({ page }) => {
    // Documented and left alone (CLAUDE.md, "Pre-existing and left alone"): GET /dashboard/pending uses position(name IN responsible_person).
    // When that is tightened to the whole-name rule this test must flip to "toHaveCount(0)" for both.
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      await gotoAs(page, who, '/my-tasks');
      await searchFor(page, fxC.run);
      await expect(scorecardRow(page, bothApp)).toBeVisible();
      await expect(scorecardRow(page, lookApp), `${who}'s Ready for Review does not list the look-alike role's candidate`).toHaveCount(0);
      await openBox(page, 'Other Pending Actions');
      await expect(page.getByRole('link', { name: lookApp.candidateName, exact: true }), `${who} receives the look-alike role's task`).toBeVisible();
    }
  });

  test('HR editing the Hiring Manager field: a name nobody has is saved but warned about, the field is stored as "A, B", and a correct list gives no warning', async ({ page }) => {
    const stranger = `Zed Nobody ${fxC.run}`;
    await gotoAs(page, 'hr', `/roles/${both.id}`);
    await expect(page.getByRole('heading', { name: both.title, level: 1 })).toBeVisible();
    const basic = page.locator('div.card').filter({ has: page.getByRole('heading', { name: 'Basic Info', level: 2 }) });

    await basic.getByRole('button', { name: 'Edit Basic Info' }).click();
    await basic.locator('label:text-is("Hiring Manager") + input').fill(`Alex ;  ${stranger}`);
    await basic.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`No HMS user is named ${stranger}`)).toBeVisible();
    await expect(basic.getByRole('button', { name: 'Edit Basic Info' })).toBeVisible();
    expect((await db.query(`SELECT hiring_manager_name AS hm FROM roles WHERE id = $1`, [both.id])).rows[0].hm).toBe(`Alex, ${stranger}`);

    // the warning stays on screen for 9 s: reload so the next save starts with no toast on the page, then fix the list
    await page.reload();
    await expect(page.getByRole('heading', { name: both.title, level: 1 })).toBeVisible();
    await expect(page.getByText(/No HMS user is named/)).toHaveCount(0);
    await basic.getByRole('button', { name: 'Edit Basic Info' }).click();
    await basic.locator('label:text-is("Hiring Manager") + input').fill('Alex, Satyadev');
    await basic.getByRole('button', { name: 'Save' }).click();
    await expect(basic.getByRole('button', { name: 'Edit Basic Info' })).toBeVisible();
    await expect(basic.getByText('Alex, Satyadev')).toBeVisible();
    await expect(page.getByText(/No HMS user is named/)).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('A Hiring Manager\'s own My Tasks (Alex)', () => {
  let fxH: Fixtures;
  let mine: CreatedRole, theirs: CreatedRole;
  let mineStale: CreatedApp, mineFresh: CreatedApp, theirsStale: CreatedApp, feedbackApp: CreatedApp;

  test.beforeAll(async ({ request }) => {
    fxH = group('HM');
    mine   = await fxH.role('mine', { hm: 'Alex', priority: 'P1', ctcBand: '10-20 LPA' });
    theirs = await fxH.role('theirs', { hm: 'Satyadev', priority: 'P1' });
    mineStale   = await fxH.app(await fxH.candidate('mine-stale', { expectedCtc: 15 }), mine, { score: 7, hoursInStage: 60 });
    mineFresh   = await fxH.app(await fxH.candidate('mine-fresh', { expectedCtc: 40 }), mine, { score: 6 });          // 15%+ over a band the Hiring Manager cannot see
    theirsStale = await fxH.app(await fxH.candidate('theirs-stale'), theirs, { score: 7, hoursInStage: 60 });
    feedbackApp = await fxH.app(await fxH.candidate('feedback'), mine, { score: 7, stage: 'Interview Round 1', hoursInStage: 80 });
    await fxH.round(feedbackApp, { interviewerEmails: [USERS.hm_alex.email], hoursAgo: 60 });                           // interview 60 h ago, no feedback (48 h allowed)
    await runSlaSweep(request);
    expect((await openPendingRows(db, mineStale.id)).map(r => r.action_type)).toContain(SHORTLIST_PENDING);
    expect((await openPendingRows(db, feedbackApp.id)).map(r => r.action_type)).toContain('Interview 1 Feedback Due');
  });

  test.beforeEach(async () => {
    await pinPendingRows(db, { appIds: [mineStale.id, theirsStale.id, feedbackApp.id] });
  });

  test('Ready for Review lists only the candidates of roles they manage; the queue holds only Hiring-Manager rows that name them; there is no Sourcing box', async ({ page }) => {
    const errors = expectNoPageErrors(page);
    await gotoAs(page, 'hm_alex', '/my-tasks');
    await searchFor(page, fxH.run);
    await expect(scorecardRow(page, mineStale)).toBeVisible();
    await expect(scorecardRow(page, mineFresh)).toBeVisible();
    await expect(scorecardRow(page, theirsStale)).toHaveCount(0);
    await expectBoxCount(page, 'Ready for Review', 2);
    await expect(page.getByRole('button', { name: /^Sourcing/ })).toHaveCount(0);                                                       // recruiters only

    await openBox(page, 'Other Pending Actions');
    await expect(queueEntry(page, mineStale, SHORTLIST_PENDING)).toContainText(mine.title);
    await expect(page.getByRole('link', { name: theirsStale.candidateName, exact: true })).toHaveCount(0);
    const body = await pendingFor(page, 'hm_alex');
    expect(body.actions.every(a => a.owner_type === 'Hiring Manager')).toBe(true);
    await expectBoxCount(page, 'Other Pending Actions', body.actions.filter(a => !FEEDBACK_DUE_TYPES.includes(a.action_type)).length);
    errors.check();
  });

  test('Feedback Due lists the round they are the interviewer of, shows how overdue it is, and Submit feedback opens that candidate', async ({ page }) => {
    await gotoAs(page, 'hm_alex', '/my-tasks');
    const body = await pendingFor(page, 'hm_alex');
    await expectBoxCount(page, 'Feedback Due', body.actions.filter(a => FEEDBACK_DUE_TYPES.includes(a.action_type)).length);
    await openBox(page, 'Feedback Due');
    // the entry: the nearest block around the candidate's name that holds its Submit feedback button
    const row = page.getByText(feedbackApp.candidateName, { exact: true }).locator('xpath=ancestor::div[.//button[normalize-space()="Submit feedback"]][1]');
    await expect(row).toContainText(feedbackApp.roleTitle);
    await expect(row).toContainText(/\d+h overdue/);
    await row.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(page).toHaveURL(new RegExp(`/candidates/${feedbackApp.candidateId}$`));
    await expect(page.getByRole('heading', { name: feedbackApp.candidateName, level: 1 })).toBeVisible();
  });

  test('shortlisting is open to a Hiring Manager from Applied and Screened — and a candidate far over their role\'s band still gets the budget-exception dialog, with nothing sent until a reason is chosen', async ({ page }) => {
    await gotoAs(page, 'hm_alex', '/my-tasks');
    await searchFor(page, fxH.run);
    await scorecardRow(page, mineStale).getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.getByText('Candidate shortlisted')).toBeVisible();
    expect((await db.query(`SELECT stage FROM applications WHERE id = $1`, [mineStale.id])).rows[0].stage).toBe('Interview Round 1');

    // the named Hiring Manager sees the compensation of their own role, so the row carries the flag too
    await expect(scorecardRow(page, mineFresh)).toContainText('Over Budget');
    const posts = recordRequests(page, r => r.method === 'POST' && r.url.endsWith(`/applications/${mineFresh.id}/stage`));
    await scorecardRow(page, mineFresh).getByRole('button', { name: 'Shortlist' }).click();
    const modal = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'This candidate is 15%+ over budget' }) });
    await expect(modal).toBeVisible();
    expect(posts).toHaveLength(0);
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
    expect((await db.query(`SELECT stage FROM applications WHERE id = $1`, [mineFresh.id])).rows[0].stage).toBe('Applied and Screened');
  });

  test('Satyadev does not see Alex\'s role: his Ready for Review has none of these candidates', async ({ page }) => {
    await gotoAs(page, 'hm_satyadev', '/my-tasks');
    await searchFor(page, fxH.run);
    await expect(scorecardRow(page, theirsStale)).toBeVisible();
    await expect(scorecardRow(page, mineFresh)).toHaveCount(0);
    await expectBoxCount(page, 'Ready for Review', 1);
  });
});
