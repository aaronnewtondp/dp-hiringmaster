/**
 * E2E — what HR (and a Hiring Manager) can do on a role page (/roles/:id) beyond Approve (tests/e2e/03) and inline editing (04):
 * change status to On Hold and to Closed, the closure summary PDF, discarding a Draft, a Hiring Manager's missing approval controls, the
 * "manually provided JD" note and the Regenerate JD button, the Portfolio review card in its different states (reached the way HR reaches
 * it: role page -> Scorecard Summary -> View Highlights and Summary), and the compensation panel for HR versus a Hiring Manager.
 *
 * Data: written by SQL (helpers/e2e-roles.ts) — a role's JD source, a stored review and a portfolio flag have no API — and removed in
 * afterAll. No Anthropic key, no Google: JD (re)generation cannot succeed here, so what is asserted is that the page shows what the server
 * reports; the one test that needs a real model is tagged @live.
 */
import { test, expect, Page } from '@playwright/test';
import { Client } from 'pg';
import fs from 'fs';
import { uid, getToken, authed } from '../helpers/api';
import { newClient } from '../helpers/db';
import { pastIso } from '../helpers/dates';
import { expectNoPageErrors, gotoAs } from '../helpers/e2e';
import { Fixtures, CreatedApp, CreatedRole, recordRequests, tableRowOf } from '../helpers/e2e-roles';

const RUN = uid();
let db: Client;
let fx: Fixtures;

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  db = newClient();
  await db.connect();
  fx = new Fixtures(db, RUN, 'E2E RoleDetail');
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  // a discarded role is gone, but the log of its discarding stays (activity_log.role_id is SET NULL): remove this run's
  await db.query(`DELETE FROM activity_log WHERE event_type = 'Role Discarded' AND event_detail LIKE $1`, [`% ${RUN} discarded`]);
  await fx.cleanup();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const sectionCard = (page: Page, title: string) =>
  page.locator('div.card').filter({ has: page.getByRole('heading', { name: title, level: 2 }) });

/** The "Update status" dialog (a fixed overlay with that heading). */
const statusDialog = (page: Page) =>
  page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Update status' }) });

async function openRole(page: Page, who: Parameters<typeof gotoAs>[1], role: CreatedRole) {
  await gotoAs(page, who, `/roles/${role.id}`);
  await expect(page.getByRole('heading', { name: role.title, level: 1 })).toBeVisible();
}

async function changeStatusTo(page: Page, status: string) {
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = statusDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').selectOption(status);
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
}

