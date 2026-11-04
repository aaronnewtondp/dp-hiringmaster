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
import fs from 'fs';
import { BASE, FRONTEND_BASE, SMOKE_USERS, getToken, authed } from '../helpers/api';
import { expectRealText, nextDownload, waitForServiceWorkerControl } from '../helpers/browser-checks';   // DB-free helpers only: this file runs against production

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

// ── Help & FAQ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Read-only: the page is static prose; the only interaction is opening and closing FAQ rows, which is client-side state. No sentence is
// pinned (the text is reworded from time to time): groups, rows, non-empty answers, no leaked template syntax. The Sourcing group is
// decided by diffing the page with the status call answered "off" in the browser (page.route changes nothing on the server).
test.describe('help page (read-only)', () => {
  test.use({ serviceWorkers: 'block' });          // so page.route sees the status call

  const groupHeadings = (page: Page) => page.locator('main h2');
  const groupTitles = async (page: Page) => (await groupHeadings(page).allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());

  for (const key of ['smoke_lead', 'smoke_hm'] as const) {
    test(`${key}: every group lists FAQ rows that open to real text, and the Sourcing group follows GET /api/sourcing/status`, async ({ page, request }) => {
      const problems = await openAs(page, request, key, '/help');
      await expect(page.getByRole('heading', { name: 'Help & FAQ', level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect(groupHeadings(page).first()).toBeVisible();
      const real = await groupTitles(page);
      expect(real.length, 'groups on the page').toBeGreaterThanOrEqual(2);

      let rows = 0;
      for (let g = 0; g < real.length; g++) {
        expectRealText(real[g], `the title of group ${g + 1}`);
        const questions = groupHeadings(page).nth(g).locator('xpath=..').getByRole('button');
        const n = await questions.count();
        expect(n, `group "${real[g]}" has no FAQ rows`).toBeGreaterThan(0);
        for (let r = 0; r < n; r++) {
          const question = questions.nth(r);
          const label = `group "${real[g]}" row ${r + 1}`;
          expectRealText(await question.innerText(), `${label} question`);
          const answer = question.locator('xpath=following-sibling::div');
          await question.click();
          await expect(answer, `${label} did not open`).toBeVisible();
          expectRealText(await answer.innerText(), `${label} answer`);
          await question.click();
          await expect(answer, `${label} did not close`).toHaveCount(0);
          rows++;
        }
      }
      expect(rows).toBeGreaterThanOrEqual(10);

      // the Sourcing group: present exactly when the real status says the module is on
      const status = await (await authed(request, await getToken(request, key)).get('/api/sourcing/status')).json() as { enabled?: boolean };
      await page.route('**/api/sourcing/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) }));
      await page.reload();
      await expect(groupHeadings(page).first()).toBeVisible({ timeout: 60_000 });
      const withoutSourcing = await groupTitles(page);
      expect(real.length, `the real status is ${JSON.stringify(status)}`).toBe(withoutSourcing.length + (status.enabled === true ? 1 : 0));
      expect(real.filter(t => withoutSourcing.includes(t))).toEqual(withoutSourcing);
      expect(problems).toEqual([]);
    });
  }

  test.describe('the guide PDFs', () => {
    test.use({ serviceWorkers: 'allow' });         // the point is the real service worker, which once swallowed these navigations

    for (const [link, file] of [['Open guide', 'DigitalPaani_HMS_User_Access_Guide.pdf'], ['Open SOP', 'DigitalPaani_Hiring_SOP.pdf']] as const) {
      test(`"${link}" opens ${file} as a PDF in a real navigation, with the service worker in control (curl cannot show the difference)`, async ({ page, request }) => {
        const seen: Array<{ path: string; status: number; type: string }> = [];
        page.context().on('response', r => {
          const path = new URL(r.url()).pathname;
          if (path.endsWith('.pdf')) seen.push({ path, status: r.status(), type: r.headers()['content-type'] || '' });
        });
        const problems = await openAs(page, request, 'smoke_lead', '/help');
        await expect(page.getByRole('link', { name: link })).toBeVisible({ timeout: 60_000 });
        await waitForServiceWorkerControl(page);

        const started = nextDownload(page);
        await page.getByRole('link', { name: link }).click();
        const download = await started;
        expect(new URL(download.url()).pathname).toBe(`/${file}`);
        const bytes = fs.readFileSync((await download.path())!);
        expect(bytes.subarray(0, 5).toString('latin1'), 'the file starts like a PDF').toBe('%PDF-');
        expect(bytes.length, 'a real document, not a stub').toBeGreaterThan(10_000);
        const answered = seen.filter(s => s.path === `/${file}`);
        expect(answered.length).toBeGreaterThan(0);
        for (const s of answered) { expect(s.status).toBe(200); expect(s.type).toMatch(/^application\/pdf/); }
        expect(problems).toEqual([]);
      });
    }
  });
});
