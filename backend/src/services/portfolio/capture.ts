// WORKER-ONLY (see browser.ts). Walks a candidate's portfolio site(s) in a real
// browser and collects (a) screenshots + text a vision model can judge and
// (b) hard, deterministic measurements a model shouldn't be guessing at.
/// <reference lib="dom" />
// (page.evaluate callbacks execute inside the browser, so they need DOM typings)
import type { Browser, Page } from 'puppeteer-core';
import { PortfolioLink, PortfolioSignals } from './types.js';
import { assertSafePublicUrl, makeHostChecker, safeFetch } from './urlSafety.js';
import { wellFormed } from './text.js';

export interface Shot { label: string; data: string }   // base64 JPEG
export interface CapturedPage { url: string; title: string; text: string; shots: Shot[] }
export interface CapturedPortfolio {
  link:       PortfolioLink;
  // ok      — opened and read
  // blocked — the candidate's own link doesn't work for a stranger (private
  //           Figma, 404, login wall): held against the candidate
  // error   — our side failed (timeout, browser crash): retryable, NOT held
  //           against the candidate
  // skipped — a file/slide-deck link we don't render automatically
  access:     'ok' | 'blocked' | 'error' | 'skipped';
  accessNote?: string;
  pages:      CapturedPage[];
  mobileShot?: Shot;
  signals:    PortfolioSignals;
}

const DESKTOP = { width: 1280, height: 800 };
const MOBILE  = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const NAV_TIMEOUT_MS = 25_000;
const MAX_PAGES_PER_PORTFOLIO = 6;   // home + up to 3 internal + up to 2 outbound case studies
const TEXT_LIMIT = 4500;
const MAX_LINKS_TO_CHECK = 25;
const BOT_HOSTILE = /(^|\.)(linkedin\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|lnkd\.in)$/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>(r => { timer = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(timer));
};

// Hard ceiling for one portfolio, whatever it is doing. A single stalled CDP
// call (e.g. a screenshot of Figma's WebGL canvas under software rendering)
// must not be able to eat the whole function budget.
const PER_PORTFOLIO_CAP_MS = 100_000;

function emptySignals(): PortfolioSignals {
  return {
    brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0,
    failedRequests: 0, mobileOverflow: null, loadMs: null, truncated: false,
  };
}

// ─── Access-wall detection ───────────────────────────────────────────────────
export function detectAccessProblem(
  status: number | null, finalUrl: string, text: string,
): { kind: 'blocked' | 'error'; note: string } | null {
  if (status === 401 || status === 403) return { kind: 'blocked', note: `Requires login or permission (HTTP ${status})` };
  if (status === 404 || status === 410) return { kind: 'blocked', note: `Page not found (HTTP ${status})` };
  if (status && status >= 500) return { kind: 'error', note: `Site returned HTTP ${status}` };
  if (/figma\.com\/(login|signup)/i.test(finalUrl)) return { kind: 'blocked', note: 'Figma file is private — sign-in required' };
  const t = text.trim().toLowerCase();
  if (t.length < 700) {
    if (/(request access|you need access|access denied|this (file|page|project) is private|sign in to (view|continue)|log in to (view|continue))/.test(t)) {
      return { kind: 'blocked', note: 'Portfolio is private or requires access' };
    }
    if (/(page not found|404|nothing here|couldn.t find that page)/.test(t)) {
      return { kind: 'blocked', note: 'Page not found' };
    }
  }
  return null;
}

/**
 * A site that won't load is either genuinely dead (the candidate's problem — a
 * broken portfolio link IS a finding) or our browser was refused/timed out
 * (our problem — must not count against them). A plain server-side request
 * that fails the same way is what tells the two apart.
 */
