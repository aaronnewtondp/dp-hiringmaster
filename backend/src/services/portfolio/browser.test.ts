import { describe, it, expect } from 'vitest';
import { acquireBrowserSlot, BrowserBusyError, isBrowserInUse } from './browser.js';
import { isTransient } from './run.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

describe('browser slot (one Chromium at a time per instance)', () => {
  it('a second caller waits, gives up with BrowserBusyError, and succeeds once the first releases', async () => {
    const release1 = await acquireBrowserSlot(1000);
    await expect(acquireBrowserSlot(300)).rejects.toBeInstanceOf(BrowserBusyError);
    release1();
    const release2 = await acquireBrowserSlot(1000);
    release2();
  });
  it('a waiter is admitted as soon as the holder releases (no lost wake-up)', async () => {
    const release1 = await acquireBrowserSlot(1000);
    const waiter = acquireBrowserSlot(5000);
    setTimeout(release1, 200);
    const release2 = await waiter;
    release2();
  });
});

describe('isBrowserInUse', () => {
  it('reflects whether the slot is held, so callers can bail out before doing any work', async () => {
    expect(isBrowserInUse()).toBe(false);
    const release = await acquireBrowserSlot(1000);
    expect(isBrowserInUse()).toBe(true);
    release();
    expect(isBrowserInUse()).toBe(false);
  });
});

describe('isTransient', () => {
  it('treats infrastructure and rate-limit/overload errors as retryable', () => {
    expect(isTransient(new BrowserBusyError())).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { status: 529 }))).toBe(true);
    expect(isTransient(new Error('Failed to launch the browser process'))).toBe(true);
    expect(isTransient(new Error('Request timed out.'))).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
  });
  it('does not retry a bad input or an unparseable answer', () => {
    expect(isTransient(new Error('Portfolio review returned unparseable output'))).toBe(false);
    expect(isTransient(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('job-state timing', () => {
  it('the stale threshold sits between the function limit (300s) and the queue visibility timeout (330s)', () => {
    expect(STALE_RUNNING_SECONDS).toBeGreaterThan(300);
    expect(STALE_RUNNING_SECONDS).toBeLessThan(330);
  });
});
