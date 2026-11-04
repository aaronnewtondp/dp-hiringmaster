/**
 * E2E — Help & FAQ, the two guide PDFs, and the info markers ("i" icons) on the main pages.
 *
 * Help.tsx is hand-written prose and the markers are one-line explanations of what a number counts. Both are being reworded by another
 * branch, so NOTHING here pins a sentence: the checks are structural — a group has rows, a row opens to a non-empty answer, a marker opens a
 * popover that is on screen and has text, no text carries leaked template syntax ("{{x}}", "undefined", "[object Object]"). What IS pinned:
 *   - the Sourcing group exists exactly when GET /api/sourcing/status says the module is on (decided by diffing the group list, not by a title);
 *   - the two PDF links are real navigations that deliver a PDF and not the app shell — Workbox's NavigationRoute once swallowed them, which a
 *     plain HTTP request (curl, `request.get`) can never show; this needs the PRODUCTION BUILD of the frontend: bring the stack up with
 *     `bash scripts/test-stack.sh preview <N>`. On the dev server (no service worker) that describe skips itself with the reason;
 *   - which table headers carry a marker (header LABELS, never marker text).
 *
 * Test data: two candidates with an application on the seeded Senior PM role (one active, one on Hold for Future), so Candidates, Archived
 * Pipeline and Ready for Review render their tables with headers; removed in afterAll.
 */
