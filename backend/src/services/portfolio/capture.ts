// WORKER-ONLY (see browser.ts). Walks a candidate's portfolio site(s) in a real
// browser and collects (a) screenshots + text a vision model can judge and
// (b) hard, deterministic measurements a model shouldn't be guessing at.
/// <reference lib="dom" />
// (page.evaluate callbacks execute inside the browser, so they need DOM typings)
import type { Browser, CDPSession, HTTPRequest, Page, Target } from 'puppeteer-core';
import { BLOCK_NEW_WEB_CONTENTS_FLAG, type BrowserOptions } from './browser.js';
import { PortfolioLink, PortfolioSignals } from './types.js';
import { assertSafePublicUrl, makeHostChecker, safeFetch } from './urlSafety.js';
import { wellFormed } from './text.js';

export interface Shot { label: string; data: string }   // base64 JPEG
export interface CapturedPage { url: string; title: string; text: string; shots: Shot[] }
export interface CapturedPortfolio {
  link:       PortfolioLink;
  // ok           — opened and read
  // blocked      — the candidate's own link doesn't work for a stranger (private
  //                Figma, 404, login wall): held against the candidate
  // error        — our side failed (timeout, browser crash): retryable, NOT held
  //                against the candidate
  // skipped      — a file/slide-deck link we don't render automatically
  // unreviewable — neutral: a bot check (Cloudflare/captcha) we cannot pass, or a
  //                Canva link that rendered nothing. NOT held against the candidate
  //                and NOT retried (a second attempt meets the same wall)
  access:     'ok' | 'blocked' | 'error' | 'skipped' | 'unreviewable';
  accessNote?: string;
  // Only with access 'ok': it opened, but shows just part of the work (a Canva
  // view link renders the first screens only), so absence of evidence is weak.
  partial?:   boolean;
  pages:      CapturedPage[];
  mobileShot?: Shot;
  signals:    PortfolioSignals;
}

// What one capture looks at. The designer review wants the whole portfolio as a
// product (phone-width render, link audit); the marketing review wants the words.
export interface CaptureOptions {
  maxPages:    number;    // pages crawled per site: the home page + internal pages + outbound case studies
  mobileCheck: boolean;   // extra phone-width render and horizontal-overflow measurement
  linkHealth:  boolean;   // server-side broken-link probe over everything crawled
  textLimit:   number;    // characters of visible text kept per page
  // Canva handling (see classifyCanva): a view link that rendered something is 'ok' but `partial`, one that rendered
  // nothing is 'unreviewable', and a redirect to Canva's sign-in page is 'blocked'. Marketing only — the designer review
  // treats canva.com like any other site, exactly as it did before this existed.
  canvaPartial: boolean;
  // Install the realtime-API lockdown (see lockdownScript) before any navigation: WebSocket, EventSource, WebTransport and
  // RTCPeerConnection are never shown to the SSRF request filter. Marketing only (see the note at the option constants).
  lockdown: boolean;
  // Inside the lockdown, also take Worker / SharedWorker / service-worker registration away from the page: a worker is the one
  // way left to open a WebSocket. Marketing only — meaningless without `lockdown`.
  blockWorkers: boolean;
  // Popups: a page script can open new page targets (window.open, target=_blank links and forms) that the per-page request filter
  // never sees. With this on, withBrowser launches Chromium with its popup blocker on (`browserOptionsFor`) and the capture closes
  // any extra page target the moment it appears. Marketing only (see the note at the option constants).
  blockPopups: boolean;
  // Teardown: what a page starts while its document goes away (pagehide / visibilitychange / unload handlers) and every request the filter
  // has not answered yet when it does, can leave through the browser process around the request filter. With this on, the capture switches
  // the page's scripts off and answers every waiting request before it closes the page and before each later navigation of the same
  // page (see makeTeardownGuard). Marketing only; the designer teardown is exactly `page.close()`.
  guardTeardown: boolean;
  // A site whose pages were not all opened (the crawl is capped at maxPages, a later page failed, the time ran out) is `partial`, so
  // "the candidate's name is not on this site" is never claimed from a part of it. Marketing only: nothing downstream of the designer
  // review reads `partial`, and its output must not change.
  partialWhenPagesLeft: boolean;
}

// What the browser launch needs to know about a capture: pass it to withBrowser, e.g.
//   withBrowser(b => capturePortfolios(b, links, deadline, opts), { maxWaitMs, ...browserOptionsFor(opts) })
// The designer options give `{}`, so its launch is untouched.
export function browserOptionsFor(opts: Readonly<CaptureOptions>): BrowserOptions {
  return opts.blockPopups ? { blockPopups: true } : {};
}

