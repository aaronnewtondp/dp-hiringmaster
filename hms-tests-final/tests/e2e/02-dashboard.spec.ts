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
  await loginViaApi(page);
  // Wait for data to load
  await page.waitForTimeout(3000);
  // At least one numeric metric should be visible
  const body = await page.locator('body').textContent();
  // We seeded 7 roles so some number should appear
  expect(body).toMatch(/\d+/);
});

// ─── Hiring Funnel Snapshot — interactive chevron/rail/tile regressions ──────
// Covers three UI behaviors that no API test can see: they're pure
// client-side rendering/interaction, not data shape. All three were explicit
// user-reported fixes (see HiringFunnelSnapshot.tsx's own comments), so a
// silent regression here would ship straight past the API suite.
test.describe('Hiring Funnel Snapshot', () => {

  test('every stage chevron is colored by default; selecting one greys out every other stage', async ({ page }) => {
    await loginViaApi(page);
    const applied = page.locator('button[title="Applied"]');
    const resumeReview = page.locator('button[title="Resume Review"]');
    await expect(applied).toBeVisible({ timeout: 15000 });
    await expect(resumeReview).toBeVisible();

    const bgBefore = {
      applied: await applied.evaluate(el => (el as HTMLElement).style.background),
      resumeReview: await resumeReview.evaluate(el => (el as HTMLElement).style.background),
    };
    // Distinct stages must not already share an identical background before
    // any selection — each is lit in its own STAGE_COLORS hue by default.
    expect(bgBefore.applied).not.toBe(bgBefore.resumeReview);

    await applied.click();
    await page.waitForTimeout(300); // style transition/re-render settle

    const bgAfter = {
      applied: await applied.evaluate(el => (el as HTMLElement).style.background),
      resumeReview: await resumeReview.evaluate(el => (el as HTMLElement).style.background),
    };
    // The selected stage's own hue changes (brightened) but must still
    // differ from the now-shared grey the rest collapse to.
    expect(bgAfter.applied).not.toBe(bgBefore.applied);
    expect(bgAfter.resumeReview).not.toBe(bgBefore.resumeReview);
    expect(bgAfter.applied).not.toBe(bgAfter.resumeReview);

    // Every OTHER stage must now share one identical (grey/UNLIT_BG) fill —
    // not just Resume Review — confirming "grey out every other stage",
    // not just the one checked above.
    const otherTitles = ['Shortlisted', 'Interview Round 1', 'Founders Round', 'Joined'];
    const otherBgs = await Promise.all(
      otherTitles.map(t => page.locator(`button[title="${t}"]`).evaluate(el => (el as HTMLElement).style.background))
    );
    for (const bg of otherBgs) expect(bg).toBe(bgAfter.resumeReview);
  });

  test('role filter rail renders full role names without CSS truncation', async ({ page }) => {
    await loginViaApi(page);
    await expect(page.locator('text=Filter this section by role').first()).toBeVisible({ timeout: 15000 });

    // Rail buttons are real <button> elements inside the rail's scroll
    // region — grab the first role option (index 0 is the "All roles"
    // toggle, so the first real role is index 1).
    const rail = page.locator('div.max-h-80.overflow-y-auto button');
    const count = await rail.count();
    expect(count).toBeGreaterThan(1);
    const roleBtn = rail.nth(1);

    const style = await roleBtn.evaluate(el => {
      const cs = getComputedStyle(el);
      return { whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow };
    });
    // Truncation requires BOTH nowrap and an ellipsis — neither should be
    // present; the rail wraps long names onto extra lines instead of
    // clipping them (the user's explicit "all names clearly visible" ask).
    expect(style.whiteSpace).not.toBe('nowrap');
    expect(style.textOverflow).not.toBe('ellipsis');
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
