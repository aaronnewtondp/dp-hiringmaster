// Sourcing module — what only a browser can see: where the dashboard sections sit, who gets the My Tasks box, the Dashboard "Sourcing plans"
// workspace (role switcher, the plan panel, its dialogs), the weekly-tracker states (running / cut short / stopped while the role is on hold) and
// the read-only Hiring Manager view. Skips itself while the module is off (SOURCING_ENABLED on the backend).
// It creates TWO throwaway roles with an active plan: the first is only looked at and opened (its dialogs are never saved); the second ("flow" role)
// is the one the tests change — log a post, close and reopen a channel, put the role On Hold and back. Both are removed afterwards.
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { BASE, FRONTEND_BASE, USERS, uid, CRON_SECRET } from '../helpers/api';
import { purgeRolesFast } from '../helpers/sourcing-db';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

async function loginViaApi(page: Page, user: keyof typeof USERS, path: string) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email: USERS[user].email, password: USERS[user].password } });
  const { token, user: userBody } = await res.json();
  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, userBody }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(userBody));
    sessionStorage.clear();
  }, { token, userBody });
  await page.goto(`${FRONTEND_BASE}${path}`);
}

test.describe('Sourcing module (browser)', () => {
  test.setTimeout(90_000);                      // the first dashboard load after idle runs the whole SLA sweep (compute-on-read)

  let db: Client;
  let enabled = false;
  let roleId = '', roleTitle = '', draftId = '', draftTitle = '';
  let flowId = '', flowPlanId = '';
  const FLOW_EMAIL = `e2e-flow+${uid()}@example.com`;
  const hrToken = async (request: APIRequestContext) => (await (await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email, password: USERS.hr.password } })).json()).token as string;

  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS.hr.email, password: USERS.hr.password } });
    const { token } = await login.json();
    const h = { Authorization: `Bearer ${token}` };
    const s = await request.get(`${BASE}/api/sourcing/status`, { headers: h });
    enabled = s.ok() && (await s.json()).enabled === true;
    if (!enabled) return;
    db = new Client({ connectionString: LOCAL_DB_URL });
    await db.connect();
    const mk = async (title: string, priority: string) => (await db.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, approval_date, recruitment_mode)
       VALUES ($1,'Tech/Devs','Alex',$2,'Live – Sourcing','Gurgaon','Full-Time / Permanent', CURRENT_DATE - 3, CURRENT_DATE - 3, ARRAY['LinkedIn','Agency']) RETURNING id`,
      [title, priority])).rows[0].id as string;
    roleTitle = `E2E Workspace Role ${uid()}`; draftTitle = `E2E Draft Role ${uid()}`;
    roleId = await mk(roleTitle, 'P1'); draftId = await mk(draftTitle, 'P1');
    const plan = await (await request.get(`${BASE}/api/sourcing/plans/${roleId}`, { headers: h })).json();     // seeds the draft plans
    await request.get(`${BASE}/api/sourcing/plans/${draftId}`, { headers: h });
    const act = await request.post(`${BASE}/api/sourcing/plans/${plan.plan.id}/activate`, { headers: h, data: {
      weekly_qualified_target: 4,
      channels: [{ channel: 'LinkedIn', already_running: true, url: 'https://example.com/e2e-post', weekly_target: 10 }, { channel: 'Agency' }],
    } });
    expect(act.ok()).toBe(true);

    // The role the tests change. LinkedIn: not live yet (its first task is open). Naukri/IIMjobs: live with a target. Direct Outreach: live but with no target
    // and its first task still open — what the first version of the tracker left behind. Agency: its first task is overdue, so there is a problem to resolve.
    flowId = await mk(`E2E Flow Role ${uid()}`, 'P1');
    flowPlanId = (await (await request.get(`${BASE}/api/sourcing/plans/${flowId}`, { headers: h })).json()).plan.id;
    const act2 = await request.post(`${BASE}/api/sourcing/plans/${flowPlanId}/activate`, { headers: h, data: {
      channels: [{ channel: 'LinkedIn' }, { channel: 'Naukri/IIMjobs', already_running: true, url: 'https://example.com/e2e-flow-naukri', weekly_target: 6 }, { channel: 'Direct Outreach' }, { channel: 'Agency' }],
    } });
    expect(act2.ok()).toBe(true);
    await db.query(`UPDATE sourcing_plan_channels SET state = 'active' WHERE plan_id = $1::bigint AND channel = 'Direct Outreach'`, [flowPlanId]);
    await db.query(
      `UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE kind = 'activate_channel' AND plan_channel_id IN
         (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = 'Agency')`, [flowPlanId]);
    const cron = await request.post(`${BASE}/api/cron/sourcing-check`, { headers: { Authorization: `Bearer ${CRON_SECRET}` }, data: {} });
    expect(cron.ok()).toBe(true);                                                                           // raises the Agency problem
  });

  test.afterAll(async () => {
    if (!db) return;
    // one transaction, no per-row foreign-key scans of the big pending_actions table (helpers/sourcing-db.ts); also removes the flow test's candidate
    await purgeRolesFast(db, [roleId, draftId, flowId].filter(Boolean), [`${FLOW_EMAIL.split('+')[0]}+%@example.com`]);
    await db.end();
  });

  test.beforeEach(() => { test.skip(!enabled, 'SOURCING_ENABLED is not true on the backend'); });

  test('the dashboard ends with Sourcing execution and then Sourcing plans, below Operational velocity', async ({ page }) => {
    await loginViaApi(page, 'hr', '/dashboard');
    const execution = page.getByRole('heading', { name: 'Sourcing execution' });
    const plans = page.getByRole('heading', { name: 'Sourcing plans' });
    await expect(plans).toBeVisible({ timeout: 60_000 });
    const velocity = page.getByRole('heading', { name: 'Operational velocity' });
    await expect(velocity).toBeVisible();
    const [e, p, v] = [await execution.boundingBox(), await plans.boundingBox(), await velocity.boundingBox()];
    expect(e!.y).toBeGreaterThan(v!.y);
    expect(p!.y).toBeGreaterThan(e!.y);
    expect(await page.locator('h2').last().textContent()).toBe('Sourcing plans');
  });

  test('a recruiter gets a Sourcing box on My Tasks; opening it shows the queue (or its good empty state)', async ({ page }) => {
    await loginViaApi(page, 'hr', '/my-tasks');
    const box = page.getByRole('button', { name: /^Sourcing/ });
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.click();
    await expect(page.getByTestId('sourcing-targets').or(page.getByText('Nothing needs your attention ✓'))).toBeVisible({ timeout: 30_000 });
    // every role with a plan is measured against its OWN weekly qualified target (these roles are P1, so they always have one)
    await expect(page.getByTestId('sourcing-targets')).toHaveText(/This week: \d+ of \d+ roles? at their own weekly qualified target/);
  });

  test('Leadership gets no Sourcing box (their box stays alerts-only)', async ({ page }) => {
    await loginViaApi(page, 'leadership', '/my-tasks');
    await expect(page.getByRole('button', { name: /Leadership Alerts|Other Pending Actions/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Sourcing/ })).toHaveCount(0);
  });

  test('the role page no longer carries the plan: just a chip that opens it on the Dashboard, and a read-only Recruitment Mode', async ({ page }) => {
    await loginViaApi(page, 'hr', `/roles/${roleId}`);
    await expect(page.getByRole('heading', { name: roleTitle })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#sourcing')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sourcing', exact: true })).toHaveCount(0);
    await expect(page.getByText('Recruitment Mode (managed in the Sourcing plan)')).toBeVisible();
    const chip = page.getByTestId('sourcing-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('href', new RegExp(`/dashboard\\?sourcing_role=${roleId}#sourcing-workspace$`));
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?sourcing_role=${roleId}`));
    const panel = page.getByTestId('sourcing-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByRole('link', { name: roleTitle })).toBeVisible();
  });

  test('Sourcing plans: pick a role, see its tracker and target, open the dialogs, and find the plan waiting to be activated', async ({ page }) => {
    await loginViaApi(page, 'hr', `/dashboard?sourcing_role=${roleId}#sourcing-workspace`);
    const ws = page.getByTestId('sourcing-workspace');
    await expect(ws).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`role-pill-${roleId}`)).toHaveAttribute('aria-pressed', 'true');
    const panel = page.getByTestId('sourcing-panel');
    await expect(panel.getByTestId('volume')).toContainText('/ 4 qualified in the last 7 days');
    await expect(panel.getByTestId('target-source')).toHaveText('Target set for this role');
    const li = panel.getByTestId('channel-LinkedIn');
    await expect(li).toContainText('Weekly sourcing target: 10');
    await expect(li.getByTestId('tracker-running')).toBeVisible();
    await expect(li.getByRole('button', { name: 'Close LinkedIn' })).toBeVisible();                          // the button reads "Close channel"; its accessible name carries the channel
    await expect(panel.getByTestId('plan-timeline')).toBeVisible();
    await expect(panel.getByTestId('timeline-entry').first()).toBeVisible();

    // the dialogs open and close with Escape, and never save here
    await li.getByRole('button', { name: 'Close LinkedIn' }).click();
    const close = page.getByRole('dialog');
    await expect(close.getByRole('heading', { name: 'Close LinkedIn' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(close).toHaveCount(0);
    await panel.getByRole('button', { name: 'Edit plan' }).click();
    await expect(page.getByRole('dialog').getByLabel('Weekly qualified target')).toHaveValue('4');
    await page.keyboard.press('Escape');

    // switching: the draft plan is listed under "waiting to be activated" and opens with an Activate button and the new fields
    // (the Dashboard's sourcing summary also words this in a sentence, so name the switcher's own <summary>)
    await page.locator('summary').filter({ hasText: /plans? waiting to be activated/ }).click();
    await page.getByTestId(`role-pill-${draftId}`).click();
    await expect(page).toHaveURL(new RegExp(`sourcing_role=${draftId}`));
    await expect(page.getByTestId('sourcing-panel').getByRole('link', { name: draftTitle })).toBeVisible();
    await page.getByRole('button', { name: 'Activate plan' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Activate sourcing plan' })).toBeVisible();
    await expect(dialog.getByLabel('Weekly qualified target for this role')).toBeVisible();
    await expect(dialog.getByLabel('Sourcing owner')).toHaveCount(0);                      // sourcing belongs to HR as a whole: nothing to pick
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the role\'s Hiring Manager sees a View-only plan with no actions, no history and no recommended steps', async ({ page }) => {
    await loginViaApi(page, 'hm_alex', `/dashboard?sourcing_role=${roleId}#sourcing-workspace`);
    const panel = page.getByTestId('sourcing-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText('View only')).toBeVisible();
    await expect(panel.getByTestId('channel-LinkedIn')).toContainText('Weekly sourcing target: 10');          // the numbers are visible…
    await expect(panel.getByRole('link', { name: /View job post/ })).toHaveCount(0);                         // …the link is not
    // (the channel buttons' accessible names carry the channel — "Close LinkedIn", "Edit LinkedIn target and link" — so match on those, not on the visible text)
    await expect(panel.getByTestId('channel-LinkedIn')).toBeVisible();
    for (const name of [/Activate plan/, /Mark done/, /Resolve/, /Skip/, /^Close /, /^Reopen /, /^Bring back /, /Edit plan/, /^Edit .*target/, /Add channel/]) {
      await expect(panel.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(panel.getByTestId('plan-timeline')).toHaveCount(0);
    await expect(panel.getByTestId('advice-box')).toHaveCount(0);
  });

  test('a Hiring Manager of ANOTHER role gets nothing: no pill for it, no chip on the role page', async ({ page }) => {
    await loginViaApi(page, 'hm_satyadev', `/dashboard?sourcing_role=${roleId}#sourcing-workspace`);
    await expect(page.getByRole('heading', { name: 'Operational velocity' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`role-pill-${roleId}`)).toHaveCount(0);
    await page.goto(`${FRONTEND_BASE}/roles/${roleId}`);
    await expect(page.getByRole('heading', { name: roleTitle })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sourcing-chip')).toHaveCount(0);
  });

  // ── The flow role: tests that change something ───────────────────────────────────────────────────
  const flowUrl = () => `/dashboard?sourcing_role=${flowId}#sourcing-workspace`;
  const flowChannel = (page: Page, channel: string) => page.getByTestId('sourcing-panel').getByTestId(`channel-${channel}`);

  test('logging the first task of a tracked channel asks for the post link AND the weekly target, then says that weekly tracking is set up', async ({ page }) => {
    await loginViaApi(page, 'hr', flowUrl());
    const li = flowChannel(page, 'LinkedIn');
    await expect(li).toBeVisible({ timeout: 60_000 });
    await expect(li).toContainText('Log the LinkedIn post (link and weekly sourcing target)');
    await li.getByRole('button', { name: 'Mark done' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Log the LinkedIn post' })).toBeVisible();
    const save = dialog.getByRole('button', { name: 'Log post' });
    await expect(save).toBeDisabled();                                                                      // neither the link nor the target yet
    await dialog.getByLabel('Link to the job post').fill('https://example.com/e2e-flow-post');
    await expect(save).toBeDisabled();                                                                      // the target is still missing
    await dialog.getByLabel('Weekly sourcing target').fill('8');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Post logged — weekly tracking is set up')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(li).toContainText('Weekly sourcing target: 8', { timeout: 30_000 });
    await expect(li.getByTestId('tracker-running')).toBeVisible();
  });

  test('a week cut short today shows "Tracking restarts on …" until it is over, and a role On Hold shows the tracker as stopped', async ({ page, request }) => {
    const token = await hrToken(request);
    const h = { Authorization: `Bearer ${token}` };
    // one applicant who named Naukri/IIMjobs today, then Close + Reopen the channel the same day: the week in progress is kept as "cut short"
    // and counting starts again tomorrow (that day is already in the cut-short week)
    const cand = await db.query(`INSERT INTO candidates (full_name, email) VALUES ('E2E Flow Candidate', $1) RETURNING id`, [FLOW_EMAIL]);
    await db.query(
      `INSERT INTO applications (candidate_id, role_id, stage, status, application_date, sub_source) VALUES ($1, $2, 'Applied and Screened', 'Active', NOW(), 'Naukri/IIMjobs')`, [cand.rows[0].id, flowId]);
    expect((await request.post(`${BASE}/api/sourcing/plans/${flowPlanId}/channel/close`, { headers: h, data: { channel: 'Naukri/IIMjobs', reason: 'Closing for the e2e test' } })).ok()).toBe(true);
    expect((await request.post(`${BASE}/api/sourcing/plans/${flowPlanId}/channel/reopen`, { headers: h, data: { channel: 'Naukri/IIMjobs' } })).ok()).toBe(true);
    const setRole = async (status: string) => expect((await request.patch(`${BASE}/api/roles/${flowId}`, { headers: h, data: { status } })).ok()).toBe(true);
    try {
      await loginViaApi(page, 'hr', flowUrl());
      const nk = flowChannel(page, 'Naukri/IIMjobs');
      await expect(nk).toBeVisible({ timeout: 60_000 });
      await expect(nk.getByTestId('tracker-restarts')).toContainText('Tracking restarts on');
      await expect(nk.getByTestId('tracker-running')).toHaveCount(0);
      await expect(nk.getByTestId('tracker-week')).toHaveCount(1);
      await expect(nk.getByTestId('tracker-week')).toContainText('Cut short');
      await expect(nk.getByTestId('tracker-week')).toContainText('1 (0 qualified)');                        // the applicant is in the week that was cut short

      await setRole('On Hold');
      await page.reload();
      await expect(nk).toBeVisible({ timeout: 60_000 });
      await expect(nk.getByTestId('tracker-paused')).toContainText('stopped while the role is on hold');
      await expect(nk.getByTestId('tracker-running')).toHaveCount(0);
      await expect(nk.getByTestId('tracker-restarts')).toHaveCount(0);

      await setRole('Live – Sourcing');
      await page.reload();
      await expect(nk.getByTestId('tracker-restarts')).toBeVisible({ timeout: 60_000 });                    // back on the same day: the cut-short week still covers today
      await expect(nk.getByTestId('tracker-paused')).toHaveCount(0);
    } finally {
      await request.patch(`${BASE}/api/roles/${flowId}`, { headers: h, data: { status: 'Live – Sourcing' } });   // never leave the role on hold
    }
  });

  test('"Change the plan" on a channel problem is worded "Channel set-up overdue" and offers to CLOSE that channel for this role', async ({ page }) => {
    await loginViaApi(page, 'hr', flowUrl());
    const panel = page.getByTestId('sourcing-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    // the problem's own list item: the one with the Resolve button (the recommended steps inside it are list items too, and may name the channel)
    const problem = panel.getByRole('listitem').filter({ hasText: 'Channel set-up overdue' }).filter({ hasText: 'Agency' }).filter({ has: page.getByRole('button', { name: /^Resolve/ }) });
    await expect(problem).toHaveCount(1, { timeout: 30_000 });
    await expect(problem).not.toContainText('Channel not live');
    await problem.getByRole('button', { name: /^Resolve/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Resolve this exception' })).toBeVisible();
    await dialog.getByRole('radio', { name: /Change the plan/ }).click();
    await expect(dialog.getByLabel('Close Agency for this role')).toBeVisible();                           // it used to say "Stop using Agency"
    await expect(dialog.getByText(/Stop using/)).toHaveCount(0);
    await page.keyboard.press('Escape');                                                                    // never saved: nothing changes
    await expect(dialog).toHaveCount(0);
  });

  test('"Add the target and post link" opens the Log-the-post dialog while the first task is still open, and the target-and-link dialog once it is done', async ({ page }) => {
    await loginViaApi(page, 'hr', flowUrl());
    const dop = flowChannel(page, 'Direct Outreach');
    await expect(dop).toBeVisible({ timeout: 60_000 });
    await expect(dop.getByTestId('tracker-no-target')).toContainText('No weekly sourcing target is set for Direct Outreach yet');
    await dop.getByRole('button', { name: 'Add the target and post link' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Log the Direct Outreach post' })).toBeVisible();      // the first task is open: logging it is how the tracker starts
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // once that task is done (a channel that went live some other way) the same link opens the plain target-and-link dialog
    await db.query(
      `UPDATE sourcing_commitments SET status = 'done', last_done_at = NOW() WHERE kind = 'activate_channel' AND plan_channel_id IN
         (SELECT id FROM sourcing_plan_channels WHERE plan_id = $1::bigint AND channel = 'Direct Outreach')`, [flowPlanId]);
    await page.reload();
    await expect(dop.getByTestId('tracker-no-target')).toBeVisible({ timeout: 60_000 });
    await dop.getByRole('button', { name: 'Add the target and post link' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Direct Outreach: target and link' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
