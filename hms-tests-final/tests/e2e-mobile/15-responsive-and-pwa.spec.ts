/**
 * E2E (mobile project) — the responsive navigation drawer and the PWA install surface.
 *
 * Below Tailwind's `lg:` breakpoint (1024 px: phones AND tablets, an iPad in portrait included) the sidebar is an overlay drawer that is
 * closed by default, opened from a hamburger in a top bar, and closed by the backdrop, Escape, its own close button or a click on any
 * navigation link; while it is open the page behind does not scroll. From 1024 px up the sidebar is the ordinary always-visible column and
 * none of that exists. (Sidebar.tsx / Layout.tsx.)
 *
 * The PWA is installability ONLY, never offline-first (frontend/vite.config.ts): a manifest + a generated service worker that precaches the app
 * shell and sends every /api/* request straight to the network. That exists only in a PRODUCTION BUILD of the frontend — bring the stack up
 * with `bash scripts/test-stack.sh preview <N>`; on the dev server the PWA describes skip themselves with that reason. (index.html is what
 * tells the two apart, never /sw.js: a production build that lost its PWA plugin must FAIL here, not skip.)
 *
 * Runs on the `e2e-mobile` project: Chromium at 390x844 with touch. The desktop-width checks override the viewport inside their own describe.
 */
import { test, expect, Page, Locator } from '@playwright/test';
import { FRONTEND_BASE, createCandidate, getToken, uid } from '../helpers/api';
import { gotoAs, loginViaApi } from '../helpers/e2e';
import { frontendBuild, infoMarkers, markerPopover, NEEDS_PREVIEW, pngSize, purgeCandidates, waitForServiceWorkerControl } from '../helpers/e2e-misc';

// ── The drawer ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const aside      = (page: Page) => page.locator('aside[aria-label="Main navigation"]');
const hamburger  = (page: Page) => page.getByRole('button', { name: 'Open menu' });
const closeMenu  = (page: Page) => page.getByRole('button', { name: 'Close menu' });
const bodyScroll = (page: Page) => page.evaluate(() => document.body.style.overflow);
/** What sits at a point on the page that is NOT covered by the 224 px drawer (phone width): the backdrop while the drawer is open. */
const behindDrawer = (page: Page) => page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth - 20, window.innerHeight / 2);
  return el ? { aria: el.getAttribute('aria-hidden'), inMain: !!el.closest('main') } : null;
});

async function expectClosed(page: Page, why: string) {
  await expect(aside(page), `${why}: the drawer should be out of view`).not.toBeInViewport();
  await expect(aside(page)).not.toHaveAttribute('role', 'dialog');
  await expect(hamburger(page)).toHaveAttribute('aria-expanded', 'false');
  expect(await bodyScroll(page), `${why}: the page behind must scroll again`).toBe('');
  expect((await behindDrawer(page))?.aria, `${why}: the backdrop must be gone`).not.toBe('true');
}

async function openDrawer(page: Page) {
  await hamburger(page).click();
  await expect(aside(page)).toBeInViewport({ ratio: 1 });                  // fully slid in (a 200 ms transition)
}

