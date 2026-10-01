// WORKER-ONLY. Never import this (or capture.ts / analyze.ts / run.ts) from the
// main Express app: it pulls in puppeteer-core and — through the dynamic import
// below — the 70 MB Chromium binary, which must stay out of the main API's
// serverless bundle. The main app only ever imports enqueue.ts / links.ts.
import fs from 'fs';
import path from 'path';
import type { Browser } from 'puppeteer-core';

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

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  const release = await acquireBrowserSlot(opts.maxWaitMs ?? 45_000);
  try {
    const puppeteer = await import('puppeteer-core');

    const ws = process.env.PORTFOLIO_BROWSER_WS_ENDPOINT;
    if (ws) {
      const browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: PROTOCOL_TIMEOUT_MS });
      try { return await fn(browser); } finally { await browser.disconnect().catch(() => {}); }
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
      browser = await puppeteer.launch({
        args: chromium.args.filter(a => !UNWANTED_FLAGS.has(a)),
        executablePath,
        headless: 'shell',
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
    } else {
      const exe = findLocalChrome();
      if (!exe) throw new Error('No local Chrome/Chromium found — set PORTFOLIO_CHROME_PATH or PORTFOLIO_BROWSER_WS_ENDPOINT');
      browser = await puppeteer.launch({
        executablePath: exe, headless: true, protocolTimeout: PROTOCOL_TIMEOUT_MS,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
      });
    }
    try { return await fn(browser); } finally { await browser.close().catch(() => {}); }
  } finally {
    release();
  }
}