import { test, expect, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { FRONTEND_BASE, authed, createCandidate, getToken, uid } from '../helpers/api';
import { E2EUserKey, expectNoPageErrors, gotoAs } from '../helpers/e2e';
import { nextDownload } from '../helpers/browser-checks';
import {
  expectRealText, frontendBuild, infoMarkers, markerPopover, NEEDS_PREVIEW, popoverReachable, purgeCandidates, readMarkerByHover,
  settledCount, waitForServiceWorkerControl,
} from '../helpers/e2e-misc';

// Most of this file reroutes API calls (the Sourcing status), which a service worker would hide from page.route; the PDF describe re-allows it.
test.use({ serviceWorkers: 'block' });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Help & FAQ
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const groupHeadings = (page: Page) => page.locator('main h2');
const groupCard = (page: Page, i: number) => groupHeadings(page).nth(i).locator('xpath=..');

async function groupTitles(page: Page): Promise<string[]> {
  return (await groupHeadings(page).allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
}

async function openHelp(page: Page, who: E2EUserKey): Promise<void> {
  await gotoAs(page, who, '/help');
  await expect(page.getByRole('heading', { name: 'Help & FAQ', level: 1 })).toBeVisible();
  await expect(groupHeadings(page).first()).toBeVisible();
}

/** `[group title, number of FAQ rows]` for every group on the page. */
async function helpOutline(page: Page): Promise<Array<[string, number]>> {
  const titles = await groupTitles(page);
  const out: Array<[string, number]> = [];
  for (let i = 0; i < titles.length; i++) out.push([titles[i], await groupCard(page, i).getByRole('button').count()]);
  return out;
}

test.describe('Help & FAQ', () => {
  test('every group lists FAQ rows, and every row opens to a real answer and closes again (Hiring Manager and HR)', async ({ page }) => {
    for (const who of ['hr', 'hm_alex'] as const) {
      const pageErrors = expectNoPageErrors(page);
      await openHelp(page, who);
      const outline = await helpOutline(page);
      expect(outline.length, `${who}: groups on the page`).toBeGreaterThanOrEqual(2);
      let rows = 0;
      for (let g = 0; g < outline.length; g++) {
        const [title, count] = outline[g];
        expectRealText(title, `${who}: the title of group ${g + 1}`);
        expect(count, `${who}: group "${title}" has no FAQ rows`).toBeGreaterThan(0);
        for (let r = 0; r < count; r++) {
          const question = groupCard(page, g).getByRole('button').nth(r);
          const label = `${who}: group "${title}" row ${r + 1}`;
          expectRealText(await question.innerText(), `${label} question`);
          const answer = question.locator('xpath=following-sibling::div');
          await expect(answer, `${label} is open before it was clicked`).toHaveCount(0);
          await question.click();
          await expect(answer, `${label} did not open`).toBeVisible();
          expectRealText(await answer.innerText(), `${label} answer`);
          await question.click();
          await expect(answer, `${label} did not close`).toHaveCount(0);
          rows++;
        }
      }
      expect(rows).toBeGreaterThanOrEqual(10);
      pageErrors.check();
    }
  });

  test('the page is the same for every persona (it says it is "available to everyone"): same groups, same number of rows', async ({ page }) => {
    const outlines: Array<[string, Array<[string, number]>]> = [];
    for (const who of ['hr', 'hr2', 'leadership', 'hm_alex', 'hm_satyadev', 'super_admin'] as const) {
      await openHelp(page, who);
      outlines.push([who, await helpOutline(page)]);
    }
    for (const [who, outline] of outlines.slice(1)) expect(outline, `${who} vs ${outlines[0][0]}`).toEqual(outlines[0][1]);
  });

  test('both guide cards link to a PDF in a new tab, and name what they open', async ({ page }) => {
    await openHelp(page, 'hr');
    for (const [link, file] of [['Open guide', 'DigitalPaani_HMS_User_Access_Guide.pdf'], ['Open SOP', 'DigitalPaani_Hiring_SOP.pdf']] as const) {
      const a = page.getByRole('link', { name: link });
      await expect(a).toHaveCount(1);
      await expect(a).toHaveAttribute('href', `/${file}`);
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', /noreferrer|noopener/);                // a link that opens a new tab must not hand it window.opener
    }
  });

  type StatusMode = 'real' | 'on' | 'off' | 'failing';
  /** Answers GET /api/sourcing/status the way `mode` says (and stops answering it any other way); 'real' lets the backend answer. */
  async function sourcingStatus(page: Page, mode: StatusMode): Promise<void> {
    await page.unroute('**/api/sourcing/status');
    if (mode === 'real') return;
    const reply = { on: [200, { enabled: true, settings: {} }], off: [200, { enabled: false }], failing: [500, { error: 'boom' }] }[mode] as [number, unknown];
    await page.route('**/api/sourcing/status', r => r.fulfill({ status: reply[0], contentType: 'application/json', body: JSON.stringify(reply[1]) }));
  }
  async function titlesWhen(page: Page, mode: StatusMode): Promise<string[]> {
    await sourcingStatus(page, mode);
    await openHelp(page, 'hr');
    return groupTitles(page);
  }

  test('the Sourcing group appears exactly when GET /api/sourcing/status says the module is on — on, off, and when the status call fails', async ({ page, request }) => {
    const real = await (await authed(request, await getToken(request, 'hr')).get('/api/sourcing/status')).json() as { enabled?: boolean };
    const on = await titlesWhen(page, 'on');
    const off = await titlesWhen(page, 'off');
    const failing = await titlesWhen(page, 'failing');

    // exactly one group more when it is on, and the rest is unchanged and in the same order
    expect(on.length).toBe(off.length + 1);
    const extra = on.filter(t => !off.includes(t));
    expect(extra, 'the group that only the Sourcing module adds').toHaveLength(1);
    expect(on.filter(t => t !== extra[0])).toEqual(off);
    expectRealText(extra[0], 'the Sourcing group title');
    expect(failing, 'a failing status call must not show the Sourcing group (nothing is shown on a guess)').toEqual(off);

    // and with the real answer of THIS backend
    expect(await titlesWhen(page, 'real'), `the real status is ${JSON.stringify(real)}`).toEqual(real.enabled === true ? on : off);
  });

  test('the Sourcing group, when it is shown, is a group of real FAQ rows', async ({ page }) => {
    const on = await titlesWhen(page, 'on');
    const off = await titlesWhen(page, 'off');
    const index = on.findIndex(t => !off.includes(t));
    expect(index, 'position of the Sourcing group').toBeGreaterThanOrEqual(0);

    await titlesWhen(page, 'on');
    const rows = groupCard(page, index).getByRole('button');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let r = 0; r < n; r++) {
      await rows.nth(r).click();
      const answer = rows.nth(r).locator('xpath=following-sibling::div');
      await expect(answer).toBeVisible();
      expectRealText(await answer.innerText(), `Sourcing group row ${r + 1}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The guide PDFs — as a real browser navigation, through the service worker
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('the guide PDFs are delivered as PDFs (production build)', () => {
  test.use({ serviceWorkers: 'allow' });
  let build: 'production' | 'dev' = 'dev';
  test.beforeAll(async ({ request }) => { build = await frontendBuild(request); });
  test.beforeEach(() => { test.skip(build !== 'production', NEEDS_PREVIEW); });

  const PUBLIC_DIR = path.resolve(__dirname, '../../../frontend/public');

  for (const [link, file] of [['Open guide', 'DigitalPaani_HMS_User_Access_Guide.pdf'], ['Open SOP', 'DigitalPaani_Hiring_SOP.pdf']] as const) {
    test(`"${link}" opens ${file} as a PDF while the service worker controls the page`, async ({ page }) => {
      const pdfResponses: Array<{ url: string; status: number; type: string }> = [];
      page.context().on('response', r => {
        if (new URL(r.url()).pathname.endsWith('.pdf')) pdfResponses.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] || '' });
      });

      await openHelp(page, 'hr');
      const sw = await waitForServiceWorkerControl(page);
      expect(sw.scriptURL).toMatch(/\/sw\.js$/);                                    // the generated Workbox worker is the one in control

      const started = nextDownload(page);
      await page.getByRole('link', { name: link }).click();
      const download = await started;

      expect(new URL(download.url()).pathname).toBe(`/${file}`);
      expect(download.suggestedFilename()).toBe(file);
      const bytes = fs.readFileSync((await download.path())!);
      expect(bytes.subarray(0, 5).toString('latin1'), 'the file starts like a PDF').toBe('%PDF-');
      expect(bytes.equals(fs.readFileSync(path.join(PUBLIC_DIR, file))), 'the bytes are the ones in frontend/public').toBe(true);
      const answered = pdfResponses.filter(r => new URL(r.url).pathname === `/${file}`);
      expect(answered.length, 'the PDF navigation was seen on the network').toBeGreaterThan(0);
      for (const r of answered) {
        expect(r.status).toBe(200);
        expect(r.type).toMatch(/^application\/pdf/);
      }
    });
  }

  test('a direct navigation to another static file (an icon) is served as that file, not as the app shell', async ({ page }) => {
    await openHelp(page, 'hr');
    await waitForServiceWorkerControl(page);
    const res = await page.goto(`${FRONTEND_BASE}/icons/icon-192.png`);
    expect(res!.status()).toBe(200);
    expect(res!.headers()['content-type']).toMatch(/^image\/png/);
    expect(new URL(page.url()).pathname).toBe('/icons/icon-192.png');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Info markers
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('info markers', () => {
  const stamp = uid();
  const candidateIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const hr = await getToken(request, 'hr');
    // an active application (Candidates, Ready for Review) and one on Hold for Future (Archived Pipeline's default list)
    for (const hold of [false, true]) {
      const { candidate, res } = await createCandidate(request, hr, { role_id: 'R006', full_name: `PW Markers ${hold ? 'Hold' : 'Active'} ${stamp}` });
      expect(res.status(), 'creating the marker fixture candidate').toBe(201);
      candidateIds.push(candidate.id);
      if (hold) {
        const appId = (await res.json()).application.id as string;
        const st = await authed(request, hr).post(`/api/applications/${appId}/status`, { new_status: 'Hold for Future' });
        expect(st.status(), 'putting the fixture application on Hold for Future').toBe(200);
      }
    }
  });
  test.afterAll(async () => { await purgeCandidates(candidateIds); });

  /**
   * One entry per page. `headers` are the table header LABELS that must carry a marker (today's set, as a lower-case subset: a header may gain
   * markers, but these keep theirs). `table` is the header row to wait for, when the page has a table.
   */
  const PAGES: Array<{ name: string; path: string; who: E2EUserKey; heading: string; table: boolean; headers: string[]; minMarkers: number }> = [
    { name: 'Dashboard',        path: '/dashboard',   who: 'hr',      heading: 'Dashboard',          table: false, headers: [],                                                               minMarkers: 8 },
    { name: 'Roles',            path: '/roles',       who: 'hr',      heading: 'Roles',              table: true,  headers: ['age', 'active candidates', 'active shortlist'],                 minMarkers: 3 },
    { name: 'Candidates',       path: '/candidates',  who: 'hr',      heading: 'Active Candidates',  table: true,  headers: ['gender', 'fit', 'current ctc → expected ctc', 'application date'], minMarkers: 5 },
    { name: 'Archived Pipeline', path: '/talent-pool', who: 'hr',     heading: 'Archived Pipeline',  table: true,  headers: ['gender', 'stage', 'fit', 'current ctc → expected ctc'],          minMarkers: 5 },
    { name: 'Agencies',         path: '/agencies',    who: 'hr',      heading: 'Agency Repository',  table: true,  headers: ['commission tiers', 'hires', 'replacement'],                      minMarkers: 4 },
    { name: 'My Tasks (with Ready for Review)', path: '/my-tasks', who: 'hr', heading: 'My Tasks',    table: true,  headers: ['gender', 'current ctc → expected ctc'],                          minMarkers: 3 },
    { name: 'Dashboard (Hiring Manager)', path: '/dashboard', who: 'hm_alex', heading: 'Dashboard',   table: false, headers: [],                                                               minMarkers: 3 },
    { name: 'Roles (Hiring Manager)',     path: '/roles',     who: 'hm_alex', heading: 'Roles',       table: true,  headers: ['age', 'active candidates'],                                      minMarkers: 2 },
    { name: 'My Tasks (Hiring Manager)',  path: '/my-tasks',  who: 'hm_alex', heading: 'My Tasks',    table: false, headers: [],                                                               minMarkers: 1 },
  ];

  for (const p of PAGES) {
    // The on-screen (hit-test) check applies to markers outside table headers: a header popover hangs below a header row that a short table
    // clips — see the two tests after this loop, which pin that on its own instead of letting it fail every page by row count.
    test(`${p.name}: every marker opens a popover with real text, and the table headers keep their markers`, async ({ page }) => {
      const pageErrors = expectNoPageErrors(page);
      await gotoAs(page, p.who, p.path);
      await expect(page.locator('main').getByRole('heading', { name: p.heading, exact: true }).first()).toBeVisible();
      if (p.table) await expect(page.locator('main thead th').first()).toBeVisible();
      await page.waitForLoadState('networkidle');

      const markers = infoMarkers(page.locator('main'));
      const n = await settledCount(markers);
      expect(n, `${p.name}: the number of markers`).toBeGreaterThanOrEqual(p.minMarkers);

      const labelled: string[] = [];
      for (let i = 0; i < n; i++) {
        const marker = markers.nth(i);
        const th = marker.locator('xpath=ancestor::th');
        const where = (await th.count()) ? (await th.first().textContent() ?? '').replace(/\s+/g, ' ').trim().toLowerCase() : '';
        if (where) labelled.push(where);
        const what = `${p.name}: marker ${i + 1} of ${n}${where ? ` (header "${where}")` : ''}`;
        const text = await readMarkerByHover(page, marker, what, { checkReachable: !where });
        expectRealText(text, what);
      }
      for (const h of p.headers) expect(labelled, `${p.name}: the "${h}" header has no info marker any more`).toContain(h);
      pageErrors.check();
    });
  }

  /**
   * The marker that sits in the table header whose label matches `label`, as a positional locator over every marker in <main>. (A locator
   * that filters the header by its text would stop matching the moment the popover opens: the header's text then includes the popover's.)
   */
  async function markerOfHeader(page: Page, label: RegExp): Promise<Locator> {
    const markers = infoMarkers(page.locator('main'));
    const n = await markers.count();
    for (let i = 0; i < n; i++) {
      const th = markers.nth(i).locator('xpath=ancestor::th');
      if ((await th.count()) && label.test((await th.first().textContent() ?? '').replace(/\s+/g, ' ').trim())) return markers.nth(i);
    }
    throw new Error(`no info marker sits in a table header matching ${label}`);
  }

  test('a header popover is fully on screen when the table has several rows (Roles, Agencies)', async ({ page }) => {
    for (const [path, heading, label] of [['/roles', 'Roles', /^age$/i], ['/agencies', 'Agency Repository', /^hires$/i]] as const) {
      await gotoAs(page, 'hr', path);
      await expect(page.locator('main').getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      await expect(page.locator('main tbody tr').nth(2)).toBeVisible();                           // at least three rows: the seed has 7 roles and 15 agencies
      await page.waitForLoadState('networkidle');
      await settledCount(infoMarkers(page.locator('main')));
      const marker = await markerOfHeader(page, label);
      await readMarkerByHover(page, marker, `${path} header ${label}`, { checkReachable: true });
    }
  });

  // TODAY: the table card clips what hangs below its header row. With a long list the popover covers the rows below the header and is
  // fine; narrow the list to ONE row (search by the fixture's name) and the Gender popover is cut off at the card's bottom edge, mid-sentence.
  // When the card stops clipping, this test fails: rename it and assert the popover is reachable.
  for (const p of [
    { name: 'Candidates',        path: '/candidates',  heading: 'Active Candidates', fixture: `PW Markers Active ${stamp}` },
    { name: 'Archived Pipeline', path: '/talent-pool', heading: 'Archived Pipeline', fixture: `PW Markers Hold ${stamp}` },
    { name: 'Ready for Review',  path: '/my-tasks',    heading: 'My Tasks',          fixture: `PW Markers Active ${stamp}` },
  ]) {
    test(`TODAY: ${p.name}: the Gender header popover is cut off by the table card when the list has a single row`, async ({ page }) => {
      await gotoAs(page, 'hr', p.path);
      await expect(page.locator('main').getByRole('heading', { name: p.heading, exact: true }).first()).toBeVisible();
      await page.getByPlaceholder(/^Search/).first().fill(p.fixture);
      const rows = page.locator('main tbody tr');
      await expect(rows.filter({ hasText: p.fixture })).toHaveCount(1);                                // the search narrowed the list to the fixture ...
      await expect(rows.filter({ hasNotText: p.fixture }).filter({ hasText: /PW Markers/ })).toHaveCount(0);   // ... and no other candidate of any run is listed
      await expect.poll(() => rows.evaluateAll(trs => trs.filter(tr => (tr.textContent || '').trim()).length), { message: 'rows with content: the candidate (and at most one footer row)' }).toBeLessThanOrEqual(2);
      await page.waitForLoadState('networkidle');

      const marker = await markerOfHeader(page, /^gender$/i);
      const text = await readMarkerByHover(page, marker, `${p.name}: Gender header`, { checkReachable: false });
      expectRealText(text, `${p.name}: Gender header popover`);                                       // it opens and has its text ...
      await marker.hover();
      const reach = await popoverReachable(markerPopover(marker));
      expect(reach.ok, 'TODAY: part of the popover is clipped by the card').toBe(false);                // ... but the card cuts it off
      expect(reach.detail).toMatch(/covered or clipped/);
    });
  }

  test('keyboard users: Enter on a focused marker opens it, again closes it, and a press elsewhere closes it', async ({ page }) => {
    await gotoAs(page, 'hr', '/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const marker = infoMarkers(page.locator('main')).first();
    await marker.focus();
    await page.keyboard.press('Enter');
    const popover = markerPopover(marker);
    await expect(popover).toBeVisible();
    expectRealText(await popover.innerText(), 'the first dashboard marker, opened with the keyboard');
    await page.keyboard.press('Enter');                                                // a second press toggles it shut
    await expect(popover).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).click();           // a press elsewhere closes it
    await expect(popover).toHaveCount(0);
  });

  test('only one popover is open at a time: moving from one marker to the next closes the first', async ({ page }) => {
    await gotoAs(page, 'hr', '/roles');
    await expect(page.locator('main thead th').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const markers = infoMarkers(page.locator('main'));
    expect(await settledCount(markers)).toBeGreaterThanOrEqual(2);
    await markers.nth(0).hover();
    await expect(markerPopover(markers.nth(0))).toBeVisible();
    await markers.nth(1).hover();
    await expect(markerPopover(markers.nth(1))).toBeVisible();
    await expect(markerPopover(markers.nth(0))).toHaveCount(0);
  });
});