const roleRow = async (id: string) => (await db.query(`SELECT * FROM roles WHERE id = $1`, [id])).rows[0];

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Change status and the closure summary', () => {
  test('On Hold: the dialog starts on the current status, saving says so, the header badge follows, and the server holds the change', async ({ page }) => {
    const role = await fx.role('hold');
    const errors = expectNoPageErrors(page);
    await openRole(page, 'hr', role);
    await page.getByRole('button', { name: 'Change status' }).click();
    const dialog = statusDialog(page);
    await expect(dialog.getByRole('combobox')).toHaveValue('Live – Sourcing');                                                       // opens on where the role is now
    for (const s of ['Draft', 'Under Review', 'Approved', 'Live – Sourcing', 'On Hold', 'Closed – Filled', 'Closed – Cancelled']) {
      await expect(dialog.getByRole('combobox').locator(`option[value="${s}"]`)).toHaveCount(1);
    }
    const patches = recordRequests(page, r => r.method === 'PATCH' && r.url.endsWith(`/roles/${role.id}`));
    await dialog.getByRole('combobox').selectOption('On Hold');
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Status updated to On Hold')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: role.title, level: 1 }).locator('xpath=..')).toContainText('On Hold');

    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0].body!)).toEqual({ status: 'On Hold' });
    expect((await roleRow(role.id)).status).toBe('On Hold');
    const logged = await db.query(`SELECT event_detail, performed_by_name FROM activity_log WHERE role_id = $1 AND event_type = 'Status Changed'`, [role.id]);
    expect(logged.rows).toEqual([{ event_detail: 'Status → On Hold', performed_by_name: 'Aaron Newton' }]);
    // and back again: nothing about a hold is sticky
    await changeStatusTo(page, 'Live – Sourcing');
    await expect(page.getByText('Status updated to Live – Sourcing')).toBeVisible();
    expect((await roleRow(role.id)).status).toBe('Live – Sourcing');
    errors.check();
  });

  test('Cancel closes the dialog without sending anything', async ({ page }) => {
    const role = await fx.role('cancel-status');
    await openRole(page, 'hr', role);
    const patches = recordRequests(page, r => r.method === 'PATCH');
    await page.getByRole('button', { name: 'Change status' }).click();
    const dialog = statusDialog(page);
    await dialog.getByRole('combobox').selectOption('Closed – Cancelled');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(patches).toHaveLength(0);
    expect((await roleRow(role.id)).status).toBe('Live – Sourcing');
  });

  test('Closed – Filled: the Download Closure Summary button appears, and it delivers a real PDF named after the role', async ({ page }) => {
    const role = await fx.role('close-me');
    const cand = await fx.candidate('closer');
    await fx.app(cand, role, { score: 7, status: 'Joined', stage: 'Joined' });                                                          // the summary covers every application the role ever saw
    await openRole(page, 'hr', role);
    await expect(page.getByRole('button', { name: 'Download Closure Summary' })).toHaveCount(0);                                         // not while the role is open
    const open = await authed(page.request, await getToken(page.request, 'hr')).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(open.status(), 'the server refuses a summary for a role that is not closed').toBe(400);

    await changeStatusTo(page, 'Closed – Filled');
    await expect(page.getByText('Status updated to Closed – Filled')).toBeVisible();
    const button = page.getByRole('button', { name: 'Download Closure Summary' });
    await expect(button).toBeVisible();

    const answered = page.waitForResponse(r => r.url().endsWith(`/roles/${role.id}/closure-summary.pdf`));
    const downloading = page.waitForEvent('download');
    await button.click();
    const res = await answered;
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`${role.id}-closure-summary.pdf`);
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    await expect(button).toBeEnabled();                                                                                                   // "Generating…" is over
  });

  test('the closure summary button is for closed roles only (Filled or Cancelled), and only the roles of the person asking: a Hiring Manager of another role is refused', async ({ page }) => {
    const filled = await fx.role('filled', { status: 'Closed – Filled' });
    const cancelled = await fx.role('cancelled', { status: 'Closed – Cancelled' });
    const open = await fx.role('still-open', { status: 'On Hold' });
    for (const closed of [filled, cancelled]) {
      await openRole(page, 'hr', closed);
      await expect(page.getByRole('button', { name: 'Download Closure Summary' })).toBeVisible();
    }
    await openRole(page, 'hr', open);
    await expect(page.getByRole('button', { name: 'Download Closure Summary' })).toHaveCount(0);

    const api = (who: 'hr' | 'hm_alex' | 'hm_satyadev') => getToken(page.request, who).then(t => authed(page.request, t).get(`/api/roles/${filled.id}/closure-summary.pdf`));
    expect((await api('hr')).status()).toBe(200);
    expect((await api('hm_alex')).status(), 'the role\'s own Hiring Manager may download it').toBe(200);
    expect((await api('hm_satyadev')).status(), 'another Hiring Manager may not').toBe(403);
  });

  test('TODAY: the activity timeline on the page does not refresh after Change status (approving does) — the new entry shows after a reload', async ({ page }) => {
    const role = await fx.role('timeline');
    await openRole(page, 'hr', role);
    await expect(page.getByText('No activity logged yet')).toBeVisible();
    await changeStatusTo(page, 'On Hold');
    await expect(page.getByText('Status updated to On Hold')).toBeVisible();
    await expect(statusDialog(page)).toHaveCount(0);
    // the timeline query is not invalidated by handleStatusUpdate (RoleDetail.tsx), unlike handleApprove: still empty
    await expect(page.getByText('No activity logged yet')).toBeVisible();
    await page.reload();
    const timeline = page.locator('div.card').filter({ has: page.getByRole('heading', { name: 'Activity timeline' }) });
    await expect(timeline).toContainText('Status Changed');
    await expect(timeline).toContainText('Status → On Hold');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Discarding a Draft role', () => {
  test('Discard role asks first (Cancel keeps it), then deletes the Draft, says so, and leaves the role page for the list', async ({ page }) => {
    const role = await fx.role('discard-me', { status: 'Draft', title: `E2E RoleDetail discard-me ${RUN}` });
    await openRole(page, 'hr', role);
    await page.getByRole('button', { name: 'Discard role' }).click();
    const dialog = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: `Discard ${role.title}?` }) });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await roleRow(role.id), 'Cancel must not delete').toBeTruthy();

    const deletes = recordRequests(page, r => r.method === 'DELETE');
    await page.getByRole('button', { name: 'Discard role' }).click();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('Role discarded')).toBeVisible();
    await expect(page).toHaveURL(/\/roles$/);
    expect(deletes.map(d => d.url.split('/api')[1])).toEqual([`/roles/${role.id}`]);
    expect(await roleRow(role.id)).toBeUndefined();
    const logged = await db.query(`SELECT performed_by_name FROM activity_log WHERE event_type = 'Role Discarded' AND event_detail = $1`, [`${role.title} discarded`]);
    expect(logged.rows).toEqual([{ performed_by_name: 'Aaron Newton' }]);
  });

  test('a Draft that already has an application cannot be discarded: the server says why, the page stays, the role stays', async ({ page }) => {
    const role = await fx.role('has-applicant', { status: 'Draft' });
    await fx.app(await fx.candidate('applicant'), role, { score: 6 });
    await openRole(page, 'hr', role);
    await page.getByRole('button', { name: 'Discard role' }).click();
    await page.locator('div.fixed.inset-0').getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('This role already has applications and cannot be discarded')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/roles/${role.id}$`));
    expect(await roleRow(role.id)).toBeTruthy();
  });

  test('Discard role exists only for a Draft, and only for HR-tier: not on a live role, not for the Hiring Manager of the Draft', async ({ page }) => {
    const live = await fx.role('live-no-discard');
    await openRole(page, 'hr', live);
    await expect(page.getByRole('button', { name: 'Discard role' })).toHaveCount(0);

    const draft = await fx.role('draft-hm', { status: 'Draft', hm: 'Alex' });
    await openRole(page, 'hr', draft);
    await expect(page.getByRole('button', { name: 'Discard role' })).toBeVisible();
    await openRole(page, 'hm_alex', draft);
    await expect(page.getByRole('button', { name: 'Discard role' })).toHaveCount(0);
    const res = await authed(page.request, await getToken(page.request, 'hm_alex')).delete(`/api/roles/${draft.id}`);
    expect(res.status()).toBe(403);
    expect(await roleRow(draft.id)).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('A Hiring Manager cannot approve a role — not even their own', () => {
  test('on their own Draft there is no Approve, no Change status and no way to choose Approved; the server refuses the request and the role stays a Draft', async ({ page }) => {
    const draft = await fx.role('hm-own-draft', { status: 'Draft', hm: 'Alex' });
    await openRole(page, 'hm_alex', draft);
    await expect(page.getByRole('button', { name: 'Approve Role' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
    await expect(statusDialog(page)).toHaveCount(0);
    // HR, on the same page, has the controls (so their absence above is not an empty page)
    await openRole(page, 'hr', draft);
    await expect(page.getByRole('button', { name: 'Approve Role' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change status' })).toBeVisible();

    for (const status of ['Approved', 'Live – Sourcing']) {
      const res = await authed(page.request, await getToken(page.request, 'hm_alex')).patch(`/api/roles/${draft.id}`, { status });
      expect(res.status(), `HM PATCH status ${status}`).toBe(403);
    }
    const row = await roleRow(draft.id);
    expect(row.status).toBe('Draft');
    expect(row.approver_name).toBeNull();
    const approvals = await db.query(`SELECT 1 FROM activity_log WHERE role_id = $1 AND event_type = 'Role Approved'`, [draft.id]);
    expect(approvals.rowCount).toBe(0);
  });

  test('TODAY: the page still offers a Hiring Manager the edit pencils, but every save is refused (403): an error toast, edit mode stays open, nothing changes', async ({ page }) => {
    const role = await fx.role('hm-pencil', { hm: 'Alex' });
    await openRole(page, 'hm_alex', role);
    const basic = sectionCard(page, 'Basic Info');
    await basic.getByRole('button', { name: 'Edit Basic Info' }).click();
    await basic.locator('label:text-is("Location") + select').selectOption('Bangalore');
    const patches: number[] = [];
    page.on('response', r => { if (r.request().method() === 'PATCH' && r.url().endsWith(`/roles/${role.id}`)) patches.push(r.status()); });
    await basic.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Failed to update Basic Info')).toBeVisible();
    await expect(basic.getByRole('button', { name: 'Save' })).toBeVisible();                                                              // still editing
    expect(patches).toEqual([403]);
    expect((await roleRow(role.id)).location).toBe('Gurgaon');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('JD source: a manually provided long-form JD', () => {
  const JD_LINK = 'https://example.com/e2e-manual-jd.pdf';

  test('jd_source = manual: the JD link is shown, Regenerate JD is gone and a note says the JD was provided by hand; the server refuses a regeneration too', async ({ page }) => {
    const role = await fx.role('manual-jd', { status: 'Approved', jdSource: 'manual', jdDriveLink: JD_LINK });
    await openRole(page, 'hr', role);
    const links = sectionCard(page, 'Links & Assets');
    await expect(links.getByRole('link', { name: JD_LINK })).toHaveAttribute('href', JD_LINK);
    await expect(page.getByText(/Long-form JD manually provided/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toHaveCount(0);

    const res = await authed(page.request, await getToken(page.request, 'hr')).post(`/api/roles/${role.id}/regenerate-jd`, {});
    expect(res.status()).toBe(400);
    expect((await roleRow(role.id)).jd_drive_link, 'the manual JD link must survive').toBe(JD_LINK);
  });

  test('a generated JD on an Approved role has Regenerate JD and no manual-JD note; the page then shows what the server reported', async ({ page }) => {
    const role = await fx.role('generated-jd', { status: 'Approved', jdSource: 'generated', jdDriveLink: JD_LINK });
    await openRole(page, 'hr', role);
    await expect(page.getByText(/Long-form JD manually provided/)).toHaveCount(0);
    const answer = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/roles/${role.id}/regenerate-jd`));
    await page.getByRole('button', { name: 'Regenerate JD' }).click();
    const jd = (await (await answer).json()).jdGeneration as { generated: boolean; error?: string };
    // Without an Anthropic key and a Drive folder (the isolated stack) generation cannot succeed and the page must say so, with the server's reason;
    // on a configured backend it succeeds and says that. Either way the toast is the server's answer, never a guess.
    if (jd.generated) await expect(page.getByText('Long-form and social JDs regenerated')).toBeVisible();
    else {
      expect(jd.error).toBeTruthy();
      await expect(page.getByText(`JD regeneration failed: ${jd.error}`)).toBeVisible();
      expect((await roleRow(role.id)).jd_drive_link, 'a failed regeneration leaves the old link').toBe(JD_LINK);
    }
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toBeEnabled();
  });

  test('Regenerate JD is only for an Approved role with a JD, and only for HR-tier', async ({ page }) => {
    const noJd = await fx.role('approved-no-jd', { status: 'Approved' });
    await openRole(page, 'hr', noJd);
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toHaveCount(0);                                                    // nothing generated yet: the page waits for it
    const moved = await fx.role('moved-on', { status: 'Live – Sourcing', jdDriveLink: JD_LINK });
    await openRole(page, 'hr', moved);
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toHaveCount(0);                                                    // once the role moves on it cannot be regenerated
    const hm = await fx.role('approved-hm', { status: 'Approved', hm: 'Alex', jdDriveLink: JD_LINK });
    await openRole(page, 'hr', hm);
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toBeVisible();
    await openRole(page, 'hm_alex', hm);
    await expect(page.getByRole('button', { name: 'Regenerate JD' })).toHaveCount(0);
    expect((await authed(page.request, await getToken(page.request, 'hm_alex')).post(`/api/roles/${hm.id}/regenerate-jd`, {})).status()).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Portfolio review card, by state', () => {
  let flagged: CreatedRole;
  let done: CreatedApp, unrev: CreatedApp, failedKept: CreatedApp, notQueued: CreatedApp;

  // What the worker writes into portfolio_analyses for a work-sample (marketing_work) review; only what the card reads.
  const analysis = (extra: object = {}) => ({
    version: 1, kind: 'marketing_work', analyzedAt: pastIso(2), model: 'claude-sonnet-4-5',
    portfolios: [], criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
    modelScore: 7, checklistScore: 7, score: 7, scoreNote: '', confidence: 'medium',
    highlights: [], redFlags: [], summary: '', ...extra,
  });

  test.beforeAll(async () => {
    flagged = await fx.role('portfolio', { hm: 'Alex', portfolio: { kind: 'marketing_work' } });
    done = await fx.app(await fx.candidate('card-completed'), flagged, { score: 7, portfolio: { score: 7, status: 'completed' } });
    await fx.putAnalysis(done.id, analysis({ highlights: ['SEEDED STRENGTH launch film for a utility'], redFlags: ['SEEDED CONCERN thin on outcomes'], summary: 'SEEDED SUMMARY of the reviewed work.' }));
    unrev = await fx.app(await fx.candidate('card-unreviewable'), flagged, {
      score: 7, portfolio: { score: null, status: 'unreviewable', error: 'SEEDED REASON the links are on platforms that cannot be opened. Use Re-run to retry.' },
    });
    failedKept = await fx.app(await fx.candidate('card-failed-kept'), flagged, {
      score: 7, portfolio: { score: 7, status: 'failed', error: 'SEEDED NOTE the reviewer was busy — the earlier review (7/10) still applies. Use Re-run to retry.' },
    });
    await fx.putAnalysis(failedKept.id, analysis({ summary: 'SEEDED EARLIER REVIEW kept after a failed re-run.' }));
    notQueued = await fx.app(await fx.candidate('card-not-queued'), flagged, {
      score: 7, portfolio: { score: null, status: 'pending', error: 'Could not be queued (no queue here). Use Re-run to retry.' },
    });
  });

  const cardOf = (page: Page, app: CreatedApp) =>
    tableRowOf(page, app.candidateName).locator('xpath=following-sibling::tr[2]').getByTestId('portfolio-card-frame');
  async function expandCard(page: Page, app: CreatedApp) {
    await tableRowOf(page, app.candidateName).locator('xpath=following-sibling::tr[1]').getByRole('button', { name: 'View Highlights and Summary' }).click();
    await expect(cardOf(page, app)).toBeVisible();
  }
  /** The way HR gets here: the role page's Scorecard Summary button, which opens My Tasks scoped to this role. */
  async function openScorecard(page: Page, who: 'hr' | 'hm_alex', role: CreatedRole) {
    await openRole(page, who, role);
    await page.getByRole('link', { name: 'Scorecard Summary' }).click();
    await expect(page).toHaveURL(new RegExp(`/my-tasks\\?role_id=${role.id}$`));
    await expect(tableRowOf(page, done.candidateName)).toBeVisible();
  }

  test('the table\'s Portfolio column and the card of each state: completed, not scored (unreviewable), failed with an earlier score, and not queued', async ({ page }) => {
    const errors = expectNoPageErrors(page);
    await openScorecard(page, 'hr', flagged);
    await expect(page.getByRole('columnheader', { name: 'Portfolio' })).toBeVisible();

    // the column says something in every state (a score, a dash, a score with a red dot, a "!")
    await expect(tableRowOf(page, done.candidateName).getByText('7', { exact: true }).first()).toBeVisible();
    await expect(tableRowOf(page, unrev.candidateName).getByText('—').first()).toBeVisible();
    await expect(tableRowOf(page, failedKept.candidateName).locator('[role="img"][aria-label]')).toHaveCount(1);                                            // the red dot of a failed re-run
    await expect(tableRowOf(page, done.candidateName).locator('[role="img"][aria-label]')).toHaveCount(0);
    await expect(tableRowOf(page, notQueued.candidateName).getByText('!', { exact: true })).toBeVisible();

    // completed: the score in the header, the reviewer's own words, a way to run it again
    await expandCard(page, done);
    const completed = cardOf(page, done);
    await expect(completed.getByText('Portfolio review')).toBeVisible();
    await expect(completed.getByText('7/10', { exact: true })).toBeVisible();
    await expect(completed).toContainText('SEEDED SUMMARY of the reviewed work.');
    await expect(completed).toContainText('SEEDED STRENGTH launch film for a utility');
    await expect(completed).toContainText('SEEDED CONCERN thin on outcomes');
    await expect(completed.getByRole('button', { name: 'Re-run' })).toBeVisible();

    // unreviewable: no score, said so, with the reason the system stored and what that does to the average
    await expandCard(page, unrev);
    const notScored = cardOf(page, unrev);
    await expect(notScored.getByText('Not scored')).toBeVisible();
    await expect(notScored).toContainText('SEEDED REASON the links are on platforms that cannot be opened.');
    expect((await notScored.innerText()).match(/Use Re-run to retry/g), 'the retry hint is said once, not twice').toHaveLength(1);
    await expect(notScored.getByText('/10')).toHaveCount(0);
    await expect(notScored.getByRole('button', { name: 'Re-run' })).toBeVisible();

    // failed after an earlier good review: the failure is stated, the earlier score is kept and shown
    await expandCard(page, failedKept);
    const failed = cardOf(page, failedKept);
    await expect(failed).toContainText('The work-sample review could not be completed.');
    await expect(failed).toContainText('SEEDED NOTE the reviewer was busy');
    await expect(failed.getByText('7/10', { exact: true })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Re-run' })).toBeVisible();

    // pending but never queued: not a spinner that waits for nothing
    await expandCard(page, notQueued);
    const nq = cardOf(page, notQueued);
    await expect(nq.getByText('Not queued')).toBeVisible();
    await expect(nq.getByRole('button', { name: 'Re-run' })).toBeVisible();
    errors.check();
  });

  test('Re-run on a not-scored review with no work samples in the answer settles it on the spot: a toast, a refreshed card, nothing queued', async ({ page }) => {
    const app = await fx.app(await fx.candidate('card-rerun-fresh'), flagged, { score: 7, portfolio: { score: null, status: 'unreviewable', error: 'SEEDED OLD REASON. Use Re-run to retry.' } });
    await openScorecard(page, 'hr', flagged);
    await expandCard(page, app);
    const posts = recordRequests(page, r => r.method === 'POST' && r.url.endsWith(`/applications/${app.id}/portfolio-analysis`));
    await cardOf(page, app).getByRole('button', { name: 'Re-run' }).click();
    await expect(page.getByText('No work samples to review in the application answer — not scored')).toBeVisible();
    expect(posts).toHaveLength(1);
    await expect(cardOf(page, app)).not.toContainText('SEEDED OLD REASON');                                                              // the card re-read the review
    await expect(cardOf(page, app).getByText('Not scored')).toBeVisible();
    const row = (await db.query(`SELECT portfolio_analysis_status AS status, score_portfolio AS score FROM applications WHERE id = $1`, [app.id])).rows[0];
    expect(row).toEqual({ status: 'no_portfolio', score: null });
  });

  test('Re-run when nothing new can be found keeps the earlier score: the toast says the earlier review still applies and the score stays', async ({ page }) => {
    const app = await fx.app(await fx.candidate('card-rerun-kept'), flagged, { score: 7, portfolio: { score: 7, status: 'completed' } });
    await fx.putAnalysis(app.id, analysis({ summary: 'SEEDED KEPT REVIEW.' }));
    await openScorecard(page, 'hr', flagged);
    await expandCard(page, app);
    await cardOf(page, app).getByRole('button', { name: 'Re-run' }).click();
    await expect(page.getByText('No new work found — the earlier review still applies')).toBeVisible();
    await expect(cardOf(page, app).getByText('7/10', { exact: true })).toBeVisible();
    const row = (await db.query(`SELECT portfolio_analysis_status AS status, score_portfolio AS score FROM applications WHERE id = $1`, [app.id])).rows[0];
    expect(row).toEqual({ status: 'failed', score: 7 });
    const kept = await db.query(`SELECT analysis->>'summary' AS summary FROM portfolio_analyses WHERE application_id = $1`, [app.id]);
    expect(kept.rows[0].summary, 'the stored earlier review must survive').toBe('SEEDED KEPT REVIEW.');
  });

  test('a Hiring Manager sees the same card but has no Re-run (HR only), and the server refuses their request', async ({ page }) => {
    await openScorecard(page, 'hm_alex', flagged);
    await expandCard(page, done);
    await expect(cardOf(page, done)).toContainText('SEEDED SUMMARY of the reviewed work.');
    await expect(cardOf(page, done).getByRole('button', { name: 'Re-run' })).toHaveCount(0);
    const res = await authed(page.request, await getToken(page.request, 'hm_alex')).post(`/api/applications/${done.id}/portfolio-analysis`, {});
    expect(res.status()).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Compensation: HR versus a Hiring Manager', () => {
  let spm: CreatedRole;

  test.beforeAll(async () => {
    // the title of a role the seed benchmarked (BEN003, 5-8 years, 18-25 LPA): internal data answers without any model
    spm = await fx.role('spm', { title: 'Senior Product Manager', hm: 'Alex', ctcBand: '18-25 LPA' });
    await db.query(`UPDATE roles SET yoe_required = '5-8 years' WHERE id = $1`, [spm.id]);
  });

  test('HR sees the CTC band and the benchmarking panel; Run benchmark shows the internal range for this role', async ({ page }) => {
    await openRole(page, 'hr', spm);
    await expect(sectionCard(page, 'Requirements')).toContainText('CTC Band');
    await expect(sectionCard(page, 'Requirements')).toContainText('18-25 LPA');
    const panel = sectionCard(page, 'Internal Compensation Benchmarking');
    await expect(panel).toBeVisible();
    const answer = page.waitForResponse(r => r.url().endsWith(`/roles/${spm.id}/comp-benchmark`));
    await panel.getByRole('button', { name: 'Run benchmark' }).click();
    const benchmark = (await (await answer).json()).benchmark as { source: string; range_min: number; range_max: number; currency: string; benchmark_id?: string };
    expect(benchmark).toMatchObject({ source: 'internal_data', range_min: 18, range_max: 25, currency: 'LPA' });
    await expect(panel.getByText('18–25 LPA')).toBeVisible();
    await expect(panel).toContainText(benchmark.benchmark_id!);                                                                           // the record it was grounded in
  });

  test('the named Hiring Manager gets neither the panel nor the CTC band on the page, although the server gives them the band of their own role; another Hiring Manager gets no band from the server', async ({ page }) => {
    await openRole(page, 'hm_alex', spm);
    await expect(sectionCard(page, 'Requirements')).toBeVisible();
    await expect(sectionCard(page, 'Requirements')).not.toContainText('CTC Band');
    await expect(page.getByRole('heading', { name: 'Internal Compensation Benchmarking' })).toHaveCount(0);
    await expect(page.getByText('18-25 LPA')).toHaveCount(0);

    const get = async (who: 'hm_alex' | 'hm_satyadev', path: string) => authed(page.request, await getToken(page.request, who)).get(path);
    expect((await (await get('hm_alex', `/api/roles/${spm.id}`)).json()).role.ctc_band, 'the named Hiring Manager\'s API answer carries the band').toBe('18-25 LPA');
    expect((await (await get('hm_satyadev', `/api/roles/${spm.id}`)).json()).role, 'another Hiring Manager\'s does not').not.toHaveProperty('ctc_band');
    expect((await get('hm_alex', `/api/roles/${spm.id}/comp-benchmark`)).status()).toBe(403);
    expect((await get('hm_satyadev', `/api/roles/${spm.id}/comp-benchmark`)).status()).toBe(403);

    await openRole(page, 'hm_satyadev', spm);
    await expect(page.getByText('18-25 LPA')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Internal Compensation Benchmarking' })).toHaveCount(0);
  });

  test('@live a role with no internal benchmark gets an AI estimate, labelled as one', async ({ page }) => {
    // needs a real Anthropic key on the backend: with none, the route answers 500 and the panel says "Benchmarking failed"
    const role = await fx.role('unbenchmarked', { title: `E2E Unbenchmarked Role ${RUN}`, hm: 'Alex' });
    await db.query(`UPDATE roles SET yoe_required = '3-5 years', must_have_skills = 'Node.js' WHERE id = $1`, [role.id]);
    await openRole(page, 'hr', role);
    const panel = sectionCard(page, 'Internal Compensation Benchmarking');
    const answer = page.waitForResponse(r => r.url().endsWith(`/roles/${role.id}/comp-benchmark`));
    await panel.getByRole('button', { name: 'Run benchmark' }).click();
    const res = await answer;
    expect(res.status()).toBe(200);
    expect((await res.json()).benchmark.source).toBe('ai_estimate');
    await expect(panel.getByText(/Source: AI estimate/i)).toBeVisible();
  });
});
