/**
 * Browser/text checks that need NO database: shared by the e2e specs (through helpers/e2e-misc.ts) and by the production smoke spec, which must
 * never load the database helpers (it runs against production; helpers/db.ts is for local databases only).
 */
import { Download, expect, Page } from '@playwright/test';

// ── Downloads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The first download that starts on the page or on any tab it opens (a PDF opened from a target=_blank link has no viewer in headless
 * Chromium, so the navigation ends as a download). Start waiting BEFORE the click. When none starts, the error names the tabs that exist
 * and the usual cause: the service worker answering the file's navigation with the app shell.
 */
export function nextDownload(page: Page, ms = 20_000): Promise<Download> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const tabs = page.context().pages().map(p => p.url() || '(blank)').join(', ');
      reject(new Error(
        `no download started within ${ms} ms; open tabs: ${tabs}. If a tab ended on the app (/dashboard or /login), the service worker answered the PDF ` +
        `navigation with the app shell (frontend/vite.config.ts workbox.navigateFallbackDenylist must exclude dotted paths).`));
    }, ms);
    const done = (d: Download) => { clearTimeout(timer); resolve(d); };
    page.once('download', done);
    page.context().once('page', p => p.once('download', done));
  });
}

// ── Text that must never reach a user ────────────────────────────────────────────────────────────────────────────────────────────
// Unresolved template syntax ("{{x}}", "${x}") and JavaScript leftovers ("undefined", "[object Object]", "NaN") are what a broken
// string interpolation looks like on screen. The words "null" and "None" are deliberately NOT in the list: they are legitimate prose.
const LEAKS: Array<[string, RegExp]> = [
  ['{{ }} template syntax',  /\{\{|\}\}/],
  ['${ } template syntax',   /\$\{/],
  ['"undefined"',            /\bundefined\b/],
  ['"[object Object]"',      /\[object Object\]/],
  ['"NaN"',                  /\bNaN\b/],
];

/** What leaked into `text`, by name (empty when the text is clean). */
export function leakedSyntax(text: string): string[] {
  return LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Fails with the offending name and a short excerpt when `text` is empty or contains leaked template syntax. */
export function expectRealText(text: string, what: string): void {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  expect(trimmed.length, `${what}: the text is empty`).toBeGreaterThan(0);
  const leaks = leakedSyntax(trimmed);
  expect(leaks, `${what}: leaked syntax ${JSON.stringify(leaks)} in "${trimmed.slice(0, 160)}"`).toEqual([]);
}

// ── Service worker ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Waits (bounded) until the page's service worker is registered, ACTIVE and CONTROLLING this page, and fails with a clear message when it
 * never gets there: registration is asynchronous (main.tsx registers it after the load event), so a test must wait for it rather than assume.
 */
export async function waitForServiceWorkerControl(page: Page, timeoutMs = 20_000): Promise<{ scriptURL: string }> {
  const state = await page.evaluate(async (ms: number) => {
    if (!('serviceWorker' in navigator)) return { ok: false, why: 'this browser context has no serviceWorker API (is the context blocking service workers?)' };
    const timeout = new Promise<{ ok: false; why: string }>(r => setTimeout(() => r({ ok: false, why: `no active service worker within ${ms} ms (navigator.serviceWorker.ready never resolved)` }), ms));
    const ready = navigator.serviceWorker.ready.then(async reg => {
      const deadline = Date.now() + ms;
      while (!navigator.serviceWorker.controller && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));   // clientsClaim() takes control a moment after activation
      return navigator.serviceWorker.controller
        ? { ok: true as const, scriptURL: navigator.serviceWorker.controller.scriptURL, why: '' }
        : { ok: false as const, why: `the service worker is active (${reg.active?.scriptURL ?? '?'}) but never took control of the page` };
    });
    return Promise.race([ready, timeout]);
  }, timeoutMs);
  if (!state.ok) throw new Error(`Service worker: ${state.why}`);
  return { scriptURL: (state as { scriptURL: string }).scriptURL };
}