// The designer review (R007) is byte-identical to what it was before the marketing review existed: no lockdown script, no
// worker blocking, no popup blocker, no teardown guard, Chromium launched with exactly its old arguments. That leaves R007's captures
// with the same exposure they always had: a candidate's portfolio site can open a WebSocket/EventSource handshake, a popup
// (target=_blank link or form, window.open) or an unload-time request (fetch keepalive, sendBeacon, an Image at pagehide) toward an
// internal address and our browser would send it, blind, from inside our network. The marketing review narrows all three. TODO: extend to the designer kind after a real-site check (Framer/Webflow/Figma Sites): sites that
// open a socket at load (chat widgets, multiplayer or live-preview features) would then throw inside their own script, and nothing
// has measured what that does to a designer capture.

// home + up to 3 internal pages + up to 2 outbound case studies.
export const DESIGNER_CAPTURE_OPTS: Readonly<CaptureOptions> = Object.freeze({ maxPages: 6, mobileCheck: true, linkHealth: true, textLimit: 4500, canvaPartial: false, lockdown: false, blockWorkers: false, blockPopups: false, guardTeardown: false, partialWhenPagesLeft: false });
// A brand site or a Notion/Canva doc, not a product UI: fewer pages, no phone-width
// shot or link audit (neither is judged), but far more text — the copy IS the evidence.
export const MARKETING_CAPTURE_OPTS: Readonly<CaptureOptions> = Object.freeze({ maxPages: 4, mobileCheck: false, linkHealth: false, textLimit: 12000, canvaPartial: true, lockdown: true, blockWorkers: true, blockPopups: true, guardTeardown: true, partialWhenPagesLeft: true });

const DESKTOP = { width: 1280, height: 800 };
const MOBILE  = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const NAV_TIMEOUT_MS = 25_000;
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
export const BOT_WALL_NOTE = 'Site is protected by a bot check (Cloudflare/captcha) - cannot be opened automatically';
export const CANVA_PARTIAL_NOTE = 'Canva view link: only the first screens are visible';
export const CANVA_EMPTY_NOTE = 'Canva view link did not render any screen - cannot be opened automatically';

// Challenge pages are served as 403 (managed challenge, blocked), 503 (the older
// "checking your browser" wait) or 429 (rate limited) — and their markers are
// vendor-specific, so a plain error page with the same status never matches.
const BOT_WALL_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);
const BOT_WALL_TEXT = /just a moment|checking your browser|_cf_chl|cf-challenge|px-captcha|hcaptcha|g-recaptcha|attention required[\s\S]{0,200}cloudflare|access denied[\s\S]{0,300}reference\s*#\d/i;
const BOT_WALL_SCAN_CHARS = 16_000;
// A challenge page says a line or two. Words that merely appear in a real page ("just a moment of silence") are not one.
const BOT_WALL_MAX_TEXT = 700;
const MAX_TAG_CHARS = 2000;

const hasHeader = (headers: Record<string, string> | undefined, name: string): boolean =>
  !!headers && Object.keys(headers).some(k => k.toLowerCase() === name);

/**
 * What a visitor would read in `s`, whitespace collapsed: for plain text that is the text itself, for an HTML head it is
 * what is left once <script>/<style> blocks and tags are taken out (a challenge page is a few KB of script around a
 * two-line message, and its markers live in the markup). Linear, and `s` is already bounded by the caller.
 */
