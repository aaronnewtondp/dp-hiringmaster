import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  lambdaLaunchOptions, localLaunchOptions, withBrowser, closeBrowser, isBrowserInUse, BROWSER_CLOSE_MS,
  BLOCK_NEW_WEB_CONTENTS_FLAG, POPUP_BLOCKING_DISABLED_FLAG, NO_PINGS_FLAG, DISABLE_REPORTING_FLAG,
} from './browser.js';

// What this pins: the designer review (R007) launches Chromium with EXACTLY the arguments it had before the marketing
// review existed, and the marketing review adds popup blocking, no pings and no Reporting API (four launch changes, see
// BrowserOptions in browser.ts) and nothing else. The Chromium launch itself is a fake: nothing here starts a browser.

const h = vi.hoisted(() => ({
  launch: vi.fn(), connect: vi.fn(), chromiumArgs: [] as string[], executablePath: vi.fn(),
  existsSync: vi.fn(() => false), writeFileSync: vi.fn(), rmSync: vi.fn(),
}));
vi.mock('puppeteer-core', () => ({ launch: (...a: unknown[]) => h.launch(...a), connect: (...a: unknown[]) => h.connect(...a) }));
vi.mock('@sparticuz/chromium', () => ({ default: { get args() { return h.chromiumArgs; }, executablePath: () => h.executablePath() } }));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  // browser.ts probes /tmp and writes a marker there on Lambda; this file must never touch the real /tmp/chromium.
  const patched = { ...actual, existsSync: (p: string) => (/^\/tmp\//.test(p) || p === '/fake/chrome' ? (p === '/fake/chrome') : actual.existsSync(p)), writeFileSync: h.writeFileSync, rmSync: h.rmSync };
  return { ...patched, default: patched };
});

// What @sparticuz/chromium 143 ships (trimmed), including the one flag browser.ts takes away.
const SHIPPED_ARGS = ['--single-process', '--no-zygote', '--no-sandbox', '--disable-web-security', '--allow-running-insecure-content', '--headless=\'shell\''];

describe('lambdaLaunchOptions', () => {
  const base = { chromiumArgs: SHIPPED_ARGS, executablePath: '/tmp/chromium' };

  it('without blockPopups: exactly the options that shipped before, key for key (designer review)', () => {
    expect(lambdaLaunchOptions(base)).toStrictEqual({
      args: ['--single-process', '--no-zygote', '--no-sandbox', '--allow-running-insecure-content', '--headless=\'shell\''],
      executablePath: '/tmp/chromium',
      headless: 'shell',
      protocolTimeout: 45_000,
    });
    expect(lambdaLaunchOptions({ ...base, blockPopups: false })).toStrictEqual(lambdaLaunchOptions(base));
  });

  it('without blockPopups there is no ignoreDefaultArgs key at all (not even undefined) and no extra argument', () => {
    const o = lambdaLaunchOptions(base);
    expect('ignoreDefaultArgs' in o).toBe(false);
    expect(o.args).not.toContain(BLOCK_NEW_WEB_CONTENTS_FLAG);
  });

  it('with blockPopups: the same options plus --block-new-web-contents, --no-pings and --disable-features=Reporting and the popup-blocking default taken away, nothing else', () => {
    const designer = lambdaLaunchOptions(base);
    const marketing = lambdaLaunchOptions({ ...base, blockPopups: true });
    expect(marketing).toStrictEqual({
      ...designer,
      args: [...designer.args!, '--block-new-web-contents', '--no-pings', '--disable-features=Reporting'],
      ignoreDefaultArgs: ['--disable-popup-blocking'],
    });
  });

  it('the designer launch carries no hyperlink-audit or Reporting switch of its own (what @sparticuz/chromium ships is left as it is)', () => {
    for (const flag of [NO_PINGS_FLAG, DISABLE_REPORTING_FLAG]) {
      expect(lambdaLaunchOptions(base).args).not.toContain(flag);
      expect(lambdaLaunchOptions({ ...base, blockPopups: false }).args).not.toContain(flag);
    }
    // the package's own arguments are passed through untouched, a --no-pings among them included (the marketing launch repeats it, which Chromium accepts)
    const withTheirs = lambdaLaunchOptions({ chromiumArgs: [...SHIPPED_ARGS, '--no-pings'], executablePath: '/tmp/chromium' });
    expect(withTheirs.args).toContain(NO_PINGS_FLAG);
  });

  it('--disable-web-security is still removed whatever the review kind (a page script could read cross-origin responses with it)', () => {
    for (const blockPopups of [false, true]) expect(lambdaLaunchOptions({ ...base, blockPopups }).args).not.toContain('--disable-web-security');
  });

  it('does not mutate the arguments it is given', () => {
    const args = [...SHIPPED_ARGS];
    lambdaLaunchOptions({ chromiumArgs: args, executablePath: '/x', blockPopups: true });
    expect(args).toEqual(SHIPPED_ARGS);
  });

  it('the flags are the ones measured to work (headless shell: the content-layer switch; desktop Chrome: the blocker and no pings)', () => {
    expect(BLOCK_NEW_WEB_CONTENTS_FLAG).toBe('--block-new-web-contents');
    expect(POPUP_BLOCKING_DISABLED_FLAG).toBe('--disable-popup-blocking');
    expect(NO_PINGS_FLAG).toBe('--no-pings');
    expect(DISABLE_REPORTING_FLAG).toBe('--disable-features=Reporting');     // the one that measured to stop the Reporting API's own requests (NetworkErrorLogging alone did not)
  });
});