test.describe('the navigation drawer below the lg breakpoint (phone width, 390 px)', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, 'hr');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('closed by default: the sidebar is out of view, the top bar carries the hamburger, and the closed drawer reserves no width', async ({ page }) => {
    await expectClosed(page, 'initial state');
    await expect(hamburger(page)).toBeVisible();
    await expect(page.getByText('Hiring Master System').first()).toBeVisible();                 // the top bar's title
    const main = await page.locator('main').boundingBox();
    const vw = page.viewportSize()!.width;
    expect(main!.x, 'main starts at the left edge').toBeLessThanOrEqual(1);
    expect(main!.width, 'main spans the whole viewport').toBeGreaterThanOrEqual(vw - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page itself must not scroll sideways').toBe(true);
  });

  test('a tap on the hamburger opens the drawer: dialog role, backdrop behind it, page scroll locked', async ({ page }) => {
    await hamburger(page).tap();
    await expect(aside(page)).toBeInViewport({ ratio: 1 });
    await expect(aside(page)).toHaveAttribute('role', 'dialog');
    await expect(aside(page)).toHaveAttribute('aria-modal', 'true');
    await expect(hamburger(page)).toHaveAttribute('aria-expanded', 'true');
    expect(await bodyScroll(page)).toBe('hidden');
    expect((await behindDrawer(page))?.aria, 'a backdrop covers the page behind the drawer').toBe('true');
    await expect(closeMenu(page)).toBeVisible();
    await expect(aside(page).getByRole('link', { name: 'Dashboard' })).toBeVisible();
  });

  test('a tap on the backdrop closes it', async ({ page }) => {
    await openDrawer(page);
    const vw = page.viewportSize()!.width, vh = page.viewportSize()!.height;
    await page.touchscreen.tap(vw - 20, vh / 2);                                               // right of the 224 px drawer
    await expectClosed(page, 'backdrop');
  });

  test('Escape closes it, and Escape on a closed page does nothing', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expectClosed(page, 'Escape on the closed page');
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expectClosed(page, 'Escape');
  });

  test('its own close button closes it', async ({ page }) => {
    await openDrawer(page);
    await closeMenu(page).click();
    await expectClosed(page, 'the close button');
  });

  test('a click on a navigation link goes there and closes it', async ({ page }) => {
    await openDrawer(page);
    await aside(page).getByRole('link', { name: 'Roles' }).click();
    await expect(page).toHaveURL(/\/roles$/);
    await expect(page.locator('main').getByRole('heading', { name: 'Roles', exact: true }).first()).toBeVisible();
    await expectClosed(page, 'a link click');
    await openDrawer(page);                                                                  // it opens again afterwards
    await expect(aside(page).getByRole('link', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');
  });

  test('a click on the link of the page you are already on also closes it', async ({ page }) => {
    await openDrawer(page);
    await aside(page).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectClosed(page, 'the current page\'s link');
  });

  test('the drawer holds exactly the links the desktop sidebar holds', async ({ page }) => {
    await openDrawer(page);
    const inDrawer = await aside(page).getByRole('link').allInnerTexts();
    await page.setViewportSize({ width: 1280, height: 800 });
    const onDesktop = await aside(page).getByRole('link').allInnerTexts();
    expect(inDrawer.map(t => t.trim())).toEqual(onDesktop.map(t => t.trim()));
    expect(inDrawer.length).toBeGreaterThanOrEqual(6);
  });

  test('Sign out inside the drawer ends the session, returns to the login page and leaves the page scrollable', async ({ page }) => {
    await openDrawer(page);
    await aside(page).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => [localStorage.getItem('hms_token'), localStorage.getItem('hms_user')])).toEqual([null, null]);
    expect(await bodyScroll(page), 'the scroll lock must not outlive the drawer').toBe('');
  });

  test('on a tablet in portrait (820 px) it is still a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await expectClosed(page, '820 px');
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expectClosed(page, '820 px after Escape');
  });
});

