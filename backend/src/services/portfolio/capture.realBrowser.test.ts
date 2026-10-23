import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import net from 'net';
import { withBrowser } from './browser.js';
import { capturePortfolios, browserOptionsFor, DESIGNER_CAPTURE_OPTS, MARKETING_CAPTURE_OPTS, type CaptureOptions } from './capture.js';
import type { PortfolioLink } from './types.js';

// OPT-IN: runs a real Chromium, so it is skipped unless PORTFOLIO_REAL_BROWSER_TEST=1 (it launches PORTFOLIO_CHROME_PATH, or a Chrome
// found on the machine, exactly as local development does). Nothing leaves the machine: the "candidate's site" and the "internal
// service" are two local listeners.
//
// What it proves, through the REAL withBrowser + capturePortfolios, that a hostile page never gets a request to the "internal service"
// — and that the SAME page does reach it when the designer review's launch is used (the positive control: without it a pass could just
// mean the harness sees nothing). Two families:
//  1. Popups (2026-10-22): window.open, a target=_blank link, a target=_blank form, a timer that keeps calling window.open, a page that
//     hooks what our own reads call so that they hand it a user gesture.
//  2. Teardown (2026-10-23): what a page starts while its document goes away — pagehide / visibilitychange / beforeunload / unload
//     handlers starting a keepalive fetch, a beacon and an image (also from a cross-site iframe, which is its own browser target in
//     desktop Chrome); a request still waiting for the SSRF check when the capture ends; a script-clicked `<a ping>` that keeps coming
//     while the page is closed. And that the guard costs nothing: a later page still runs its own scripts and still gets the
//     realtime-API lockdown.
//
// Measured, 2026-10-22 and 2026-10-23, desktop Chrome (Brave 145, headless) AND the Lambda headless shell (the compiled code run in
// public.ecr.aws/lambda/nodejs:22 with @sparticuz/chromium, as on Vercel). The two builds need different launch changes (see
// BrowserOptions in browser.ts) and this file can only drive the desktop one, so a pass here is NOT proof for production: repeat the
// check against the Lambda image after touching the launch arguments or the teardown guard (the runbook's Lambda-image check
// covers the popup vectors; the teardown vectors below were run in that image with the same harness, 2026-10-23, and are not in the
// runbook's script yet). The positive controls need a desktop Chrome with site isolation (the cross-site iframe
// one) and Chrome's hyperlink auditing on (the ping one); a Chromium without them makes those controls fail, not the review pass.

const h = vi.hoisted(() => ({ siteOrigin: '', siteOrigin2: '', internalOrigin: '', neverAnswer: false }));
vi.mock('./urlSafety.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./urlSafety.js')>();
  const isSite = (u: string) => (h.siteOrigin !== '' && u.startsWith(h.siteOrigin)) || (h.siteOrigin2 !== '' && u.startsWith(h.siteOrigin2));
  return {
    ...real,
    // The candidate's own origin counts as public for this test; everything else, the internal listener included, is judged by the real checks.
    assertSafePublicUrl: async (u: string) => (isSite(u) ? new URL(u) : real.assertSafePublicUrl(u)),
    makeHostChecker: () => {
      const check = real.makeHostChecker();
      return async (u: string) => {
        if (isSite(u)) return true;
        // A DNS lookup that never finishes, as the filter sees it: the request stays paused in the interception until the page is gone.
        if (h.neverAnswer && h.internalOrigin !== '' && u.startsWith(h.internalOrigin)) return new Promise<boolean>(() => {});
        return check(u);
      };
    },
  };
});

const run = process.env.PORTFOLIO_REAL_BROWSER_TEST === '1';

const VECTORS: Record<string, (internal: string) => string> = {
  'window.open, a target=_blank link and a target=_blank form, all at load': (i) => `
    try { window.open('${i}/via-window-open', '_blank'); } catch (e) {}
    const a = document.createElement('a'); a.href = '${i}/via-anchor'; a.target = '_blank'; document.body.appendChild(a); try { a.click(); } catch (e) {}
    const f = document.createElement('form'); f.action = '${i}/via-form'; f.target = '_blank'; document.body.appendChild(f); try { f.submit(); } catch (e) {}`,
  'a timer that keeps calling window.open (any user gesture we grant would be used)': (i) => `
    let n = 0; const t = setInterval(() => { try { window.open('${i}/poll-' + (n++), '_blank'); } catch (e) {} if (n > 60) clearInterval(t); }, 250);`,
  'a page that hooks scrollTo and innerText, which our reads call': (i) => `
    const go = () => { try { window.open('${i}/hijack', '_blank'); } catch (e) {} };
    const scroll = window.scrollTo.bind(window); window.scrollTo = function () { go(); return scroll.apply(null, arguments); };
    Object.defineProperty(document.body, 'innerText', { get() { go(); return 'Portfolio text'; } });`,
};

