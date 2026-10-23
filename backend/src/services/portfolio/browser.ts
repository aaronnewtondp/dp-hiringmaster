// WORKER-ONLY. Never import this (or capture.ts / analyze.ts / run.ts) from the
// main Express app: it pulls in puppeteer-core and — through the dynamic import
// below — the 70 MB Chromium binary, which must stay out of the main API's
// serverless bundle. The main app only ever imports enqueue.ts / links.ts.
import fs from 'fs';
import path from 'path';
import type { Browser, LaunchOptions } from 'puppeteer-core';

// Where to get a browser, in priority order:
//   1. PORTFOLIO_BROWSER_WS_ENDPOINT — attach to an already-running remote
//      Chrome over CDP (a hosted provider such as Browserbase/Browserless, or a
//      local Chrome started with --remote-debugging-port). This is the escape
//      hatch if embedded Chromium ever proves unreliable on Vercel.
//   2. On Vercel — the @sparticuz/chromium build made for Lambda-style runtimes.
//   3. Locally — PORTFOLIO_CHROME_PATH, or a Chrome/Chromium found on disk.

// puppeteer's default is 180s per CDP call; one stalled call must not be able to
// consume a job whose whole budget is a few minutes.
const PROTOCOL_TIMEOUT_MS = 45_000;

/** Thrown when another review is already using this instance's browser. Transient — the queue retries. */
export class BrowserBusyError extends Error {
  constructor() { super('Another portfolio review is using the browser on this instance'); this.name = 'BrowserBusyError'; }
}

// ── One browser at a time per process ───────────────────────────────────────
// Vercel's Fluid compute packs concurrent invocations onto one instance. Two
// of them cold-starting together race on the Chromium extraction into /tmp
// (@sparticuz/chromium treats "file exists" as "already extracted", so the
// second caller launches a half-written binary — upstream issue Sparticuz/
// chromium#507), and two single-process Chromiums also compete for the fixed
// 2 GB. Serialising per process removes both; a waiter that can't get in soon
// gives up so the queue can redeliver it to another instance.
let inUse: Promise<void> | null = null;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Is another review using this instance's browser right now? A cheap check callers can make before doing any work. */
export function isBrowserInUse(): boolean { return inUse !== null; }

export async function acquireBrowserSlot(maxWaitMs: number): Promise<() => void> {
  const start = Date.now();
  while (inUse) {
    if (Date.now() - start > maxWaitMs) throw new BrowserBusyError();
    await Promise.race([inUse.catch(() => {}), sleep(500)]);
  }
  let release!: () => void;
  inUse = new Promise<void>(r => { release = r; });
  return () => { inUse = null; release(); };
}

// Flags @sparticuz/chromium ships for Lambda that we do not want when the pages
// are attacker-controlled: --disable-web-security lets a page's script read
// cross-origin responses (e.g. from an internal address it coaxes the browser
// into requesting). Nothing here needs it.
const UNWANTED_FLAGS = new Set(['--disable-web-security']);