test.describe('where the drawer stops: lg is 1024 px', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 } });

  for (const width of [320, 390, 768, 820, 1023]) {
    test(`${width} px: sidebar is a drawer (hidden, hamburger shown)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await loginViaApi(page, 'hr');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      await expect(hamburger(page)).toBeVisible();
      await expect(aside(page)).not.toBeInViewport();
      const main = await page.locator('main').boundingBox();                                  // a closed drawer is out of the flow: it reserves no column
      expect(main!.x, `${width} px: main starts at the left edge`).toBeLessThanOrEqual(1);
      expect(main!.width, `${width} px: main spans the whole viewport`).toBeGreaterThanOrEqual(width - 1);
    });
  }

  for (const width of [1024, 1280, 1920]) {
    test(`${width} px: the sidebar is the ordinary column — visible, no hamburger, no close button, no dialog, no backdrop`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await loginViaApi(page, 'hr');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      await expect(aside(page)).toBeInViewport({ ratio: 1 });
      await expect(hamburger(page)).toBeHidden();
      await expect(closeMenu(page)).toBeHidden();
      await expect(aside(page)).not.toHaveAttribute('role', 'dialog');
      expect((await behindDrawer(page))?.aria).not.toBe('true');
      const box = await page.locator('main').boundingBox();
      expect(box!.x, 'main sits to the right of the sidebar').toBeGreaterThanOrEqual(200);
      await aside(page).getByRole('link', { name: 'Roles' }).click();
      await expect(page).toHaveURL(/\/roles$/);
      await expect(aside(page)).toBeInViewport({ ratio: 1 });                                  // navigating never hides the desktop sidebar
    });
  }

  test('crossing the breakpoint while the drawer is open leaves a normal desktop layout (no hamburger, sidebar in the column)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await loginViaApi(page, 'hr');
    await openDrawer(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(hamburger(page)).toBeHidden();
    await expect(aside(page)).toBeInViewport({ ratio: 1 });
    expect((await behindDrawer(page))?.aria, 'the backdrop is a phone/tablet thing').not.toBe('true');
    await aside(page).getByRole('link', { name: 'Roles' }).click();                           // the desktop sidebar still navigates
    await expect(page).toHaveURL(/\/roles$/);
  });

  test('Sign out in the desktop sidebar ends the session and returns to the login page', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await aside(page).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => [localStorage.getItem('hms_token'), localStorage.getItem('hms_user')])).toEqual([null, null]);
    await page.goto(`${FRONTEND_BASE}/dashboard`);
    await expect(page).toHaveURL(/\/login/);                                                  // and the app really is closed
  });
});

// ── The PWA install surface (production build only) ──────────────────────────────────────────────────────────────────────────────
test.describe('PWA install surface (production build)', () => {
  let build: 'production' | 'dev' = 'dev';
  test.beforeAll(async ({ request }) => { build = await frontendBuild(request); });
  test.beforeEach(() => { test.skip(build !== 'production', NEEDS_PREVIEW); });

  /** Evaluates a regex literal ("/x/i") taken from the generated service worker. The file is this build's own output. */
  const regexFrom = (literal: string): RegExp => new Function(`return ${literal}`)() as RegExp;

  /** The index.html of the build, its asset URLs and its head links. */
  async function shell(request: import('@playwright/test').APIRequestContext) {
    const html = await (await request.get(`${FRONTEND_BASE}/`)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
    return { html, assets };
  }

  test('the manifest is served, parses, and describes an installable standalone app', async ({ request }) => {
    const res = await request.get(`${FRONTEND_BASE}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^application\/(manifest\+)?json/);
    const m = await res.json() as {
      name: string; short_name: string; start_url: string; display: string; theme_color: string; background_color: string; scope?: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.short_name.length).toBeGreaterThan(0);
    expect(m.short_name.length, 'a home-screen label must be short').toBeLessThanOrEqual(12);
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.icons.some(i => i.sizes === '192x192' && i.type === 'image/png')).toBe(true);
    expect(m.icons.some(i => i.sizes === '512x512' && i.type === 'image/png' && !i.purpose)).toBe(true);        // the "any" 512 icon
    expect(m.icons.some(i => i.purpose === 'maskable'), 'a maskable icon for Android adaptive icons').toBe(true);

    // the page links the manifest and agrees with it on the browser-chrome colour
    const { html } = await shell(request);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"\s*\/?>/);
    expect(html).toMatch(new RegExp(`<meta name="theme-color" content="${m.theme_color}"`, 'i'));
  });

  test('every icon the manifest names answers 200 as a PNG of exactly the size it declares', async ({ request }) => {
    const m = await (await request.get(`${FRONTEND_BASE}/manifest.webmanifest`)).json() as { icons: Array<{ src: string; sizes: string; type: string }> };
    for (const icon of m.icons) {
      const res = await request.get(`${FRONTEND_BASE}${icon.src}`);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toMatch(/^image\/png/);
      const size = pngSize(await res.body());
      expect(size, `${icon.src} is not a PNG`).not.toBeNull();
      expect(`${size!.width}x${size!.height}`, icon.src).toBe(icon.sizes);
    }
  });

  test('iOS gets its own icon: the apple-touch-icon link exists and points at a real, square PNG (iOS ignores the manifest icons)', async ({ request }) => {
    const { html } = await shell(request);
    const href = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    expect(href, 'no <link rel="apple-touch-icon"> in index.html').toBeTruthy();
    const res = await request.get(`${FRONTEND_BASE}${href}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\/png/);
    const size = pngSize(await res.body());
    expect(size).not.toBeNull();
    expect(size!.width).toBe(size!.height);
    expect(size!.width).toBeGreaterThanOrEqual(120);
  });

  test('the generated service worker precaches the app shell and nothing from /api', async ({ request }) => {
    const res = await request.get(`${FRONTEND_BASE}/sw.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
    const sw = await res.text();

    const precached = [...sw.matchAll(/\{url:"([^"]+)",revision:(?:null|"[0-9a-f]+")\}/g)].map(m => m[1]);
    expect(precached.length, 'the precache list could not be read from sw.js').toBeGreaterThanOrEqual(5);
    const { assets } = await shell(request);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(precached, 'the HTML shell').toContain('index.html');
    for (const asset of assets) expect(precached, `${asset} is loaded by index.html but not precached`).toContain(asset.replace(/^\//, ''));
    expect(precached.some(u => /^icons\/icon-192\.png$/.test(u)) && precached.some(u => /^icons\/icon-512\.png$/.test(u)), 'the icons').toBe(true);
    expect(precached.filter(u => /\/api\/|^api\//i.test(u)), 'nothing from /api may be precached').toEqual([]);
    expect(sw, 'skipWaiting + clientsClaim: a new deploy takes over silently').toMatch(/skipWaiting\(\)/);
    expect(sw).toMatch(/clientsClaim\(\)/);
  });

  test('every /api GET is routed NetworkOnly, and the service worker uses no other caching strategy', async ({ request }) => {
    const sw = await (await request.get(`${FRONTEND_BASE}/sw.js`)).text();
    const apiRoute = sw.match(/registerRoute\((\/(?:\\.|[^/\\\n])+\/[a-z]*),\s*new [\w$]+\.NetworkOnly(?:\(\))?,\s*"(\w+)"\)/);
    expect(apiRoute, 'no registerRoute(<regex>, new NetworkOnly, "GET") in sw.js').not.toBeNull();
    const re = regexFrom(apiRoute![1]);
    expect(apiRoute![2]).toBe('GET');
    for (const url of [`${FRONTEND_BASE}/api/roles`, `${FRONTEND_BASE}/api/candidates?q=x`, `${FRONTEND_BASE}/api/auth/me`]) {
      expect(re.test(url), `${url} must be routed NetworkOnly`).toBe(true);
    }
    expect(re.test(`${FRONTEND_BASE}/assets/index-abc.js`), 'the shell is not an API call').toBe(false);
    for (const strategy of ['CacheFirst', 'StaleWhileRevalidate', 'NetworkFirst', 'CacheOnly']) {
      expect(sw.includes(strategy), `sw.js must not use ${strategy}: API data and candidate PII are never cached`).toBe(false);
    }
  });

  test('the navigation fallback serves the app shell for app routes and never for /api or for a path with a file extension', async ({ request }) => {
    const sw = await (await request.get(`${FRONTEND_BASE}/sw.js`)).text();
    const start = sw.indexOf('denylist:[');
    expect(start, 'no navigation denylist in sw.js').toBeGreaterThan(-1);
    // read the array literal: regex literals may hold [...] classes, so count brackets and skip escapes
    let depth = 0, end = -1;
    for (let i = start + 'denylist:'.length; i < sw.length; i++) {
      const c = sw[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') depth++;
      if (c === ']' && --depth === 0) { end = i; break; }
    }
    expect(end).toBeGreaterThan(start);
    const denylist = new Function(`return ${sw.slice(start + 'denylist:'.length, end + 1)}`)() as RegExp[];
    const denied = (p: string) => denylist.some(r => r.test(p));

    expect(denied('/api/roles')).toBe(true);
    expect(denied('/DigitalPaani_HMS_User_Access_Guide.pdf'), 'the guide PDFs are real files').toBe(true);
    expect(denied('/DigitalPaani_Hiring_SOP.pdf')).toBe(true);
    expect(denied('/icons/icon-192.png')).toBe(true);
    expect(denied('/manifest.webmanifest')).toBe(true);
    for (const route of ['/', '/dashboard', '/roles', '/roles/R006', '/candidates/C0001', '/talent-pool', '/my-tasks', '/sourcing', '/users', '/help']) {
      expect(denied(route), `the app route ${route} must still get the app shell`).toBe(false);
    }
  });

  test.describe('in the browser', () => {
    const stamp = uid();
    const candidateIds: string[] = [];
    test.afterAll(async () => { await purgeCandidates(candidateIds); });

    test('the worker registers, takes control, precaches the shell, and no API response ever lands in Cache Storage', async ({ page, request }) => {
      await loginViaApi(page, 'hr');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      const sw = await waitForServiceWorkerControl(page);
      expect(sw.scriptURL).toBe(`${FRONTEND_BASE}/sw.js`);

      // visit pages that make plenty of API calls, then look at everything the browser stored
      for (const path of ['/roles', '/candidates', '/my-tasks', '/dashboard']) {
        await gotoAs(page, 'hr', path);
        await page.waitForLoadState('networkidle');
      }
      const stored = await page.evaluate(async () => {
        const out: Record<string, string[]> = {};
        for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map(r => r.url);
        return out;
      });
      const all = Object.values(stored).flat();
      expect(Object.keys(stored).some(n => /precache/i.test(n)), `a precache exists (caches: ${Object.keys(stored).join(', ')})`).toBe(true);
      expect(all.some(u => /\/index\.html/.test(u)), 'the HTML shell is cached').toBe(true);
      expect(all.filter(u => /\/api\//.test(u)), 'API responses must never be cached').toEqual([]);
      const { assets } = await shell(request);
      for (const asset of assets) expect(all.some(u => u.includes(asset)), `${asset} is cached`).toBe(true);
    });

    test('an API GET is never answered from a cache: a record created after the first read shows up on the second', async ({ page, request }) => {
      const hr = await getToken(request, 'hr');
      await loginViaApi(page, 'hr');
      await waitForServiceWorkerControl(page);
      const name = `PW Pwa ${stamp}`;
      const apiBase = process.env.TEST_API_URL || 'http://localhost:4000';
      const read = () => page.evaluate(async ({ url, token }) => {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        return (await r.json()) as { candidates: Array<{ full_name: string }> };
      }, { url: `${apiBase}/api/candidates?q=${encodeURIComponent(name)}`, token: hr });

      expect((await read()).candidates, 'nothing matches before the record exists').toHaveLength(0);
      const { candidate, res } = await createCandidate(request, hr, { full_name: name });
      expect(res.status()).toBe(201);
      candidateIds.push(candidate.id);
      expect((await read()).candidates.map(c => c.full_name), 'the second read must see the new record, not a cached copy of the first').toEqual([name]);
    });

    test('offline: the app shell still opens from the precache, but API data is not served from any cache', async ({ page, context }) => {
      await loginViaApi(page, 'hr');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      await waitForServiceWorkerControl(page);
      await page.waitForLoadState('networkidle');

      await context.setOffline(true);
      const apiBase = process.env.TEST_API_URL || 'http://localhost:4000';
      const token = await page.evaluate(() => localStorage.getItem('hms_token'));
      const outcome = await page.evaluate(async ({ url, token }) => {
        try { const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); return `served (${r.status})`; } catch { return 'network error'; }
      }, { url: `${apiBase}/api/roles`, token });
      expect(outcome, 'a GET /api while offline must fail, not be answered from a cache').toBe('network error');

      await page.goto(`${FRONTEND_BASE}/roles`);                                              // a navigation: the worker answers with the precached shell
      await expect(page).toHaveTitle(/Hiring Master System/);
      await expect(page.locator('#root')).not.toBeEmpty();
      await context.setOffline(false);
    });
  });
});

// ── Info markers on touch ────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('info markers on a touch screen', () => {
  // InfoTooltip opens on mouseenter AND toggles on click. A tap fires both, in that order: the emulated mouseenter opens the popover and the
  // click then toggles it shut, so the FIRST tap shows nothing; the second tap (the pointer is already "inside") toggles it open.
  // Measured with real touch events (touchstart, touchend, mouseover, mouseenter, mousedown, mouseup, click): closed / open / closed.
  // When a marker opens on the first tap, this test fails: rename it and assert that.
  test('TODAY: the first tap on an info marker leaves its popover closed, the second opens it, the third closes it, and a tap elsewhere closes an open one', async ({ page }) => {
    await loginViaApi(page, 'hr');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    const marker: Locator = infoMarkers(page.locator('main')).first();
    const popover = markerPopover(marker);

    await marker.tap();
    await expect(popover, 'TODAY: a first tap does not show the popover').toHaveCount(0);
    await marker.tap();
    await expect(popover, 'a second tap shows it').toBeVisible();
    await marker.tap();
    await expect(popover, 'a third tap hides it again').toHaveCount(0);

    await marker.tap();
    await expect(popover).toBeVisible();
    await heading.tap();                                                                       // a tap anywhere else closes an open popover
    await expect(popover).toHaveCount(0);
  });
});
