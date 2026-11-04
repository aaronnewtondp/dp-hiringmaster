import { test, expect, Page } from '@playwright/test';
import { BASE, getToken } from '../helpers/api';
import { loginViaApi, expectNoPageErrors } from '../helpers/e2e';
import { Cleanup, seedSlaBreaches, escapeRe, Applicant } from '../helpers/e2e-candidates';

test('Dashboard loads without errors', async ({ page }) => {
  // The listener goes on BEFORE the first navigation: one added after the page has loaded never sees what the load threw.
  const watch = expectNoPageErrors(page);
  await loginViaApi(page);
  // Wait for the page to have really rendered its data, not for a clock: the heading, the funnel snapshot's first stage and the SLA chart.
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('button[title="Applied and Screened"]')).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('heading', { name: 'SLA breaches by role' })).toBeVisible({ timeout: 45000 });
  watch.check();
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
    // Wait for the re-render to land (the selected chevron's fill changes, and so does every other one's) by polling the computed style.
    await expect.poll(() => applied.evaluate(el => (el as HTMLElement).style.background)).not.toBe(bgBefore.applied);
    await expect.poll(() => interview1.evaluate(el => (el as HTMLElement).style.background)).not.toBe(bgBefore.interview1);

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
  // The breaches are this describe's OWN (seedSlaBreaches: three candidates parked 50 h at Applied and Screened on a role of its own, the
  // engine run on demand), so every test below has real data to look at and none can pass on an empty chart. What is asserted about the
  // rest of the chart is structure and agreement with the API, never particular other roles.
  test.describe('SLA breaches by role chart', () => {
    test.describe.configure({ mode: 'serial' });          // they share one set of seeded breaches
    const cleanup = new Cleanup();
    let seeded: { role: { id: string; title: string }; people: Applicant[] };

    test.beforeAll(async ({ playwright }) => {
      const ctx = await playwright.request.newContext();
      try { seeded = await seedSlaBreaches(ctx, cleanup, { count: 3 }); } finally { await ctx.dispose(); }
    });
    test.afterAll(() => cleanup.purge());

    async function apiPayload(page: Page) {
      const token = await getToken(page.request, 'hr');
      return (await page.request.get(`${BASE}/api/dashboard/sla-by-role`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<{
        roles: { role_id: string; role_title: string; total: number }[]; total_breaches: number;
      }>;
    }

    /** The seeded role's bar; the chart shows the top 8 roles, so open the full list first when it is longer than that. */
    async function seededBar(page: Page) {
      const bar = page.getByRole('button', { name: new RegExp(`^${escapeRe(seeded.role.title)}: 3 open SLA breaches`) });
      const showAll = page.getByRole('button', { name: /^Show all \d+ roles$/ });
      if (!(await bar.count()) && (await showAll.count())) await showAll.click();
      return bar;
    }

    test('is rendered under the funnel snapshot, with one bar per role (top 8) matching the API', async ({ page }) => {
      await loginViaApi(page);
      const heading = page.getByRole('heading', { name: 'SLA breaches by role' });
      await expect(heading).toBeVisible({ timeout: 20000 });

      // below the funnel snapshot, not above it
      const funnelY = (await page.locator('button[title="Applied and Screened"]').boundingBox())!.y;
      expect((await heading.boundingBox())!.y).toBeGreaterThan(funnelY);

      const api = await apiPayload(page);
      expect(api.roles.length, 'the seeded role is on the chart, so it is not empty').toBeGreaterThan(0);
      expect(api.roles.find(r => r.role_id === seeded.role.id)?.total).toBe(3);
      await expect(page.getByText('No SLA breaches on open roles')).toHaveCount(0);
      const bars = page.getByRole('button', { name: /open SLA breaches/ });
      await expect(bars).toHaveCount(Math.min(api.roles.length, 8));
      // the busiest role is first, and its label carries the API's own count
      await expect(bars.first()).toHaveAttribute('aria-label', new RegExp(`^${escapeRe(api.roles[0].role_title)}: ${api.roles[0].total} open SLA breaches`));
      // the seeded role's bar carries its three breaches
      await expect(await seededBar(page)).toBeVisible();
    });

    test('clicking a bar opens the stage-by-stage breakdown, and clicking again closes it', async ({ page }) => {
      await loginViaApi(page);
      await expect(page.getByRole('heading', { name: 'SLA breaches by role' })).toBeVisible({ timeout: 20000 });
      const bar = await seededBar(page);
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('aria-expanded', 'false');
      await bar.click();
      await expect(bar).toHaveAttribute('aria-expanded', 'true');
      const region = page.getByRole('region', { name: `${seeded.role.title} — breaches by stage` });
      await expect(region).toBeVisible();
      await expect(region).toContainText('3 open breaches');
      await expect(region.getByRole('listitem').filter({ hasText: 'Applied and Screened' }).first()).toContainText('3');   // the stage and its count
      await expect(region).toContainText('Resume Shortlist Pending');                                                      // the breach type ...
      await expect(region).toContainText('Hiring Manager');                                                                // ... and who owns it
      await bar.click();
      await expect(bar).toHaveAttribute('aria-expanded', 'false');
      await expect(region).toHaveCount(0);
    });

    test('the table view lists every role with a breach, with the same total as the API', async ({ page }) => {
      await loginViaApi(page);
      await expect(page.getByRole('heading', { name: 'SLA breaches by role' })).toBeVisible({ timeout: 20000 });
      const api = await apiPayload(page);
      expect(api.roles.length).toBeGreaterThan(0);

      await page.getByRole('button', { name: 'Table', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
      // not limited to the top 8, and in the API's order: row i is role i (titles are not unique), ending in its total
      const rows = page.getByRole('table', { name: /Open SLA breaches per open role/ }).locator('tbody tr');   // not the dashboard's other tables
      await expect(rows).toHaveCount(api.roles.length);
      for (const [i, r] of api.roles.slice(0, 12).entries()) {
        await expect(rows.nth(i)).toContainText(r.role_title);
        await expect(rows.nth(i).getByRole('cell').last()).toHaveText(r.total.toLocaleString('en-IN'));
      }
      // the seeded role's row, wherever it sits
      const mine = rows.filter({ hasText: seeded.role.title });
      await expect(mine).toHaveCount(1);
      await expect(mine.getByRole('cell').last()).toHaveText('3');
    });
  });

  test('clicking a candidate breach tile navigates to that candidate\'s detail page', async ({ page }) => {
    // The breach is this test's own, so it does not depend on what other tests left behind (or on the describe above having run).
    const cleanup = new Cleanup();
    const { people } = await seedSlaBreaches(page.request, cleanup, { count: 1 });
    try {
      const target = people[0];
      await loginViaApi(page);
      await page.locator('button[title="Applied and Screened"]').click();
      await page.locator('button', { hasText: 'Resume Shortlist Pending' }).click();

      const card = page.locator(`a[href="/candidates/${target.candidate.id}"]`).first();
      await expect(card).toBeVisible({ timeout: 10000 });
      await expect(card).toContainText(target.name);
      await card.click();
      await page.waitForURL(new RegExp(`/candidates/${target.candidate.id}`), { timeout: 10000 });
      await expect(page.getByRole('heading', { name: target.name, level: 1 })).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanup.purge();
    }
  });
});