function readableText(s: string): string {
  if (!s.includes('<')) return s.replace(/\s+/g, ' ').trim();
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    const raw = /^<(script|style)[\s>]/.exec(lower.slice(lt, lt + 9));
    const close = raw ? lower.indexOf(`</${raw[1]}`, lt) : -1;
    const gt = s.indexOf('>', close === -1 ? lt : close);
    // A '<' that never closes, or a "tag" far longer than any real one, was only a character ("a < b" in a page's own words).
    if (gt === -1 || (close === -1 && gt - lt > MAX_TAG_CHARS)) { out += '<'; i = lt + 1; continue; }
    out += ' ';
    i = gt + 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * A response from a bot-protection service rather than from the candidate's site. Everything this reads — status,
 * headers, words — is set by the candidate's own server, so none of it is trusted on its own: the status must be one a
 * challenge is served with (403, 429, 503; a page that answered 2xx is the site's own whatever it says or carries), and
 * then either Cloudflare's `cf-mitigated` header (it marks every challenge it serves) or a vendor marker (Akamai,
 * PerimeterX, hCaptcha/reCAPTCHA gates, Cloudflare's block page) on a SHORT page. `headers` is a plain map with
 * lower-case names (what puppeteer's `response.headers()` returns).
 */
export function isBotWall(status: number | null, text: string, headers?: Record<string, string>): boolean {
  if (status === null || !BOT_WALL_STATUSES.has(status)) return false;
  if (hasHeader(headers, 'cf-mitigated')) return true;
  const head = text.slice(0, BOT_WALL_SCAN_CHARS);
  return BOT_WALL_TEXT.test(head) && readableText(head).length < BOT_WALL_MAX_TEXT;
}

export function detectAccessProblem(
  status: number | null, finalUrl: string, text: string, headers?: Record<string, string>,
  opts: { canva?: boolean } = {},
): { kind: 'blocked' | 'error' | 'unreviewable'; note: string } | null {
  // A bot check says nothing about the candidate's work: neutral, and checked first so a
  // Cloudflare 403/503 is not read as "login required" (held against them) or "site down"
  // (retried to no avail). INTENDED behaviour change for the designer review too: such a
  // wall used to be 'blocked' there and scored the portfolio down.
  if (isBotWall(status, text, headers)) return { kind: 'unreviewable', note: BOT_WALL_NOTE };
  if (status === 401 || status === 403) return { kind: 'blocked', note: `Requires login or permission (HTTP ${status})` };
  if (status === 404 || status === 410) return { kind: 'blocked', note: `Page not found (HTTP ${status})` };
  if (status && status >= 500) return { kind: 'error', note: `Site returned HTTP ${status}` };
  if (/figma\.com\/(login|signup)/i.test(finalUrl)) return { kind: 'blocked', note: 'Figma file is private — sign-in required' };
  // Marketing only (opts.canva): for the designer review canva.com is an ordinary site, as it always was.
  if (opts.canva && /^https?:\/\/([\w-]+\.)*canva\.com\/(login|signup)/i.test(finalUrl)) return { kind: 'blocked', note: 'Canva design is private — sign-in required' };
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

/** The first `maxChars` of a response body. Never throws and never reads more than it needs. */
async function readHead(res: Response, maxChars: number): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text.slice(0, maxChars);
  } catch { return ''; }
}

/** What a plain request that got ANY answer says about why our browser could not load the site. Never throws. */
async function judgePlainResponse(res: Response): Promise<{ kind: 'error' | 'unreviewable'; note: string }> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  const head = BOT_WALL_STATUSES.has(res.status) ? await readHead(res, BOT_WALL_SCAN_CHARS) : '';
  if (isBotWall(res.status, head, headers)) return { kind: 'unreviewable', note: BOT_WALL_NOTE };
  void res.body?.cancel().catch(() => {});
  return { kind: 'error', note: 'Site responds to normal requests but not to our browser' };
}

/**
 * A site that won't load is either genuinely dead (the candidate's problem — a
 * broken portfolio link IS a finding) or our browser was refused/timed out
 * (our problem — must not count against them). A plain server-side request
 * that fails the same way is what tells the two apart. If that request is
 * answered by a bot check, the site is alive and the answer is neutral
 * ('unreviewable'), never 'dead'.
 */
export async function classifyLoadFailure(
  message: string, url: string,
): Promise<{ kind: 'blocked' | 'error' | 'unreviewable'; note: string }> {
  const connectionLevel = /ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_CLOSED|CONNECTION_RESET|SSL_|CERT_|ADDRESS_UNREACHABLE)/.test(message);
  const timedOut = /Navigation timeout|ERR_TIMED_OUT/i.test(message);
  if (!connectionLevel && !timedOut) return { kind: 'error', note: `Could not load the site (${message.slice(0, 80)})` };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await safeFetch(url, { method: 'GET', signal: ctl.signal, headers: { 'user-agent': UA } });
    return await judgePlainResponse(res);
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

async function pageText(page: Page, textLimit: number): Promise<string> {
  const t = await withTimeout(page.evaluate(() => document.body?.innerText || ''), 5000, '');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, textLimit);
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

// What the crawl left unread. The crawl is capped (maxPages), takes only the best-scored few of a page's links, and a later page can
// fail to load or run into a wall, so a site is usually read in part. Everything the pages we DID open link to — same-site pages and
// the case-study hosts the crawl may follow — that is not itself open is a page nobody read. `queued` is what the crawl had already
// picked and never reached. Both pickers are the crawl's own, so "unread" means exactly "the crawl would have opened it given room".
export function findUnopenedPages(
  crawled: ReadonlyArray<{ url: string; anchors: ReadonlyArray<Anchor> }>, visited: Set<string>, queued: readonly string[],
): string[] {
  // `visited` is keyed by origin + path, and a site that links to its own pages with and without `www.` is one site: compare without it.
  const plain = (key: string) => key.replace('://www.', '://');
  const byKey = new Map<string, string>();
  const note = (href: string) => {
    try { const u = new URL(href); u.hash = ''; byKey.set(plain(u.origin + u.pathname.replace(/\/$/, '')), href); } catch { /* not a URL */ }
  };
  queued.forEach(note);
  for (const p of crawled) {
    const anchors = [...p.anchors];
    pickInternalPages(anchors, p.url, visited, Infinity).forEach(note);
    pickExternalCaseStudies(anchors, p.url, visited, Infinity).forEach(note);
  }
  for (const key of visited) byKey.delete(plain(key));
  return [...byKey.values()];
}

export function partialCrawlNote(opened: number, unopened: number): string {
  return `Opened ${opened} page${opened === 1 ? '' : 's'}; the site links to ${unopened} more that ${unopened === 1 ? 'was' : 'were'} not read`;
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

// ─── Canva ───────────────────────────────────────────────────────────────────
const CANVA_HOST = /(^|\.)canva\.com$/i;
const isCanvaUrl = (url: string): boolean => { try { return CANVA_HOST.test(new URL(url).hostname); } catch { return false; } };

/**
 * A Canva view link is an app that paints the first screens of a design and nothing else, however
 * long the design is — so what we capture is a sample, never the whole. Detected by host (the
 * link as given, or where a canva.link short link landed). Opened with at least one screenshot =
 * 'ok' but `partial`; opened with none = nothing to look at, which is no fault of the candidate.
 * Returns null for anything that is not Canva, so no other platform is touched.
 */
export function classifyCanva(
  urls: string[], pages: CapturedPage[],
): { access: 'ok'; partial: true; note: string } | { access: 'unreviewable'; partial?: undefined; note: string } | null {
  if (!urls.some(isCanvaUrl)) return null;
  if (!pages.some(p => p.shots.length > 0)) return { access: 'unreviewable', note: CANVA_EMPTY_NOTE };
  return { access: 'ok', partial: true, note: CANVA_PARTIAL_NOTE };
}

// ─── No WebSockets (the request filter cannot see them) ──────────────────────
// page.setRequestInterception — which is what enforces the SSRF host check on every request the page makes — is never
// shown a WebSocket handshake. A candidate's own site could open ws://127.0.0.1:…, ws://169.254.169.254/… or a
// private-range address and our browser would send the handshake `GET` there (blind, but still a request from inside our
// network). Reading a portfolio needs none of these APIs, so before ANY navigation a script that runs ahead of every page
// script, in every frame (about:blank and srcdoc ones included), replaces each of them with one that throws a SecurityError.
// Marketing review only (`opts.lockdown`): the designer review runs without it, exactly as it did before this existed (see the
// note at DESIGNER_CAPTURE_OPTS). If installing it fails the capture fails (retried, never held against the candidate): an
// unprotected navigation is not an option.
//
// Verified in a real Chromium (145, headless, a local listener playing the "internal service"), 2026-10-22:
//  - the script stops a handshake from the page, from about:blank / srcdoc iframes and from EventSource;
//  - `Network.setBlockedURLs` (['ws://*', 'wss://*'], even ['*']) does NOT stop a WebSocket handshake — it blocks HTTP
//    requests only, so it is deliberately not used: it would be a control that looks like protection and is not;
//  - a Worker, SharedWorker or service worker can still open a WebSocket, because the script does not run inside them. Where
//    that matters (`blockWorkers`) those constructors are taken away too. Cost: a site that cannot run without a worker
//    renders without it, which is why the designer review (whose output must not change) leaves them alone.
export const BLOCKED_REALTIME_APIS: readonly string[] = Object.freeze([
  'WebSocket', 'WebSocketStream', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'EventSource',
]);
export const BLOCKED_WORKER_APIS: readonly string[] = Object.freeze(['Worker', 'SharedWorker']);

/**
 * The lockdown as source text: a string, not a function, because puppeteer would serialise a function's source and a
 * transpiler that wraps inner functions in helper calls (esbuild's keepNames under tsx) would make that source throw inside
 * the page and protect nothing. Only an API this browser really has is replaced (inventing one would make a page that
 * feature-detects believe it exists). Figma's own pages are left alone: their canvas viewer is first-party platform code
 * that opens its own multiplayer socket, and nobody can serve a script from figma.com (figma.site, which hosts user code,
 * is a different domain and is locked like any other).
 */
export function lockdownScript(o: { blockWorkers: boolean }): string {
  const names = o.blockWorkers ? [...BLOCKED_REALTIME_APIS, ...BLOCKED_WORKER_APIS] : [...BLOCKED_REALTIME_APIS];
  const lines = [
    '(() => {',
    '  if (/(^|\\.)figma\\.com$/i.test(location.hostname)) return;',
    "  const message = 'Not available while a portfolio is being reviewed';",
    "  const blocked = function () { throw new DOMException(message, 'SecurityError'); };",
    `  for (const name of ${JSON.stringify(names)}) {`,
    '    if (!(name in window)) continue;',
    '    try { Object.defineProperty(window, name, { configurable: false, writable: false, value: blocked }); } catch (e) { /* already locked */ }',
    '  }',
  ];
  if (o.blockWorkers) {
    lines.push(
      '  if (window.ServiceWorkerContainer) {',
      '    try {',
      "      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {",
      '        configurable: false, writable: false,',
      "        value: function () { return Promise.reject(new DOMException(message, 'SecurityError')); },",
      '      });',
      '    } catch (e) { /* already locked */ }',
      '  }',
    );
  }
  lines.push('})();');
  return lines.join('\n');
}

/**
 * True when we can SEE that this browser was launched without the popup flag (a browser we spawned: `browser.process()` has its
 * arguments). A capture with `blockPopups` on a browser like that has lost its first and strongest layer — typically because the
 * caller did not pass `browserOptionsFor(opts)` to withBrowser — so capturePortfolios says so in the log. A remote browser we only
 * connected to has no process we can read: false, because nothing can be said.
 */
export function launchedWithoutPopupBlocking(browser: Browser): boolean {
  const args = browser.process?.()?.spawnargs;
  return Array.isArray(args) && !args.includes(BLOCK_NEW_WEB_CONTENTS_FLAG);
}

// ─── No popups (a new page target is never shown to the request filter either) ──────────────────────
// The request filter is attached to ONE page. A page script (window.open) or a target=_blank link or form opens another page
// target that the filter never sees, and its first request goes out unchecked — blind, but a request from inside our network.
// Three layers, strongest first (measured with this code in a real Chromium, 2026-10-22; see BrowserOptions in browser.ts):
//  1. The launch (`blockPopups` → `browserOptionsFor`). Production runs @sparticuz/chromium, a headless SHELL with no popup blocker
//     at all, so there only `--block-new-web-contents` stops a window from opening, gesture or not; desktop Chrome (local
//     development) is stopped by its own blocker once puppeteer's `--disable-popup-blocking` default is dropped.
//  2. No user gesture. A blocker only blocks what has none, and puppeteer hands every page.evaluate() AND page.title() one (CDP
//     `userGesture: true`: a few seconds of transient activation). With layer 1's desktop half alone, a page that merely polls
//     `window.open()` got a popup through after each of our evaluates, and a hostile one that hooked what our evaluate calls got
//     through every creation path (window.open, a target=_blank click, a form submit). So under `blockPopups` the capture reads the
//     page through `withoutUserGesture` and no call of ours grants one. (Needed for desktop Chrome, a no-op for the headless shell.)
//  3. closeExtraPages, below: also covers a browser we did not launch (PORTFOLIO_BROWSER_WS_ENDPOINT, whose flags we cannot set).
// Alone: the flag stopped everything in the headless shell but leaked on desktop Chrome under a gesture; layer 2 does nothing
// without a blocker; layer 3 alone let every request through, because it is AFTER the fact (the popup's first request is already on
// the wire when it fires), so it is the last layer and never the control. All three together: zero requests on both builds.
// launchedWithoutPopupBlocking reports a launch that forgot layer 1.

/**
 * Layer 3: closes every page target other than `page` the moment it appears, and returns the function that stops listening.
 */
export function closeExtraPages(browser: Browser, page: Page): () => void {
  const own = page.target();
  const onCreated = (target: Target) => {
    if (target === own || target.type() !== 'page') return;
    void target.page().then(p => p?.close()).catch(() => {});
  };
  browser.on('targetcreated', onCreated);
  return () => { browser.off('targetcreated', onCreated); };
}

/**
 * `page` with evaluate() and title() replaced by versions that do NOT give the page a user gesture (see the popup note above):
 * the same function runs in the page's main world through CDP `Runtime.evaluate` with `userGesture: false`, and everything else
 * (goto, screenshot, viewport …) is the real page's. A function is sent as its source text — the callbacks here are plain
 * arrow functions over the DOM — and its arguments as JSON.
 */
export function withoutUserGesture(page: Page): Page {
  let session: Promise<CDPSession> | undefined;
  const run = async (expression: string): Promise<unknown> => {
    session ??= page.createCDPSession();
    const { result, exceptionDetails } = await (await session).send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const evaluate = (fn: unknown, ...args: unknown[]) =>
    run(typeof fn === 'function' ? `(${fn})(${args.map(a => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')})` : String(fn));
  const title = () => run('document.title');
  return new Proxy(page, {
    get(target, key) {
      if (key === 'evaluate') return evaluate;
      if (key === 'title') return title;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ─── A guarded teardown (what a page can still send while it is navigated away from or closed) ──────────────────────────────
// page.setRequestInterception shows the page's requests to the SSRF filter while the page is open. Two things get requests out around it
// when the document goes away (the page is closed, or navigated away from — we navigate one page through several URLs). Reproduced with the
// real capture code on 2026-10-23, marketing options and all, against a local listener standing in for an internal service:
//  1. The document's own pagehide / visibilitychange / beforeunload / unload handlers still run during the teardown, and what they start
//     (fetch keepalive, sendBeacon, `new Image().src`) is created after the interception is gone or while it is being dropped: Brave 145
//     2 keepalive GETs + 2 beacon POSTs + 1 image GET from one page, @sparticuz/chromium in the Lambda nodejs:22 image the same.
//  2. A request the filter has not answered yet when the document goes away is released, not dropped: it is a request that is "paused" in
//     the interception while its verdict (a DNS lookup) is pending. Keepalive-class requests — fetch with keepalive, sendBeacon, an
//     `<a ping>` click — go out when their document is destroyed by a navigation or the close, on every build measured (Brave 145, Chrome
//     for Testing, chrome-headless-shell, the Lambda image); in the Lambda image everything paused at the CLOSE is released (a plain fetch,
//     an image and an XHR included). Never answering a request and closing the page was enough; so was answering it a moment too late.
//     That is how a script-clicked `<a ping>` reached the listener (a page that clicks a pinging link on every document of a navigation
//     loop: Brave 7 of 8 runs, Lambda 2 of 8, plain close): the last ping was created just as the page closed, still waiting for our
//     abort. Chrome's `--no-pings` stops it on desktop (7 of 8 -> 0 of 8) and is already in @sparticuz/chromium's own arguments, where it
//     made no measurable difference (2 of 8 without it, 3 of 16 with it) — in the headless shell only the drain below stops it.
// The guard (marketing only, `opts.guardTeardown`) does both jobs before the document is destroyed: no page script runs (CDP
// Emulation.setScriptExecutionDisabled, puppeteer's page.setJavaScriptEnabled), and every request still waiting for the filter is answered
// with an abort and acknowledged. Between those two, requests the page made just before its scripts went off are still on their way to the
// filter, so the guard answers every request on sight from the moment it starts (`holding`) and waits a moment for stragglers. Before
// the close it does this for good (`seal`); before each later navigation of the same page it does it once and goes through an empty page.
// Traps found while measuring, both in the shape of this guard:
//  - Disabling scripts, loading the next page, then enabling them (what "disable before each navigation" suggests) loads the next page
//    WITHOUT its scripts: a script-rendered site reads as blank. So a navigation goes through an empty page first: scripts off, requests
//    drained, about:blank (nothing to run), scripts on, then the real navigation.
//  - Navigating to about:blank alone is not a defence: with scripts on, Brave sent every unload request at that step (10 hits) because the
//    old document's frame is swapped out with its interception; the headless shells did not. Disabling scripts works on every build.
// A cross-site iframe is its own browser target in desktop Chrome (site isolation; the single-process Chromium we run in production has
// none), and the page's setting does not reach it: its unload handlers still sent 12 requests until its own target was frozen too.
// Designer review: none of this (see the note at DESIGNER_CAPTURE_OPTS); its teardown is `page.close()`.
// Still open: (a) a request the page makes while its own document is being replaced by a navigation the PAGE started (location.href, a
// script click, a meta refresh), before our next step — measured at 0 requests in Brave and in the Lambda image because the page is still
// open and its requests are still shown to the filter, but that rests on the browser's frame lifecycle, not on this guard; (b) a request
// puppeteer never shows to the filter (no `request` event) cannot be answered by it; (c) Chromium's own reporting routes (Reporting-
// Endpoints / Report-To / NEL): measured on 2026-10-23 with an HTTPS site and an HTTPS "internal" endpoint, Chrome for Testing sent OPTIONS
// preflights to it (at 7 s and at 67 s); Brave, chrome-headless-shell and the Lambda image sent nothing in 80-90 s. Out of reach of this
// layer; (d) a script that never returns keeps the single-process Lambda browser busy even after its page is closed (the next page
// cannot load until it is restarted) — pre-existing, and the retry is a fresh browser. The real fix for the whole class is network-level
// egress filtering (a validating proxy, or a network policy on the function), not a page-level control.
const FREEZE_CAP_MS = 3_000;    // scripts off
const DRAIN_CAP_MS = 2_000;     // the aborts of the requests that were waiting for a verdict
const SETTLE_MS = 100;          // requests made just before the scripts went off are still on their way to the filter
const BLANK_CAP_MS = 5_000;
const CLOSE_CAP_MS = 10_000;

export interface TeardownGuard {
  /** Call before every navigation of the page AFTER its first: unloads the current document quietly, leaves scripts on and requests flowing. */
  beforeNavigation(): Promise<void>;
  /** The page's request handler goes through here: `check` answers the request (continue / abort); the guard knows which are still unanswered. */
  filter(req: HTTPRequest, check: (req: HTTPRequest) => Promise<void>): void;
  /** Teardown: scripts off, everything answered, for good (a navigation still in flight never switches them back on). Idempotent, bounded, never throws. */
  seal(): Promise<void>;
}

export function makeTeardownGuard(browser: Browser, page: Page): TeardownGuard {
  let sealing: Promise<void> | undefined;
  let holding = false;                          // every request is answered with an abort the moment it is seen
  const waiting = new Set<HTTPRequest>();       // requests the filter has not answered yet
  const aborts = new Set<Promise<unknown>>();   // aborts sent and not yet acknowledged
  const abort = (req: HTTPRequest) => {
    if (req.isInterceptResolutionHandled()) return;
    const sent = req.abort('blockedbyclient').catch(() => {});
    aborts.add(sent);
    void sent.then(() => aborts.delete(sent));
  };
  const answerWaiting = async () => { [...waiting].forEach(abort); await Promise.allSettled([...aborts]); };

  // A cross-site iframe has a target of its own: its session is kept (an emulation setting ends with the session that made it) and ends with the frame.
  const frameSessions = new WeakMap<Target, Promise<CDPSession>>();
  const freezeFrameTargets = (): Promise<unknown> => Promise.all(browser.targets().filter(t => t.type() === 'other').map(async t => {
    try {
      let session = frameSessions.get(t);
      if (!session) { session = t.createCDPSession(); frameSessions.set(t, session); }
      await (await session).send('Emulation.setScriptExecutionDisabled', { value: true });
    } catch { /* gone already, or not something that runs script */ }
  }));
  const scriptsOff = () => Promise.all([page.setJavaScriptEnabled(false), freezeFrameTargets()]);

  /** Refuse new requests, answer the waiting ones, switch scripts off, let stragglers arrive and answer them too. True when the scripts are off. */
  const quiesce = async (): Promise<boolean> => {
    holding = true;
    const first = answerWaiting();
    const off = await withTimeout(scriptsOff().then(() => true), FREEZE_CAP_MS, false).catch(() => false);
    await withTimeout(first, DRAIN_CAP_MS, undefined);
    await sleep(SETTLE_MS);
    await withTimeout(answerWaiting(), DRAIN_CAP_MS, undefined);
    return off;
  };

  return {
    async beforeNavigation() {
      if (sealing) throw new Error('The page is being closed');
      // Cannot be sure the scripts are off => do not navigate: the capture treats it as a failed navigation (a later page: skipped).
      if (!await quiesce()) throw new Error('The page scripts could not be switched off before navigating');
      const blank = await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: BLANK_CAP_MS }).then(() => true, () => false);
      // Sealed meanwhile (the capture timed out and is closing the page): scripts stay off and the navigation does not happen. Never on
      // again over the old document: if the empty page was not reached the navigation fails with scripts off (the next attempt starts
      // from the top). A failure to switch them back on is a failed navigation too, never a silent capture of a page that could not run
      // its scripts.
      if (sealing) throw new Error('The page is being closed');
      if (!blank) throw new Error('The empty page could not be reached before navigating');
      await page.setJavaScriptEnabled(true);
      holding = false;
    },
    filter(req, check) {
      if (holding) { abort(req); return; }
      waiting.add(req);
      void check(req).catch(() => {}).finally(() => waiting.delete(req));
    },
    seal() {
      sealing ??= quiesce().then(() => {}, () => {});
      return sealing;
    },
  };
}

/**
 * Closes the capture's page. Designer (no guard): `page.close()`, as it always was. With a guard: sealed first (bounded), then the close,
 * bounded too, so a page that cannot be closed cannot hold up the next portfolio — the wait is abandoned and the browser close at the
 * end of withBrowser is what finally clears it.
 */
async function closePage(page: Page, guard: TeardownGuard | null | undefined): Promise<void> {
  if (!guard) { await page.close().catch(() => {}); return; }
  await guard.seal();
  const closed = await withTimeout(page.close().then(() => true, () => true), CLOSE_CAP_MS, false);
  if (!closed) console.warn(`[portfolio] a page did not close within ${CLOSE_CAP_MS / 1000}s; moving on (the browser close at the end of the review clears it)`);
}

// ─── One portfolio ───────────────────────────────────────────────────────────
interface CaptureHandle { page?: Page; guard?: TeardownGuard | null }

async function capturePortfolio(
  browser: Browser, link: PortfolioLink, deadline: number, out: CapturedPortfolio, handle: CaptureHandle,
  opts: CaptureOptions,
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
  const stopClosingPopups = opts.blockPopups ? closeExtraPages(browser, page) : null;
  // Everything that reads the page (evaluate, title) goes through `view`: under blockPopups it never grants a user gesture.
  const view = opts.blockPopups ? withoutUserGesture(page) : page;
  // Under guardTeardown every navigation of this page after its first, and the close, happen with the page's scripts off and its requests answered (see makeTeardownGuard).
  const guard = opts.guardTeardown ? makeTeardownGuard(browser, page) : null;
  handle.guard = guard;
  let navigated = false;
  const navigate = async (url: string, options: Parameters<Page['goto']>[1]) => {
    if (guard && navigated) await guard.beforeNavigation();
    navigated = true;
    return page.goto(url, options);
  };
  try {
    if (opts.lockdown) await page.evaluateOnNewDocument(lockdownScript({ blockWorkers: opts.blockWorkers }));   // before ANY navigation
    await page.setUserAgent(UA);
    await page.setViewport(DESKTOP);
    await page.setRequestInterception(true);
    // Every request the page makes — sub-resources and redirects included — is
    // checked against the DNS-resolved address, not just string-matched: a
    // public-looking hostname can point at an internal one.
    const hostIsPublic = makeHostChecker();
    const checkRequest = async (req: HTTPRequest): Promise<void> => {
      try {
        if (req.resourceType() === 'media') return void req.abort('blockedbyclient');  // autoplay video is heavy and unreadable
        const isPublic = await hostIsPublic(req.url());
        if (req.isInterceptResolutionHandled()) return;   // the teardown guard answered it while its address was being checked
        if (!isPublic) return void req.abort('blockedbyclient');
        void req.continue();
      } catch { void req.abort('failed').catch(() => {}); }
    };
    page.on('request', guard ? req => guard.filter(req, checkRequest) : checkRequest);
    page.on('console', m => { if (m.type() === 'error') out.signals.consoleErrors++; });
    page.on('requestfailed', r => {
      if (r.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') out.signals.failedRequests++;
    });

    const visited = new Set<string>();
    const allAnchors: Anchor[] = [];
    const crawled: Array<{ url: string; anchors: Anchor[] }> = [];   // each page we opened and the links it carries
    const queue: string[] = [link.url];
    const started = Date.now();

    while (queue.length && out.pages.length < opts.maxPages) {
      if (deadline - Date.now() < 25_000) { out.signals.truncated = true; break; }
      const target = queue.shift()!;
      let status: number | null = null;
      let headers: Record<string, string> | undefined;
      try {
        const resp = await navigate(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        status = resp?.status() ?? null;
        headers = resp?.headers();
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
      await settleAndScroll(view);

      const text = await pageText(view, opts.textLimit);
      // A challenge page names itself in its <title> ("Just a moment…", "Attention Required! |
      // Cloudflare"), which innerText leaves out — read it, but only where a wall can be, so the
      // text every other check sees is exactly the page's own.
      const probe = BOT_WALL_STATUSES.has(status ?? 0) ? `${await withTimeout(view.title(), 2000, '')}\n${text}` : text;
      const problem = detectAccessProblem(status, page.url(), probe, headers, { canva: opts.canvaPartial });
      if (problem && out.pages.length === 0) { out.access = problem.kind; out.accessNote = problem.note; break; }
      if (problem) continue;

      const isHome = out.pages.length === 0;
      const title = wellFormed(((await withTimeout(view.title(), 2000, '')) || target).slice(0, 200));
      const shots = await scrollSlices(view, isHome ? 'Home page' : `Page: ${wellFormed(title.slice(0, 50))}`, isHome ? 3 : 2);
      out.pages.push({ url: page.url(), title, text, shots });
      const key = (() => { const u = new URL(page.url()); u.hash = ''; return u.origin + u.pathname.replace(/\/$/, ''); })();
      visited.add(key);

      const anchors = await collectAnchors(view);
      allAnchors.push(...anchors);
      crawled.push({ url: page.url(), anchors });
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

    if (opts.canvaPartial && out.access === 'ok') {
      const canva = classifyCanva([link.url, ...out.pages.map(p => p.url)], out.pages);
      if (canva) {
        out.access = canva.access;
        out.accessNote = canva.note;
        if (canva.access === 'ok') out.partial = true;
      }
    }

    // Marketing: pages the site links to that were never opened (the cap, a failed or walled later page, the clock) make this a part of the
    // site, not the site. A Figma file is one canvas with no crawl, so it has no pages to leave unread.
    if (opts.partialWhenPagesLeft && out.access === 'ok' && !out.partial && link.platform !== 'figma_file') {
      const unopened = findUnopenedPages(crawled, visited, queue);
      if (unopened.length) {
        out.partial = true;
        out.accessNote = partialCrawlNote(out.pages.length, unopened.length);
      }
    }

    // Mobile rendering — a hiring-manager criterion (display artifacts) and
    // relevant to a role that designs for phones.
    if (opts.mobileCheck && out.access === 'ok' && link.platform !== 'figma_file' && deadline - Date.now() > 20_000) {
      try {
        await page.setViewport(MOBILE);
        await navigate(link.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForNetworkIdle({ idleTime: 600, timeout: 4000 }).catch(() => {});
        out.signals.mobileOverflow = await withTimeout(
          view.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 8), 3000, null as boolean | null);
        const s = await shoot(page, 'Home page at phone width (390px)');
        if (s) out.mobileShot = s;
      } catch { /* mobile check is best-effort */ }
    }

    // Outbound link health across everything we crawled.
    if (opts.linkHealth && out.access === 'ok' && deadline - Date.now() > 15_000) {
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
          const r = await navigate(u, { waitUntil: 'domcontentloaded', timeout: 8000 });
          const st = r?.status() ?? 0;
          // A link that answers with a bot check is alive — not a broken link to hold against them.
          if (st >= 400 && !isBotWall(st, await withTimeout(view.title(), 2000, ''), r?.headers())) confirmed.push(u);
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
    stopClosingPopups?.();
    await closePage(page, guard);
  }
}

export async function capturePortfolios(
  browser: Browser, links: PortfolioLink[], deadline: number, opts: CaptureOptions = DESIGNER_CAPTURE_OPTS,
): Promise<CapturedPortfolio[]> {
  const results: CapturedPortfolio[] = [];
  if (opts.blockPopups && launchedWithoutPopupBlocking(browser)) {
    console.warn('[portfolio] blockPopups is on but this browser was launched without popup blocking: pass browserOptionsFor(opts) to withBrowser. Only the second layer (no user gestures, closing extra pages) is active.');
  }
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
    const inner = capturePortfolio(browser, link, deadline, out, handle, opts).then(() => 'done' as const, (e: Error) => {
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
      if (handle.page) await closePage(handle.page, handle.guard);
    }
  }
  return results;
}
