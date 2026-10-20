/**
 * Production smoke tests — the browser side. Safe against the live Vercel deployment.
 *
 * Signs in as the two dedicated READ-ONLY smoke accounts (see helpers/smoke-env.ts), opens the main pages in a real browser and
 * checks that each one renders for that persona: the page's own heading appears, nothing bounces to the login page, no API call
 * answers 5xx and no uncaught page error is thrown. It only navigates — it never clicks a save/send/delete control, and the
 * backend refuses every non-GET request from these accounts anyway. Screenshots, traces and videos are off for this project, so
 * no candidate data is written to disk.
 *
 * The token is minted through the API (cached by global-setup) and handed to the app the way a Google sign-in would, so the
 * Google button is not involved.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BASE, FRONTEND_BASE, SMOKE_USERS, getToken, authed } from '../helpers/api';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);          // the first dashboard load after idle runs the whole SLA sweep

type Key = 'smoke_lead' | 'smoke_hm';

async function openAs(page: Page, request: APIRequestContext, key: Key, path: string) {
  const token = await getToken(request, key);
  const me = await (await authed(request, token).get('/api/auth/me')).json();
  const problems: string[] = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${FRONTEND_BASE}/login`);
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(user));
    sessionStorage.clear();
  }, { token, user: me.user });
  await page.goto(`${FRONTEND_BASE}${path}`);
  return problems;
}

const stayedOn = async (page: Page, path: string) => expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 30_000 });

const LEADERSHIP_PAGES: Array<[string, string]> = [
  ['/dashboard', 'Dashboard'], ['/roles', 'Roles'], ['/candidates', 'Active Candidates'], ['/talent-pool', 'Archived Pipeline'],
  ['/agencies', 'Agency Repository'], ['/my-tasks', 'My Tasks'], ['/help', 'Help & FAQ'],
];
const HM_PAGES: Array<[string, string]> = [
  ['/dashboard', 'Dashboard'], ['/roles', 'Roles'], ['/my-tasks', 'My Tasks'], ['/help', 'Help & FAQ'],
];

test.beforeAll(() => {
  test.skip(!SMOKE_USERS.smoke_lead.email || !SMOKE_USERS.smoke_hm.email, 'smoke accounts are not configured (hms-tests-final/.env.smoke.local)');
});

for (const [path, heading] of LEADERSHIP_PAGES) {
  test(`leadership (HR-tier) — ${path} renders`, async ({ page, request }) => {
    const problems = await openAs(page, request, 'smoke_lead', path);
    await expect(page.locator('main').getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await stayedOn(page, path);
    expect(problems).toEqual([]);
  });
}

for (const [path, heading] of HM_PAGES) {
  test(`hiring manager — ${path} renders for the restricted persona (a Hiring Manager named on no role: empty states, no crash)`, async ({ page, request }) => {
    const problems = await openAs(page, request, 'smoke_hm', path);
    await expect(page.locator('main').getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await stayedOn(page, path);
    expect(problems).toEqual([]);
  });
}

test('a role page opens for both personas', async ({ page, request }) => {
  const lead = await getToken(request, 'smoke_lead');
  const { roles } = await (await authed(request, lead).get('/api/roles')).json();
  const role = roles[0] as { id: string; title: string };
  for (const key of ['smoke_lead', 'smoke_hm'] as const) {
    const problems = await openAs(page, request, key, `/roles/${role.id}`);
    await expect(page.locator('main').getByText(role.title).first()).toBeVisible({ timeout: 60_000 });
    await stayedOn(page, `/roles/${role.id}`);
    expect(problems, key).toEqual([]);
  }
});

test('user management is Super-Admin only: the page bounces both smoke accounts back to the dashboard', async ({ page, request }) => {
  for (const key of ['smoke_lead', 'smoke_hm'] as const) {
    await openAs(page, request, key, '/users');
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  }
});