export async function classifyLoadFailure(
  message: string, url: string,
): Promise<{ kind: 'blocked' | 'error'; note: string }> {
  const connectionLevel = /ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_CLOSED|CONNECTION_RESET|SSL_|CERT_|ADDRESS_UNREACHABLE)/.test(message);
  const timedOut = /Navigation timeout|ERR_TIMED_OUT/i.test(message);
  if (!connectionLevel && !timedOut) return { kind: 'error', note: `Could not load the site (${message.slice(0, 80)})` };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    await safeFetch(url, { method: 'GET', signal: ctl.signal, headers: { 'user-agent': UA } });
    return { kind: 'error', note: 'Site responds to normal requests but not to our browser' };
  } catch (e) {
    // Aborted = merely slow (ambiguous, so retryable). A real network error
    // (DNS/TLS/reset) from a plain request too means the site is genuinely dead.
    if ((e as Error).name === 'AbortError') return { kind: 'error', note: 'Site did not respond in time' };
    return { kind: 'blocked', note: 'Site is unreachable (connection failed) — the portfolio link appears to be dead' };
  } finally { clearTimeout(t); }
}

// ─── Page helpers ────────────────────────────────────────────────────────────
async function settleAndScroll(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 6000 }).catch(() => {});
  // Scroll top-to-bottom so lazy-loaded images and scroll-triggered reveals
  // (very common on Framer/Webflow) actually render before we screenshot.
  await withTimeout(page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    const max = Math.min(document.documentElement.scrollHeight, 9000);
    for (let y = 0; y < max; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 160)); }
    window.scrollTo(0, 0);
  }), 9000, undefined).catch(() => {});
  await sleep(350);
}

async function shoot(page: Page, label: string): Promise<Shot | null> {
  try {
    const buf = await withTimeout(page.screenshot({ type: 'jpeg', quality: 68 }), 20_000, null);
    return buf ? { label, data: Buffer.from(buf).toString('base64') } : null;
  } catch { return null; }
}

async function pageText(page: Page): Promise<string> {
  const t = await withTimeout(page.evaluate(() => document.body?.innerText || ''), 5000, '');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_LIMIT);
}

async function scrollSlices(page: Page, labelBase: string, maxSlices: number): Promise<Shot[]> {
  const height: number = await withTimeout(page.evaluate(() => document.documentElement.scrollHeight), 3000, DESKTOP.height);
  const ys = [0];
  if (maxSlices >= 2 && height > DESKTOP.height * 1.5) ys.push(Math.round(height * 0.4));
  if (maxSlices >= 3 && height > DESKTOP.height * 3) ys.push(Math.round(height * 0.75));
  const shots: Shot[] = [];
  for (let i = 0; i < ys.length; i++) {
    await page.evaluate((y: number) => window.scrollTo(0, y), ys[i]).catch(() => {});
    await sleep(350);
    const s = await shoot(page, `${labelBase} — screenshot ${i + 1}/${ys.length}${ys[i] ? ` (scrolled to ${Math.round((ys[i] / height) * 100)}% of page)` : ' (top of page)'}`);
    if (s) shots.push(s);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return shots;
}

interface Anchor { href: string; text: string }
async function collectAnchors(page: Page): Promise<Anchor[]> {
  return withTimeout(page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => ({
      href: (a as HTMLAnchorElement).href, text: (a.textContent || '').trim().slice(0, 60),
    }))), 5000, []);
}

const ASSET_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|zip|mp4|mov|webm|ico|css|js)(\?|$)/i;
const WORK_HINT = /(work|project|case|stud|portfolio|gallery|product|app|design|dashboard|system|ux|ui|research)/i;