interface Scripts {
  home: (internal: string, site2: string) => string;
  page2?: (internal: string, site2: string) => string;     // the page the home page links to, which the crawl opens next
  frame?: (internal: string) => string;                     // /frame, for an iframe the home page embeds
  everyPath?: boolean;                                      // the home script runs on every path (a navigation loop)
}
interface Visit { hits: string[]; pages: number; access: string; texts: string[]; ms: number }

async function visit(scripts: Scripts, opts: Readonly<CaptureOptions>, o: { neverAnswer?: boolean } = {}): Promise<Visit> {
  const hits: string[] = [];
  const internal = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', d => { hits.push(d.toString('latin1').split('\r\n')[0].replace(/ HTTP.*/, '')); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); });
  });
  await new Promise<void>(r => internal.listen(0, '127.0.0.1', r));
  const internalOrigin = `http://127.0.0.1:${(internal.address() as net.AddressInfo).port}`;
  let site2 = '';
  const site = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('content-type', 'text/html');
    const body = path === '/frame' ? `<p>frame</p><script>${scripts.frame?.(internalOrigin) ?? ''}</script>`
      : path === '/' || scripts.everyPath ? `<h1>Portfolio</h1><p>${'Brand work. '.repeat(40)}</p><a href="/p2">next</a><script>${scripts.home(internalOrigin, site2)}</script>`
      : `<h1>Second page</h1><p>${'More brand work. '.repeat(40)}</p><script>${scripts.page2?.(internalOrigin, site2) ?? ''}</script>`;
    res.end(`<html><head><title>Portfolio ${path}</title></head><body style="height:3000px">${body}</body></html>`);
  });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  h.siteOrigin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  h.siteOrigin2 = h.siteOrigin.replace('127.0.0.1', 'localhost');     // a different site to Chrome: a cross-site iframe is its own target
  site2 = h.siteOrigin2;
  h.internalOrigin = internalOrigin;
  h.neverAnswer = !!o.neverAnswer;
  const link: PortfolioLink = { url: `${h.siteOrigin}/`, host: '127.0.0.1', platform: 'custom', handler: 'site' };
  const started = Date.now();
  try {
    const [r] = await withBrowser(b => capturePortfolios(b, [link], Date.now() + 100_000, opts), browserOptionsFor(opts));
    await new Promise(r2 => setTimeout(r2, 800));     // a request the page started late still counts
    return { hits: hits.filter(x => !/favicon/.test(x)), pages: r.pages.length, access: r.access, texts: r.pages.map(p => p.text), ms: Date.now() - started };
  } finally {
    internal.close(); site.close(); h.siteOrigin = ''; h.siteOrigin2 = ''; h.internalOrigin = ''; h.neverAnswer = false;
  }
}

const popup = (script: (internal: string) => string): Scripts => ({ home: i => script(i) });

describe.skipIf(!run)('real Chromium: a popup never reaches an internal address', () => {
  it.each(Object.entries(VECTORS))('marketing review: %s', async (_name, script) => {
    const r = await visit(popup(script), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.pages).toBeGreaterThan(0);              // the page was really read
    expect(r.hits).toEqual([]);
  }, 150_000);

  it('positive control: the same page DOES reach the listener under the designer review launch (so a pass above means something)', async () => {
    const r = await visit(popup(Object.values(VECTORS)[0]), DESIGNER_CAPTURE_OPTS);
    expect(r.pages).toBeGreaterThan(0);
    expect(r.hits.length).toBeGreaterThan(0);
  }, 150_000);
});

// What a hostile page registers to run when its document goes away, and what each handler starts.
const UNLOAD_HANDLERS = (i: string) => `
  for (const ev of ['pagehide', 'visibilitychange', 'beforeunload', 'unload']) addEventListener(ev, () => {
    const t = (location.pathname.replace(/\\W/g, '') || 'root') + '-' + ev;
    try { fetch('${i}/keepalive-' + t, { keepalive: true, mode: 'no-cors' }); } catch (e) {}
    try { navigator.sendBeacon('${i}/beacon-' + t, 'x'); } catch (e) {}
    try { new Image().src = '${i}/image-' + t; } catch (e) {}
  });`;