describe('localLaunchOptions', () => {
  it('without blockPopups: exactly the options that shipped before (designer review)', () => {
    expect(localLaunchOptions({ executablePath: '/fake/chrome' })).toStrictEqual({
      executablePath: '/fake/chrome', headless: true, protocolTimeout: 45_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    expect(localLaunchOptions({ executablePath: '/fake/chrome', blockPopups: false })).toStrictEqual(localLaunchOptions({ executablePath: '/fake/chrome' }));
    expect('ignoreDefaultArgs' in localLaunchOptions({ executablePath: '/fake/chrome' })).toBe(false);
  });

  it('with blockPopups: the same options plus --block-new-web-contents, --no-pings and --disable-features=Reporting and the popup-blocking default taken away, nothing else', () => {
    expect(localLaunchOptions({ executablePath: '/fake/chrome', blockPopups: true })).toStrictEqual({
      executablePath: '/fake/chrome', headless: true, protocolTimeout: 45_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--block-new-web-contents', '--no-pings', '--disable-features=Reporting'],
      ignoreDefaultArgs: ['--disable-popup-blocking'],
    });
  });

  it('ignoreDefaultArgs names exactly one flag: every other puppeteer default is kept (`true` would drop them all)', () => {
    const o = localLaunchOptions({ executablePath: '/fake/chrome', blockPopups: true });
    expect(Array.isArray(o.ignoreDefaultArgs)).toBe(true);
    expect(o.ignoreDefaultArgs).toHaveLength(1);
  });
});

describe('withBrowser — the options reach the launch', () => {
  const FAKE = () => ({ close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) });
  const saved = { ...process.env };
  beforeEach(() => {
    h.launch.mockReset().mockImplementation(async () => FAKE());
    h.connect.mockReset().mockImplementation(async () => FAKE());
    h.executablePath.mockReset().mockResolvedValue('/tmp/chromium');
    h.chromiumArgs = [...SHIPPED_ARGS];
    h.writeFileSync.mockReset(); h.rmSync.mockReset();
    delete process.env.PORTFOLIO_BROWSER_WS_ENDPOINT; delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.PORTFOLIO_CHROME_PATH = '/fake/chrome';
  });
  afterEach(() => { process.env = { ...saved }; });

  describe('on Vercel / Lambda', () => {
    beforeEach(() => { process.env.AWS_LAMBDA_FUNCTION_NAME = 'portfolio-worker'; });

    it('no options: the launch is the designer launch', async () => {
      await withBrowser(async () => 'ok');
      expect(h.launch).toHaveBeenCalledTimes(1);
      expect(h.launch.mock.calls[0][0]).toStrictEqual(lambdaLaunchOptions({ chromiumArgs: SHIPPED_ARGS, executablePath: '/tmp/chromium' }));
      expect('ignoreDefaultArgs' in h.launch.mock.calls[0][0]).toBe(false);
    });

    it('{ maxWaitMs } alone (what run.ts passes) leaves the launch untouched', async () => {
      await withBrowser(async () => 'ok', { maxWaitMs: 3000 });
      expect(h.launch.mock.calls[0][0]).toStrictEqual(lambdaLaunchOptions({ chromiumArgs: SHIPPED_ARGS, executablePath: '/tmp/chromium' }));
    });

    it('{ blockPopups: true } reaches puppeteer.launch', async () => {
      await withBrowser(async () => 'ok', { maxWaitMs: 3000, blockPopups: true });
      expect(h.launch.mock.calls[0][0]).toStrictEqual(lambdaLaunchOptions({ chromiumArgs: SHIPPED_ARGS, executablePath: '/tmp/chromium', blockPopups: true }));
      expect(h.launch.mock.calls[0][0].args).toContain('--block-new-web-contents');
      expect(h.launch.mock.calls[0][0].args).toContain('--no-pings');
      expect(h.launch.mock.calls[0][0].args).toContain('--disable-features=Reporting');
      expect(h.launch.mock.calls[0][0].ignoreDefaultArgs).toEqual(['--disable-popup-blocking']);
    });
  });

  describe('locally', () => {
    it('no options: the launch is the designer launch', async () => {
      await withBrowser(async () => 'ok');
      expect(h.launch.mock.calls[0][0]).toStrictEqual(localLaunchOptions({ executablePath: '/fake/chrome' }));
    });

    it('{ blockPopups: true } reaches puppeteer.launch', async () => {
      await withBrowser(async () => 'ok', { blockPopups: true });
      expect(h.launch.mock.calls[0][0]).toStrictEqual(localLaunchOptions({ executablePath: '/fake/chrome', blockPopups: true }));
    });
  });

  describe('attached to a remote browser (PORTFOLIO_BROWSER_WS_ENDPOINT)', () => {
    beforeEach(() => { process.env.PORTFOLIO_BROWSER_WS_ENDPOINT = 'wss://browser.example/devtools'; });

    it('a connection cannot take launch options: blockPopups changes nothing about the connect call, and nothing is launched', async () => {
      await withBrowser(async () => 'ok');
      await withBrowser(async () => 'ok', { blockPopups: true });
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.connect.mock.calls[0]).toEqual(h.connect.mock.calls[1]);
      expect(h.connect.mock.calls[0][0]).toStrictEqual({ browserWSEndpoint: 'wss://browser.example/devtools', protocolTimeout: 45_000 });
    });

    it('disconnects (never closes) a browser it does not own', async () => {
      const b = FAKE();
      h.connect.mockResolvedValue(b);
      await withBrowser(async () => 'ok', { blockPopups: true });
      expect(b.disconnect).toHaveBeenCalledTimes(1);
      expect(b.close).not.toHaveBeenCalled();
    });
  });

  it('the browser is closed and the slot released after the work, also when the work throws', async () => {
    const b = FAKE();
    h.launch.mockResolvedValue(b);
    await expect(withBrowser(async () => { throw new Error('boom'); }, { blockPopups: true })).rejects.toThrow('boom');
    expect(b.close).toHaveBeenCalledTimes(1);
    await expect(withBrowser(async () => 'again', { maxWaitMs: 50 })).resolves.toBe('again');   // the slot was released
  });
});