const READY_MARKER = '/tmp/.chromium-ready';
function ensureCleanChromiumTmp(): void {
  // A previous invocation killed mid-extraction leaves a truncated /tmp/chromium
  // that the package would happily reuse. Only a finished extraction writes the marker.
  if (fs.existsSync('/tmp/chromium') && !fs.existsSync(READY_MARKER)) {
    for (const p of ['/tmp/chromium', '/tmp/al2023', '/tmp/fonts', '/tmp/swiftshader', '/tmp/al2']) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function findLocalChrome(): string | null {
  const explicit = process.env.PORTFOLIO_CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;

  // A Playwright-installed Chromium (this repo's e2e suite already has one).
  // $HOME via process.env, not os.homedir(): @vercel/nft statically evaluates
  // os.homedir() on the build machine and then tries to bundle the entire
  // (multi-GB) Playwright cache it finds there. process.env is opaque to it.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const pwRoots = home ? [path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright')] : [];
  for (const root of pwRoots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
      const candidates = [
        path.join(root, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        path.join(root, dir, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
        path.join(root, dir, 'chrome-linux/chrome'),
      ];
      for (const c of candidates) if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * How long a browser we launched gets to close before it is killed (closeBrowser below). Chromium needs well under a second to close
 * after an ordinary page; ten seconds is generous, and short enough that the review's budget (and the one-browser-at-a-time slot, which
 * is held until the close is over) is not spent waiting on a browser that will never answer.
 */
export const BROWSER_CLOSE_MS = 10_000;

export interface BrowserOptions {
  /** How long to wait for another review on this instance to let go of the browser (default 45 s). */
  maxWaitMs?: number;
  /** Test seam: how long a browser may take to close or disconnect before it is killed / given up on. Default BROWSER_CLOSE_MS; no caller sets it. */
  closeTimeoutMs?: number;
  /**
   * Launch Chromium so that a page cannot reach the network around the per-page request filter by opening windows or pinging.
   * A popup (window.open, a target=_blank link or form) is a new page target the filter never sees, so a candidate's site could use
   * it to send blind GET/POST requests to a loopback, private or metadata address (reproduced with the real capture code: three
   * requests reached a local listener). A hyperlink-audit ping (`<a ping="url">`, which a page script can trigger with a click) is a
   * POST the browser sends on its own, also unfiltered, and so are Chromium's own reports (the Reporting API: a page's
   * `Reporting-Endpoints` / `Report-To` / NEL headers name an address the browser then contacts itself). Four launch changes, because
   * the Chromium builds we run answer to different ones (measured, 2026-10-22 and 2026-10-23):
   *  - `--block-new-web-contents`: a content-layer switch that refuses every page-script-opened window outright, gesture or no
   *    gesture. This is what protects PRODUCTION: @sparticuz/chromium is a headless SHELL, which has no popup blocker at all
   *    (the same page opened all three popups with the blocker "on" and "off"), and this switch stopped all three there.
   *    Desktop Chrome (local development) does not honour it for a window opened on a user gesture.
   *  - dropping puppeteer's default `--disable-popup-blocking`: desktop Chrome's own blocker then refuses a window opened with
   *    no user gesture. It needs capture.ts not to grant one (`withoutUserGesture`), and does nothing in the headless shell.
   *  - `--no-pings`: hyperlink auditing off. A script-clicked `<a ping=internal>` made the browser POST to a local listener in
   *    desktop Chrome (7 of 8 runs) and in @sparticuz/chromium in the Lambda image (2 of 8). The flag took the desktop number to 0 of 8;
   *    @sparticuz/chromium already ships it and it made no measurable difference there (what stops the ping in that build is the
   *    teardown guard in capture.ts, see makeTeardownGuard).
   *  - `--disable-features=Reporting`: the Reporting API off. With an HTTPS site whose headers named an HTTPS "internal" endpoint, Chrome
   *    for Testing sent CORS preflights to it, at 2-7 s and again at about 62-67 s, with no request the filter could see; with the
   *    feature off, none in 75 s (`NetworkErrorLogging` alone did not stop it). Brave, chrome-headless-shell and @sparticuz/chromium sent
   *    nothing in 80-90 s with or without it, so for the build we run in production this is a no-op, kept for desktop Chrome. Puppeteer
   *    merges every `--disable-features` argument into its own list, @sparticuz/chromium's included.
   * One option for all of them because they are one decision, the marketing review's launch lockdown, and every caller already
   * passes it as `browserOptionsFor(MARKETING_CAPTURE_OPTS)` (capture.ts). Marketing review only: the designer review launches with
   * exactly the arguments it always had. No effect when attaching to PORTFOLIO_BROWSER_WS_ENDPOINT — a connection cannot change how
   * the remote browser was started (see the note in withBrowser).
   */
  blockPopups?: boolean;
}

// puppeteer.launch() adds `--disable-popup-blocking` to Chromium's defaults. `ignoreDefaultArgs: [flag]` removes just that one
// and keeps every other default (`true` would drop them all).
export const POPUP_BLOCKING_DISABLED_FLAG = '--disable-popup-blocking';
export const BLOCK_NEW_WEB_CONTENTS_FLAG = '--block-new-web-contents';
export const NO_PINGS_FLAG = '--no-pings';
export const DISABLE_REPORTING_FLAG = '--disable-features=Reporting';
const popupArgs = (blockPopups: boolean | undefined): string[] => (blockPopups ? [BLOCK_NEW_WEB_CONTENTS_FLAG, NO_PINGS_FLAG, DISABLE_REPORTING_FLAG] : []);
const popupLaunchOptions = (blockPopups: boolean | undefined): Pick<LaunchOptions, 'ignoreDefaultArgs'> =>
  blockPopups ? { ignoreDefaultArgs: [POPUP_BLOCKING_DISABLED_FLAG] } : {};

/** puppeteer.launch() options on Vercel / Lambda (@sparticuz/chromium). With `blockPopups` off this is exactly what shipped before. */
export function lambdaLaunchOptions(o: { chromiumArgs: readonly string[]; executablePath: string; blockPopups?: boolean }): LaunchOptions {
  return {
    args: [...o.chromiumArgs.filter(a => !UNWANTED_FLAGS.has(a)), ...popupArgs(o.blockPopups)],
    executablePath: o.executablePath,
    headless: 'shell',
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    ...popupLaunchOptions(o.blockPopups),
  };
}

/** puppeteer.launch() options for a Chrome found on this machine. With `blockPopups` off this is exactly what shipped before. */
export function localLaunchOptions(o: { executablePath: string; blockPopups?: boolean }): LaunchOptions {
  return {
    executablePath: o.executablePath, headless: true, protocolTimeout: PROTOCOL_TIMEOUT_MS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', ...popupArgs(o.blockPopups)],
    ...popupLaunchOptions(o.blockPopups),
  };
}

/** Settles with true when `p` settled (either way) within `ms`, with false when it did not. Never rejects; leaves no timer behind. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Closes a browser WE launched, but never waits on it for more than `timeoutMs`; past that the browser process is killed. Never throws.
 * puppeteer's close() is `await cdp.closeBrowser(); await browserProcess.hasClosed()` with no timeout of its own, and a single-process
 * Chromium (@sparticuz/chromium on Lambda) whose one renderer is in an endless loop never answers either: a candidate page as small as
 * `setTimeout(() => { for (;;) {} }, 400)` left close() pending for 7-11 minutes in the Lambda image (reproduced with the teardown guard
 * off as well, so it is not the guard). Nothing then ended the review but Vercel's 300 s kill, the queue redelivered it up to three times
 * and the one-browser slot was never given back, for the price of one link in a public form. This is shared with the designer review on
 * purpose: it changes nothing unless close() has not returned within the limit, which is exactly the case that used to hang.
 * SIGKILL, not a polite signal: a Chromium that is not answering will not act on one. The abandoned close() then settles by itself (the
 * process exits, its pipe closes) and is already handled, so it cannot become an unhandled rejection. A browser with no process of
 * ours (it was connected to, or the launcher gave none) is disconnected from instead: there is nothing of ours to kill.
 * Returns how it ended: closed by itself, killed, or (no process to kill) disconnected from and left.
 */
export async function closeBrowser(browser: Browser, timeoutMs: number = BROWSER_CLOSE_MS): Promise<'closed' | 'killed' | 'abandoned'> {
  let closing: Promise<unknown>;
  try { closing = Promise.resolve(browser.close()); } catch { return 'closed'; }
  if (await settlesWithin(closing, timeoutMs)) return 'closed';
  console.warn(`[portfolio] the browser did not close within ${Math.round(timeoutMs / 1000)}s; killing it`);
  let proc: ReturnType<Browser['process']> = null;
  try { proc = browser.process(); } catch { /* not a launched browser */ }
  if (proc) {
    try { proc.kill('SIGKILL'); return 'killed'; } catch { /* it is already gone */ }
  }
  try { void Promise.resolve(browser.disconnect()).catch(() => {}); } catch { /* nothing left to drop */ }
  return 'abandoned';
}

/** `browser.disconnect()` for a browser someone else owns, bounded the same way: the slot must not depend on a remote that never answers. */
async function disconnectBrowser(browser: Browser, timeoutMs: number): Promise<void> {
  let disconnecting: Promise<unknown>;
  try { disconnecting = Promise.resolve(browser.disconnect()); } catch { return; }
  await settlesWithin(disconnecting, timeoutMs);
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>, opts: BrowserOptions = {}): Promise<T> {
  const release = await acquireBrowserSlot(opts.maxWaitMs ?? 45_000);
  const closeMs = opts.closeTimeoutMs ?? BROWSER_CLOSE_MS;
  try {
    const puppeteer = await import('puppeteer-core');

    const ws = process.env.PORTFOLIO_BROWSER_WS_ENDPOINT;
    if (ws) {
      // A remote browser was started by someone else with their flags, so `blockPopups` cannot be applied here. What still
      // protects a marketing capture on this path: capture.ts closes any extra page target the moment it appears and the
      // in-page lockdown takes window.open away. And a hosted browser (Browserbase and the like) runs on the provider's
      // network, not ours, so a blind request from it cannot reach this deployment's internal services in the first place.
      const browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: PROTOCOL_TIMEOUT_MS });
      try { return await fn(browser); } finally { await disconnectBrowser(browser, closeMs); }
    }

    let browser: Browser;
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      ensureCleanChromiumTmp();
      // The compiled output turns this import() into require(), so the package
      // MUST ship a CommonJS build (143.x does; 149+ is ESM-only and fails with
      // ERR_REQUIRE_ESM on Vercel's Node 22 — see browserPackages.test.ts).
      const chromium = (await import('@sparticuz/chromium')).default;
      const executablePath = await chromium.executablePath();
      try { fs.writeFileSync(READY_MARKER, String(Date.now())); } catch { /* /tmp not writable would fail launch anyway */ }
      browser = await puppeteer.launch(lambdaLaunchOptions({ chromiumArgs: chromium.args, executablePath, blockPopups: opts.blockPopups }));
    } else {
      const exe = findLocalChrome();
      if (!exe) throw new Error('No local Chrome/Chromium found — set PORTFOLIO_CHROME_PATH or PORTFOLIO_BROWSER_WS_ENDPOINT');
      browser = await puppeteer.launch(localLaunchOptions({ executablePath: exe, blockPopups: opts.blockPopups }));
    }
    try { return await fn(browser); } finally { await closeBrowser(browser, closeMs); }
  } finally {
    release();
  }
}