// One of each, at load, to a verdict that never comes (the filter's DNS lookup for an attacker-named host that resolves slowly).
const ONE_OF_EACH = (i: string) => `
  try { new Image().src = '${i}/waiting-image'; } catch (e) {}
  try { fetch('${i}/waiting-fetch', { mode: 'no-cors' }).catch(() => {}); } catch (e) {}
  try { navigator.sendBeacon('${i}/waiting-beacon', 'x'); } catch (e) {}
  try { fetch('${i}/waiting-keepalive', { keepalive: true, mode: 'no-cors' }).catch(() => {}); } catch (e) {}`;

// The reviewer's ping vector: a script click on an <a ping> that navigates, on every document of a loop, so the page is mid-navigation
// when it is closed. (A click on a quiet page is intercepted like any request and shows nothing.)
const PING_LOOP = (i: string) => `
  const a = document.createElement('a'); a.href = '/x'; a.ping = '${i}/audit-ping'; document.body.appendChild(a); a.click();`;

const TEARDOWN: Array<{ name: string; scripts: Scripts; neverAnswer?: boolean }> = [
  { name: 'pagehide / visibilitychange / beforeunload / unload handlers start a keepalive fetch, a beacon and an image (on the page and on the one it links to)',
    scripts: { home: UNLOAD_HANDLERS, page2: UNLOAD_HANDLERS } },
  { name: 'the same handlers in a cross-site iframe (its own browser target in desktop Chrome)',
    scripts: { home: (_i, site2) => `document.body.insertAdjacentHTML('beforeend', '<iframe src="${site2}/frame"></iframe>');`, frame: UNLOAD_HANDLERS } },
  { name: 'requests the SSRF check has not answered when the capture ends: an image, a fetch, an XHR-less beacon and a keepalive fetch',
    scripts: { home: ONE_OF_EACH }, neverAnswer: true },
  { name: 'a script-clicked <a ping> on every document of a navigation loop, so the page is mid-navigation when it is closed',
    scripts: { home: PING_LOOP, everyPath: true } },
];

describe.skipIf(!run)('real Chromium: nothing a page starts while its document goes away reaches an internal address', () => {
  it.each(TEARDOWN)('marketing review: $name', async ({ scripts, neverAnswer }) => {
    const r = await visit(scripts, MARKETING_CAPTURE_OPTS, { neverAnswer });
    expect(['ok', 'blocked', 'error']).toContain(r.access);    // the ping loop never settles into a page: what counts is the listener
    expect(r.hits).toEqual([]);
  }, 200_000);

  it.each(TEARDOWN)('positive control, designer review launch: $name', async ({ scripts, neverAnswer }) => {
    // What a page starts during the close races with the close (one full run in four of the unload control showed nothing), so a control may
    // need another go; a page that never reaches the listener in 3 goes is not a control.
    let hits: string[] = [];
    for (let i = 0; i < 3 && hits.length === 0; i++) hits = (await visit(scripts, DESIGNER_CAPTURE_OPTS, { neverAnswer })).hits;
    expect(hits.length).toBeGreaterThan(0);
  }, 400_000);

  it('a page that navigates ITSELF (location.href) with unload handlers: nothing reaches the listener either (the page is still open, so the filter sees it)', async () => {
    const r = await visit({
      home: i => `${UNLOAD_HANDLERS(i)} if (!location.search) setTimeout(() => { location.href = '/p2?self=1'; }, 300);`,
      page2: UNLOAD_HANDLERS,
    }, MARKETING_CAPTURE_OPTS);
    expect(r.hits).toEqual([]);
  }, 200_000);

  it('the guard costs nothing: a later page still runs its own scripts and still gets the realtime-API lockdown', async () => {
    const r = await visit({
      home: () => `document.body.insertAdjacentHTML('beforeend', '<p>script-rendered-on-page-one</p>');`,
      page2: i => `
        document.body.insertAdjacentHTML('beforeend', '<p>script-rendered-on-page-two</p>');
        let socket = 'opened';
        try { new WebSocket('${i.replace('http', 'ws')}/socket'); } catch (e) { socket = e.name; }
        document.body.insertAdjacentHTML('beforeend', '<p>websocket-' + socket + '</p>');`,
    }, MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.texts).toHaveLength(2);
    expect(r.texts[0]).toContain('script-rendered-on-page-one');
    expect(r.texts[1]).toContain('script-rendered-on-page-two');
    expect(r.texts[1]).toContain('websocket-SecurityError');       // the lockdown script is installed on the second document too
    expect(r.hits).toEqual([]);
  }, 200_000);
});