// ─── a browser that will not close (A1) ──────────────────────────────────────
// puppeteer's close() has no timeout of its own. In the Lambda image, with the real @sparticuz/chromium, a candidate page like
// `setTimeout(() => { for (;;) {} }, 400)` let the capture return normally and then left browser.close() pending for 7-11 minutes (also with the
// teardown guard off): the worker invocation only ended at Vercel's 300 s kill, the queue redelivered it three times, the one-browser slot was never
// released and the row stayed 'running'. withBrowser now races the close against BROWSER_CLOSE_MS and kills the process. withBrowser is shared with
// the designer review ON PURPOSE: nothing changes unless close() has not returned in time, which is the case that used to hang. The fakes here stand
// in for puppeteer; the real thing is exercised in the Lambda image (docs/MarketingWorkSampleReview_Runbook.md).
describe('closeBrowser / withBrowser — a browser that does not close is killed and the slot is released', () => {
  type FakeBrowser = { close: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
  const fake = (over: { close?: () => Promise<unknown>; disconnect?: () => Promise<unknown>; noProcess?: boolean; killThrows?: boolean } = {}): FakeBrowser => {
    const kill = vi.fn(() => { if (over.killThrows) throw new Error('ESRCH'); return true; });
    return {
      close: vi.fn(over.close ?? (async () => {})),
      disconnect: vi.fn(over.disconnect ?? (async () => {})),
      process: vi.fn(() => (over.noProcess ? null : { kill })),
      kill,
    };
  };
  const NEVER = () => new Promise<never>(() => {});
  const saved = { ...process.env };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env.PORTFOLIO_BROWSER_WS_ENDPOINT; delete process.env.VERCEL; delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.PORTFOLIO_CHROME_PATH = '/fake/chrome';
    h.executablePath.mockReset().mockResolvedValue('/tmp/chromium');
    h.chromiumArgs = [...SHIPPED_ARGS];
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...saved }; warn.mockRestore(); });

  it('the limit is ten seconds', () => {
    expect(BROWSER_CLOSE_MS).toBe(10_000);
  });

  describe('the normal path is unchanged: a browser that closes at once is closed once, never killed, and nothing else is asked of it', () => {
    it('closeBrowser: close() is called once; no process lookup, no kill, no disconnect, no warning', async () => {
      const b = fake();
      expect(await closeBrowser(b as never)).toBe('closed');
      expect(b.close).toHaveBeenCalledTimes(1);
      expect(b.process).not.toHaveBeenCalled();
      expect(b.kill).not.toHaveBeenCalled();
      expect(b.disconnect).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('a close that REJECTS is swallowed as it always was: closed, not killed', async () => {
      const b = fake({ close: async () => { throw new Error('Target closed'); } });
      expect(await closeBrowser(b as never)).toBe('closed');
      expect(b.kill).not.toHaveBeenCalled();
    });

    it('a close that throws synchronously is swallowed too', async () => {
      const b = fake();
      b.close.mockImplementation(() => { throw new Error('sync boom'); });
      expect(await closeBrowser(b as never)).toBe('closed');
    });

    it('withBrowser: the call order is launch, the work, close, THEN the slot is free; the result is the work\'s', async () => {
      const order: string[] = [];
      const b = fake({ close: async () => { order.push(`close (slot busy: ${isBrowserInUse()})`); } });
      h.launch.mockReset().mockImplementation(async () => { order.push('launch'); return b; });
      const out = await withBrowser(async () => { order.push('work'); return 'result'; });
      order.push(`after (slot busy: ${isBrowserInUse()})`);
      expect(out).toBe('result');
      expect(order).toEqual(['launch', 'work', 'close (slot busy: true)', 'after (slot busy: false)']);
      expect(b.kill).not.toHaveBeenCalled();
    });

    it('withBrowser leaves no timer behind on the normal path (the 10 s limit must not keep a worker alive)', async () => {
      vi.useFakeTimers();
      try {
        h.launch.mockReset().mockImplementation(async () => fake());
        await withBrowser(async () => 'ok');
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it('the designer launch is untouched: with and without the close-timeout seam the launch options are the same, key for key, locally and on Lambda', async () => {
      h.launch.mockReset().mockImplementation(async () => fake());
      await withBrowser(async () => 'ok');
      await withBrowser(async () => 'ok', { closeTimeoutMs: 5 });
      expect(h.launch.mock.calls[0][0]).toStrictEqual(localLaunchOptions({ executablePath: '/fake/chrome' }));
      expect(h.launch.mock.calls[1][0]).toStrictEqual(h.launch.mock.calls[0][0]);
      expect('closeTimeoutMs' in h.launch.mock.calls[1][0]).toBe(false);

      process.env.AWS_LAMBDA_FUNCTION_NAME = 'portfolio-worker';
      await withBrowser(async () => 'ok', { closeTimeoutMs: 5 });
      expect(h.launch.mock.calls[2][0]).toStrictEqual(lambdaLaunchOptions({ chromiumArgs: SHIPPED_ARGS, executablePath: '/tmp/chromium' }));
    });
  });

  describe('a close that never answers', () => {
    it('closeBrowser kills the process with SIGKILL once the limit has passed, and returns', async () => {
      const b = fake({ close: NEVER });
      const started = Date.now();
      expect(await closeBrowser(b as never, 40)).toBe('killed');
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(b.kill).toHaveBeenCalledTimes(1);
      expect(b.kill).toHaveBeenCalledWith('SIGKILL');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('withBrowser returns the work\'s result about one limit after the work ended, and the slot is free again (a second review gets in at once)', async () => {
      const b = fake({ close: NEVER });
      h.launch.mockReset().mockResolvedValueOnce(b);
      const started = Date.now();
      expect(await withBrowser(async () => 'captured', { closeTimeoutMs: 60 })).toBe('captured');
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(55);
      expect(took).toBeLessThan(2000);
      expect(b.kill).toHaveBeenCalledWith('SIGKILL');
      expect(isBrowserInUse()).toBe(false);
      h.launch.mockResolvedValueOnce(fake());
      await expect(withBrowser(async () => 'next review', { maxWaitMs: 20 })).resolves.toBe('next review');   // would throw BrowserBusyError if the slot were still held
    });

    it('...and the work\'s own error still reaches the caller (the kill does not swallow it)', async () => {
      const b = fake({ close: NEVER });
      h.launch.mockReset().mockResolvedValueOnce(b);
      await expect(withBrowser(async () => { throw new Error('capture blew up'); }, { closeTimeoutMs: 30 })).rejects.toThrow('capture blew up');
      expect(b.kill).toHaveBeenCalledTimes(1);
      expect(isBrowserInUse()).toBe(false);
    });

    it('a browser with no process of ours is disconnected from instead of killed (nothing of ours to kill), and the slot is released all the same', async () => {
      const b = fake({ close: NEVER, noProcess: true });
      expect(await closeBrowser(b as never, 30)).toBe('abandoned');
      expect(b.kill).not.toHaveBeenCalled();
      expect(b.disconnect).toHaveBeenCalledTimes(1);

      h.launch.mockReset().mockResolvedValueOnce(fake({ close: NEVER, noProcess: true }));
      await withBrowser(async () => 'x', { closeTimeoutMs: 30 });
      expect(isBrowserInUse()).toBe(false);
    });

    it('a kill that throws (the process is already gone) changes nothing: the slot is still released', async () => {
      h.launch.mockReset().mockResolvedValueOnce(fake({ close: NEVER, killThrows: true }));
      await expect(withBrowser(async () => 'x', { closeTimeoutMs: 30 })).resolves.toBe('x');
      expect(isBrowserInUse()).toBe(false);
    });

    it('a process() that throws is not a reason to hold the slot either', async () => {
      const b = fake({ close: NEVER });
      b.process.mockImplementation(() => { throw new Error('not a launched browser'); });
      h.launch.mockReset().mockResolvedValueOnce(b);
      await expect(withBrowser(async () => 'x', { closeTimeoutMs: 30 })).resolves.toBe('x');
      expect(isBrowserInUse()).toBe(false);
    });

    it('the abandoned close() settling LATER (the killed process exits, its pipe closes) is already handled: no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const seen = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', seen);
      try {
        let rejectClose!: (e: Error) => void;
        const b = fake({ close: () => new Promise<never>((_, reject) => { rejectClose = reject; }) });
        h.launch.mockReset().mockResolvedValueOnce(b);
        await withBrowser(async () => 'x', { closeTimeoutMs: 20 });
        rejectClose(new Error('Target closed (after the kill)'));
        await new Promise(r => setTimeout(r, 50));
      } finally { process.off('unhandledRejection', seen); }
      expect(unhandled).toEqual([]);
    });

    it('when the limit is not given it is BROWSER_CLOSE_MS (no caller overrides it): the timer the close is raced against is set for exactly that long, and cleared when the close wins', async () => {
      const delays: number[] = [];
      const real = global.setTimeout;
      const cleared: unknown[] = [];
      const realClear = global.clearTimeout;
      const timerSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => { delays.push(ms as number); return real(fn, ms, ...a); }) as never);
      const clearSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(((t: never) => { cleared.push(t); return realClear(t); }) as never);
      try {
        h.launch.mockReset().mockResolvedValueOnce(fake());
        await withBrowser(async () => 'x');
      } finally { timerSpy.mockRestore(); clearSpy.mockRestore(); }
      expect(delays).toContain(BROWSER_CLOSE_MS);
      expect(cleared.length).toBeGreaterThan(0);
    });
  });

  describe('attached to a remote browser (PORTFOLIO_BROWSER_WS_ENDPOINT)', () => {
    beforeEach(() => { process.env.PORTFOLIO_BROWSER_WS_ENDPOINT = 'wss://browser.example/devtools'; });

    it('a disconnect that never answers is given up on after the limit: never closed or killed (not ours), and the slot is released', async () => {
      const b = fake({ disconnect: NEVER });
      h.connect.mockReset().mockResolvedValueOnce(b);
      const started = Date.now();
      await expect(withBrowser(async () => 'x', { closeTimeoutMs: 40 })).resolves.toBe('x');
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
      expect(b.close).not.toHaveBeenCalled();
      expect(b.kill).not.toHaveBeenCalled();
      expect(isBrowserInUse()).toBe(false);
    });

    it('a normal disconnect is exactly as before', async () => {
      const b = fake();
      h.connect.mockReset().mockResolvedValueOnce(b);
      await withBrowser(async () => 'x');
      expect(b.disconnect).toHaveBeenCalledTimes(1);
      expect(b.close).not.toHaveBeenCalled();
    });
  });
});