export function pickInternalPages(anchors: Anchor[], currentUrl: string, visited: Set<string>, max: number): string[] {
  let base: URL;
  try { base = new URL(currentUrl); } catch { return []; }
  const baseHost = base.hostname.replace(/^www\./, '');
  const scored = new Map<string, number>();
  for (const a of anchors) {
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.hostname.replace(/^www\./, '') !== baseHost) continue;
    u.hash = '';
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (visited.has(key) || key === base.origin + base.pathname.replace(/\/$/, '')) continue;
    if (ASSET_EXT.test(u.pathname) || u.pathname === '/' || u.pathname === '') continue;
    const depth = u.pathname.split('/').filter(Boolean).length;
    const score = (WORK_HINT.test(u.pathname) ? 2 : 0) + (WORK_HINT.test(a.text) ? 1 : 0) + (depth >= 2 ? 1 : 0);
    scored.set(u.toString(), Math.max(scored.get(u.toString()) ?? -1, score));
  }
  return [...scored.entries()].sort((x, y) => y[1] - x[1]).slice(0, max).map(([u]) => u);
}

// Portfolio sites very often host only a landing page and link OUT to where the
// case studies actually live (a Figma prototype, a Behance project, a Notion
// page). Following a couple of those is the difference between reviewing a
// cover page and reviewing the work. Restricted to platforms that are
// genuinely case-study hosts so this can't wander off to arbitrary sites.
const CASE_STUDY_HOSTS = /(^|\.)(figma\.com|behance\.net|notion\.site|notion\.so|medium\.com|canva\.com|slideshare\.net)$/i;
const MAX_EXTERNAL_PAGES = 2;

export function pickExternalCaseStudies(anchors: Anchor[], currentUrl: string, visited: Set<string>, max = MAX_EXTERNAL_PAGES): string[] {
  let base: URL;
  try { base = new URL(currentUrl); } catch { return []; }
  const baseHost = base.hostname.replace(/^www\./, '');
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const host = u.hostname.replace(/^www\./, '');
    if (host === baseHost || !CASE_STUDY_HOSTS.test(host)) continue;
    // Only content pages — not a platform's homepage, login or marketing pages.
    if (/(^|\.)figma\.com$/.test(host) && !/^\/(proto|design|file|board|deck|slides|make)\//.test(u.pathname)) continue;
    if (/(^|\.)behance\.net$/.test(host) && !/^\/gallery\//.test(u.pathname) && u.pathname.split('/').filter(Boolean).length < 1) continue;
    if (/(^|\.)medium\.com$/.test(host) && u.pathname.split('/').filter(Boolean).length < 2) continue;
    u.hash = '';
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (visited.has(key) || seen.has(key)) continue;
    seen.add(key);
    picked.push(u.toString());
    if (picked.length >= max) break;
  }
  return picked;
}

// ─── Outbound link health (server-side, not through the browser) ────────────
async function checkLink(url: string): Promise<'ok' | 'broken' | 'unknown'> {
  // safeFetch re-validates the target on EVERY redirect hop — a public link
  // that 302s to an internal address must not be followed.
  const attempt = async (method: 'HEAD' | 'GET') => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      return await safeFetch(url, { method, signal: ctl.signal, headers: { 'user-agent': UA } });
    } finally { clearTimeout(t); }
  };
  try {
    // Plenty of servers (Figma among them) answer HEAD with a 404 they'd never
    // give a real visitor — always re-ask with GET before judging.
    let res = await attempt('HEAD');
    if (res.status >= 400) res = await attempt('GET');
    if (res.status === 404 || res.status === 410 || res.status >= 500) return 'broken';
    return 'ok';
  } catch (e) {
    // A name that doesn't exist IS a dead link; anything else (timeouts, TLS
    // quirks, an unsafe redirect target) from OUR network isn't proof of one.
    return /does not resolve/.test((e as Error).message) ? 'broken' : 'unknown';
  }
}

async function checkLinks(urls: string[]): Promise<{ checked: number; broken: string[] }> {
  const queue = [...urls];
  const broken: string[] = [];   // suspects — confirmed in a real browser by the caller
  let checked = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const u = queue.shift()!;
      const r = await checkLink(u);
      if (r !== 'unknown') checked++;
      if (r === 'broken') broken.push(u);
    }
  }));
  return { checked, broken };
}

// ─── One portfolio ───────────────────────────────────────────────────────────
interface CaptureHandle { page?: Page }

