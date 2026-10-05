import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS } from '../helpers/api';

async function loginViaApi(page: Page, user: keyof typeof USERS = 'hr') {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: USERS[user].email, password: 'password123' },
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

test('Dashboard loads without errors', async ({ page }) => {
  await loginViaApi(page);
  // No console errors should crash the page
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForTimeout(2000);
  // Filter out known browser extension noise
  const realErrors = errors.filter(e => !e.includes('FrameDoesNotExistError') && !e.includes('extension'));
  expect(realErrors).toHaveLength(0);
});

test('Dashboard shows role count metric', async ({ page }) => {
  test.setTimeout(75_000);                 // room for the 45s wait below (the Playwright default is 30s)
  await loginViaApi(page);
  // At least one numeric metric should be visible. Poll instead of a fixed 3s wait: the
  // first dashboard load after >3 minutes idle runs the whole SLA sweep before it answers
  // (compute-on-read), which takes 25-30s against this suite's large local dataset.
  await expect(page.locator('body')).toHaveText(/\d+/, { timeout: 45000 });
});

// ─── Hiring Funnel Snapshot — interactive chevron/rail/tile regressions ──────
// Covers three UI behaviors that no API test can see: they're pure
// client-side rendering/interaction, not data shape. All three were explicit
// user-reported fixes (see HiringFunnelSnapshot.tsx's own comments), so a
// silent regression here would ship straight past the API suite.
test.describe('Hiring Funnel Snapshot', () => {

  test('every stage chevron is colored by default; selecting one greys out every other stage', async ({ page }) => {
    await loginViaApi(page);
    // 'Resume Review' was retired as a stage (STAGE_ORDER now has 11 stages,
    // not 13) — 'Interview Round 1' is the next real chevron after 'Applied
    // and Screened' (the entry stage, renamed from plain 'Applied'). The
    // button's title attribute is the raw stage key (HiringFunnelSnapshot.tsx's
    // title={s.stage}), not the short "Applied" label shown inside the
    // chevron for space reasons — so the locator must match the full name.
    const applied = page.locator('button[title="Applied and Screened"]');
    const interview1 = page.locator('button[title="Interview Round 1"]');
    await expect(applied).toBeVisible({ timeout: 15000 });
    await expect(interview1).toBeVisible();

    const bgBefore = {
      applied: await applied.evaluate(el => (el as HTMLElement).style.background),
      interview1: await interview1.evaluate(el => (el as HTMLElement).style.background),
    };
    // Distinct stages must not already share an identical background before
    // any selection — each is lit in its own STAGE_COLORS hue by default.
    expect(bgBefore.applied).not.toBe(bgBefore.interview1);

    await applied.click();
    await page.waitForTimeout(300); // style transition/re-render settle

    const bgAfter = {
      applied: await applied.evaluate(el => (el as HTMLElement).style.background),
      interview1: await interview1.evaluate(el => (el as HTMLElement).style.background),
    };
    // The selected stage's own hue changes (brightened) but must still
    // differ from the now-shared grey the rest collapse to.
    expect(bgAfter.applied).not.toBe(bgBefore.applied);
    expect(bgAfter.interview1).not.toBe(bgBefore.interview1);
    expect(bgAfter.applied).not.toBe(bgAfter.interview1);

    // Every OTHER stage must now share one identical (grey/UNLIT_BG) fill —
    // not just Interview Round 1 — confirming "grey out every other stage",
    // not just the one checked above. 'Shortlisted' was retired along with
    // 'Resume Review' — see STAGE_ORDER — so it's dropped from this list.
    const otherTitles = ['Interview Round 2', 'Founders Round', 'Joined'];
    const otherBgs = await Promise.all(
      otherTitles.map(t => page.locator(`button[title="${t}"]`).evaluate(el => (el as HTMLElement).style.background))
    );
    for (const bg of otherBgs) expect(bg).toBe(bgAfter.interview1);
  });

  // The local per-section Role filter (and its rail) was retired —
  // HiringFunnelSnapshot.tsx now relies solely on the Dashboard's own master
  // filters, matching every other section on the page instead of carrying an
  // independent one. This used to be a "no CSS truncation on long role
  // names" check on that rail; now it's a regression guard that the rail
  // (and its "Filter this section by role" trigger text) doesn't reappear.
  test('the funnel snapshot no longer renders its own local role-filter rail', async ({ page }) => {
    await loginViaApi(page);
    await expect(page.locator('button[title="Applied and Screened"]')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('text=Filter this section by role')).toHaveCount(0);
    await expect(page.locator('div.max-h-80.overflow-y-auto button')).toHaveCount(0);
  });

  // "SLA breaches by role" — a stacked bar per open role, under the funnel snapshot.
  // The data is the live local dataset (breaches come and go as the engine runs), so
  // what is asserted is structure and agreement with the API, not particular roles.
  test.describe('SLA breaches by role chart', () => {
    const escapeRe = (t: string) => t.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&');

    async function apiPayload(page: Page) {
      const { token } = await (await page.request.post(`${BASE}/api/auth/login`, {
        data: { email: USERS.hr.email, password: 'password123' },
      })).json();
      return (await page.request.get(`${BASE}/api/dashboard/sla-by-role`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<{
        roles: { role_id: string; role_title: string; total: number }[]; total_breaches: number;
      }>;
    }

    test('is rendered under the funnel snapshot, with one bar per role (top 8) matching the API', async ({ page }) => {
      await loginViaApi(page);
      const heading = page.getByRole('heading', { name: 'SLA breaches by role' });
      await expect(heading).toBeVisible({ timeout: 20000 });

      // below the funnel snapshot, not above it
      const funnelY = (await page.locator('button[title="Applied and Screened"]').boundingBox())!.y;
      expect((await heading.boundingBox())!.y).toBeGreaterThan(funnelY);

      const api = await apiPayload(page);
      if (api.roles.length === 0) {
        await expect(page.getByText('No SLA breaches on open roles')).toBeVisible();
        return;
      }
      const bars = page.getByRole('button', { name: /open SLA breaches/ });
      await expect(bars).toHaveCount(Math.min(api.roles.length, 8));
      // the busiest role is first, and its label carries the API's own count
      await expect(bars.first()).toHaveAttribute('aria-label', new RegExp(`^${escapeRe(api.roles[0].role_title)}: ${api.roles[0].total} open SLA breaches`));
    });

    test('clicking a bar opens the stage-by-stage breakdown, and clicking again closes it', async ({ page }) => {
      await loginViaApi(page);
      await expect(page.getByRole('heading', { name: 'SLA breaches by role' })).toBeVisible({ timeout: 20000 });
      const bars = page.getByRole('button', { name: /open SLA breaches/ });
      test.skip((await bars.count()) === 0, 'No open-role SLA breaches right now — nothing to drill into.');

      const first = bars.first();
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('region', { name: /breaches by stage$/ })).toBeVisible();
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('region', { name: /breaches by stage$/ })).toHaveCount(0);
    });

    test('the table view lists every role with a breach, with the same total as the API', async ({ page }) => {
      await loginViaApi(page);
      await expect(page.getByRole('heading', { name: 'SLA breaches by role' })).toBeVisible({ timeout: 20000 });
      const api = await apiPayload(page);
      test.skip(api.roles.length === 0, 'No open-role SLA breaches right now.');

      await page.getByRole('button', { name: 'Table', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
      // not limited to the top 8, and in the API's order: row i is role i (titles are not unique), ending in its total
      const rows = page.getByRole('table', { name: /Open SLA breaches per open role/ }).locator('tbody tr');   // not the dashboard's other tables
      await expect(rows).toHaveCount(api.roles.length);
      for (const [i, r] of api.roles.slice(0, 12).entries()) {
        await expect(rows.nth(i)).toContainText(r.role_title);
        await expect(rows.nth(i).getByRole('cell').last()).toHaveText(r.total.toLocaleString('en-IN'));
      }
    });
  });

  test('clicking a candidate breach tile navigates to that candidate\'s detail page', async ({ page }) => {
    // Prime with ground truth from the API first — the breach data changes
    // over time as the SLA engine runs, so don't hardcode a stage/type name;
    // find whichever real, resolved candidate_id exists right now.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: USERS.hr.email, password: 'password123' },
    });
    const { token } = await loginRes.json();
    const dashRes = await page.request.get(`${BASE}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    const { hiring_funnel_snapshot } = await dashRes.json();

    let target: { stage: string; type: string; candidateId: string; candidateName: string } | null = null;
    outer: for (const s of hiring_funnel_snapshot) {
      for (const bt of s.breach_types) {
        const withId = bt.candidates.find((c: { candidate_id: string | null }) => c.candidate_id);
        if (withId) { target = { stage: s.stage, type: bt.type, candidateId: withId.candidate_id, candidateName: withId.candidate_name }; break outer; }
      }
    }
    test.skip(!target, 'No SLA breach with a resolvable candidate_id exists right now — nothing to click through.');
    if (!target) return;

    await loginViaApi(page);
    await page.locator(`button[title="${target.stage}"]`).click();
    await page.locator('button', { hasText: target.type }).click();

    const card = page.locator(`a[href="/candidates/${target.candidateId}"]`).first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await page.waitForURL(new RegExp(`/candidates/${target.candidateId}`), { timeout: 10000 });
    expect(page.url()).toContain(`/candidates/${target.candidateId}`);
  });
});
