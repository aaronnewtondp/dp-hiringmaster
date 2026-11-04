import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireBrowserSlot, BrowserBusyError, isBrowserInUse } from './browser.js';
import { isTransient } from './run.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';

describe('browser slot (one Chromium at a time per instance)', () => {
  // The slot polls with real timers and reads Date.now(): both are faked, so "gives up after the wait" and "admitted at once on release" are decided by
  // the code, not by how long this machine takes to run a test, and nothing here sleeps.
  const held: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    // Every read of the clock moves it on by one millisecond. Normal paths read it a handful of times (a drift of a few ms); a mutant that spins in the
    // microtask queue without ever sleeping (a slot that is never marked free) would otherwise freeze the faked clock and loop for ever, with no way for the
    // test runner to interrupt it. Spinning now runs into the wait limit and fails the test instead.
    const frozen = Date.now.bind(Date);
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => frozen() + reads++);
  });
  afterEach(async () => {
    for (const release of held.splice(0)) release();      // never leave the module's slot taken for the next test
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  /** Wraps a release so it can only act once (a second call of the module's own release would free the slot under whoever holds it by then). */
  const own = (release: () => void) => {
    let done = false;
    const once = () => { if (!done) { done = true; release(); } };
    held.push(once);
    return once;
  };
  /** Settles as 'pending' | 'resolved' | 'rejected' as soon as the promise has settled, without waiting for it. */
  const stateOf = async (p: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> => {
    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    p.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
    await vi.advanceTimersByTimeAsync(0);
    return state;
  };

  /** Takes the slot, which must be free right now: fails at once (nothing hangs) when it is not. */
  const take = async () => {
    const attempt = acquireBrowserSlot(1_000);
    const state = await stateOf(attempt);
    if (state !== 'resolved') throw new Error(`the browser slot should have been free, but the request is ${state}`);
    return own(await attempt);
  };

  it('a second caller waits, gives up with BrowserBusyError only after its wait is over, and succeeds once the first releases', async () => {
    const release1 = await take();
    const second = acquireBrowserSlot(2_000);
    const outcome = second.then(() => 'admitted', e => e);
    await vi.advanceTimersByTimeAsync(1_980);
    expect(await stateOf(second)).toBe('pending');          // still inside its 2 s: it keeps waiting, it is not refused early
    await vi.advanceTimersByTimeAsync(600);                 // its wait is over (it re-checks every 500 ms at most)
    expect(await stateOf(second)).toBe('rejected');         // so it gives up (the queue then redelivers the job to another instance)
    expect(await outcome).toBeInstanceOf(BrowserBusyError);
    expect(isBrowserInUse()).toBe(true);                    // the first holder is untouched by the waiter that gave up
    release1();
    const release2 = await take();
    expect(isBrowserInUse()).toBe(true);
    release2();
    expect(isBrowserInUse()).toBe(false);
  });

  it('a waiter is admitted as soon as the holder releases (no lost wake-up: it does not wait for the next poll)', async () => {
    const release1 = await take();
    const waiter = acquireBrowserSlot(5000).then(own);
    await vi.advanceTimersByTimeAsync(200);
    expect(await stateOf(waiter)).toBe('pending');           // the holder still has it
    release1();
    expect(await stateOf(waiter)).toBe('resolved');          // admitted with NO time passing: only microtasks ran
    expect(isBrowserInUse()).toBe(true);                     // and the waiter now owns the slot
    (await waiter)();
    expect(isBrowserInUse()).toBe(false);
  });

  it('with several waiters only one is admitted per release (the slot is exclusive), and each waits for its own turn', async () => {
    const release1 = await take();
    const results: string[] = [];
    const owners: Array<() => void> = [];
    for (const name of ['a', 'b']) void acquireBrowserSlot(60_000).then(r => { results.push(name); owners.push(own(r)); });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(results).toEqual([]);                            // nobody is admitted while it is held
    release1();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);                        // exactly one of them got it
    expect(isBrowserInUse()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(results).toHaveLength(1);                        // the other keeps waiting, however long the owner keeps it
    owners[0]();                                            // the owner releases
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(2);                        // now the other one is admitted
    expect(new Set(results)).toEqual(new Set(['a', 'b']));
  });

  it('a holder that gave up waiting does not take the slot later, and a release never hands it to a caller that already gave up', async () => {
    const release1 = await take();
    const quitter = acquireBrowserSlot(100);
    const outcome = quitter.catch(e => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stateOf(quitter)).toBe('rejected');
    expect(await outcome).toBeInstanceOf(BrowserBusyError);
    release1();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isBrowserInUse()).toBe(false);                   // nobody was admitted behind the first holder's back
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