async function capturePortfolio(
  browser: Browser, link: PortfolioLink, deadline: number, out: CapturedPortfolio, handle: CaptureHandle,
): Promise<void> {

  if (link.platform === 'pdf_file' || link.platform === 'google_slides') {
    out.access = 'skipped';
    out.accessNote = 'File / slide-deck link — not opened automatically; review manually';
    return;
  }

  try { await assertSafePublicUrl(link.url); }
  catch (e) { out.access = 'blocked'; out.accessNote = `Link not safe or not resolvable (${(e as Error).message})`; return; }

  // Plain pages on the default context, NOT browser.createBrowserContext():
  // the Lambda build of Chromium runs single-process, and creating an isolated
  // context there kills the browser ("Target closed") — found by running this
  // code in the AWS Lambda Node 22 image, invisible on a desktop Chrome.
  const page = await browser.newPage();
  handle.page = page;
  try {
    await page.setUserAgent(UA);
    await page.setViewport(DESKTOP);
    await page.setRequestInterception(true);
    // Every request the page makes — sub-resources and redirects included — is
    // checked against the DNS-resolved address, not just string-matched: a
    // public-looking hostname can point at an internal one.
    const hostIsPublic = makeHostChecker();
    page.on('request', async req => {
      try {
        if (req.resourceType() === 'media') return void req.abort('blockedbyclient');  // autoplay video is heavy and unreadable
        if (!(await hostIsPublic(req.url()))) return void req.abort('blockedbyclient');
        void req.continue();
      } catch { void req.abort('failed').catch(() => {}); }
    });
    page.on('console', m => { if (m.type() === 'error') out.signals.consoleErrors++; });
    page.on('requestfailed', r => {
      if (r.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') out.signals.failedRequests++;
    });

    const visited = new Set<string>();
    const allAnchors: Anchor[] = [];
    const queue: string[] = [link.url];
    const started = Date.now();

    while (queue.length && out.pages.length < MAX_PAGES_PER_PORTFOLIO) {
      if (deadline - Date.now() < 25_000) { out.signals.truncated = true; break; }
      const target = queue.shift()!;
      let status: number | null = null;
      try {
        const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        status = resp?.status() ?? null;
      } catch (e) {
        if (out.pages.length === 0) {
          const failure = await classifyLoadFailure((e as Error).message, target);
          out.access = failure.kind;
          out.accessNote = failure.note;
          break;
        }
        continue;   // a later page failing to load isn't fatal
      }
      if (out.pages.length === 0) out.signals.loadMs = Date.now() - started;

      // Figma's canvas needs real time to draw before there is anything to see.
      if (link.platform === 'figma_file' || /(^|\.)figma\.com$/.test(new URL(target).hostname)) await sleep(7000);
      await settleAndScroll(page);

      const text = await pageText(page);
      const problem = detectAccessProblem(status, page.url(), text);
      if (problem && out.pages.length === 0) { out.access = problem.kind; out.accessNote = problem.note; break; }
      if (problem) continue;

      const isHome = out.pages.length === 0;
      const title = wellFormed(((await withTimeout(page.title(), 2000, '')) || target).slice(0, 200));
      const shots = await scrollSlices(page, isHome ? 'Home page' : `Page: ${wellFormed(title.slice(0, 50))}`, isHome ? 3 : 2);
      out.pages.push({ url: page.url(), title, text, shots });
      const key = (() => { const u = new URL(page.url()); u.hash = ''; return u.origin + u.pathname.replace(/\/$/, ''); })();
      visited.add(key);

      const anchors = await collectAnchors(page);
      allAnchors.push(...anchors);
      // Canvas/gallery platforms have no crawlable page structure worth following.
      if (isHome && link.platform !== 'figma_file') {
        queue.push(...pickInternalPages(anchors, page.url(), visited, 3));
        queue.push(...pickExternalCaseStudies(anchors, page.url(), visited));
      }
    }

    if (out.access === 'ok' && out.pages.length === 0) {
      out.access = 'error';
      out.accessNote = out.accessNote || 'No page content could be read';
    }

    // Mobile rendering — a hiring-manager criterion (display artifacts) and
    // relevant to a role that designs for phones.
    if (out.access === 'ok' && link.platform !== 'figma_file' && deadline - Date.now() > 20_000) {
      try {
        await page.setViewport(MOBILE);
        await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForNetworkIdle({ idleTime: 600, timeout: 4000 }).catch(() => {});
        out.signals.mobileOverflow = await withTimeout(
          page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 8), 3000, null as boolean | null);
        const s = await shoot(page, 'Home page at phone width (390px)');
        if (s) out.mobileShot = s;
      } catch { /* mobile check is best-effort */ }
    }

    // Outbound link health across everything we crawled.
    if (out.access === 'ok' && deadline - Date.now() > 15_000) {
      const uniq = new Set<string>();
      for (const a of allAnchors) {
        let u: URL;
        try { u = new URL(a.href); } catch { continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (BOT_HOSTILE.test(u.hostname)) continue;
        u.hash = '';
        uniq.add(u.toString());
        if (uniq.size >= MAX_LINKS_TO_CHECK) break;
      }
      const res = await withTimeout(checkLinks([...uniq]), 15_000, { checked: 0, broken: [] as string[] });
      // A server-side probe can be wrong (bot walls, JS-only apps); only count a
      // link as broken if a real browser can't open it either.
      const confirmed: string[] = [];
      for (const u of res.broken.slice(0, 4)) {
        if (deadline - Date.now() < 12_000) break;
        try {
          const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if ((r?.status() ?? 0) >= 400) confirmed.push(u);
        } catch (e) {
          if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CERT|ERR_SSL/.test((e as Error).message)) confirmed.push(u);
        }
      }
      out.signals.brokenLinksChecked = res.checked;
      out.signals.brokenLinks = confirmed.length;
      out.signals.brokenLinkSamples = confirmed.slice(0, 3).map(u => u.length > 100 ? `${u.slice(0, 100)}…` : u);
    }
  } catch (e) {
    if (out.pages.length === 0) { out.access = 'error'; out.accessNote = `Capture failed (${(e as Error).message.slice(0, 80)})`; }
  } finally {
    await page.close().catch(() => {});
  }
}

export async function capturePortfolios(browser: Browser, links: PortfolioLink[], deadline: number): Promise<CapturedPortfolio[]> {
  const results: CapturedPortfolio[] = [];
  for (const link of links) {
    const out: CapturedPortfolio = { link, access: 'ok', pages: [], signals: emptySignals() };
    results.push(out);
    if (deadline - Date.now() < 30_000) {
      out.access = 'error';
      out.accessNote = 'Time budget exhausted before this portfolio could be opened';
      out.signals.truncated = true;
      continue;
    }
    const handle: CaptureHandle = {};
    const cap = Math.max(20_000, Math.min(deadline - Date.now() - 5_000, PER_PORTFOLIO_CAP_MS));
    let timer: NodeJS.Timeout;
    const timedOut = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), cap); });
    const inner = capturePortfolio(browser, link, deadline, out, handle).then(() => 'done' as const, (e: Error) => {
      // e.g. browser.newPage() failing — OUR failure, so it must not be scored against the candidate.
      if (!out.pages.length) { out.access = 'error'; out.accessNote = `Capture failed (${String(e?.message || e).slice(0, 80)})`; }
      return 'done' as const;
    });
    const outcome = await Promise.race([inner, timedOut]);
    clearTimeout(timer!);
    if (outcome === 'timeout') {
      // Keep whatever was captured so far; closing the page makes the
      // abandoned work fail fast instead of lingering on the shared browser.
      out.signals.truncated = true;
      if (!out.pages.length) { out.access = 'error'; out.accessNote = 'Time budget exceeded while loading the site'; }
      await handle.page?.close().catch(() => {});
    }
  }
  return results;
}
