import { expect } from 'vitest';
import { act } from '@testing-library/react';

// The frontend has no @types/node (the tests run in Node, the app in a browser), so the two Node globals used below are typed here, by hand.
const nodeProcess = (globalThis as unknown as { process: { cpuUsage(previous?: { user: number; system: number }): { user: number; system: number } } }).process;
const nodeSetImmediate = (globalThis as unknown as { setImmediate: (callback: () => void) => unknown }).setImmediate;

/**
 * Lets everything that is ALREADY in flight run to completion: promise reactions, React's scheduler (passive effects, deferred
 * renders), react-query's `setTimeout(0)` notification batching, and anything those queue in turn.
 *
 * This is for asserting that something was NOT called ("the workspace endpoint is never asked", "the list is not fetched yet").
 * A fixed sleep (`await new Promise(r => setTimeout(r, 20))`) proves absence only when the machine is fast enough for the unwanted
 * call to have landed inside 20 ms; this counts event-loop turns instead of milliseconds, so the answer does not depend on load.
 * Each turn waits for a timer queued now to fire (Node runs timers of equal delay in the order they were queued, so every
 * `setTimeout(0)` queued earlier has already fired by then) and then for the check phase (`setImmediate`, which React's scheduler
 * uses). `turns` is how long a chain of "this schedules that" the helper follows; the default is several times the deepest chain
 * in this app (query settles -> notify -> render -> passive effect -> second query).
 *
 * Use it ONLY with real timers: under `vi.useFakeTimers()` the `setTimeout` below never fires — advance the fake clock instead.
 * It does not replace a positive wait: first wait for the signal that the work being checked has started or finished
 * (`await screen.findBy…`, `waitFor(() => expect(spy).toHaveBeenCalled())`), then `drain()`, then assert the absence.
 */
export async function drain(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await new Promise<void>(resolve => nodeSetImmediate(resolve));
    });
  }
}

/**
 * CPU time (user + system, in milliseconds) the test process spends running `fn`. Unlike a wall clock it does not grow when other
 * processes compete for the cores — the wall-clock bounds this replaces failed in 2 of 5 full runs on a busy machine
 * ("expected 2052 to be less than 2000") although the code was no slower.
 */
export function cpuMs(fn: () => void): number {
  const before = nodeProcess.cpuUsage();
  fn();
  const spent = nodeProcess.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

/** The lowest CPU time over a few runs (noise only ever adds to a measurement). A run that is already slow is not repeated. */
export function bestCpuMs(fn: () => void, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    best = Math.min(best, cpuMs(fn));
    if (best > 500) break;
  }
  return best;
}

/** Measurements below this are noise (timer granularity, one stray GC); they are never used as a divisor. */
const CPU_FLOOR_MS = 2;
/** Whatever the input, no single call may take this much CPU: far above any linear run, far below what a quadratic one costs on 10^5 characters. */
export const CPU_BACKSTOP_MS = 10_000;

/**
 * Asserts that `run(n)` costs about linear CPU time: it measures `run(small)` and `run(large)` (`large` should be 8x `small`),
 * and the cost per unit may grow by at most `slack`x. A linear function scores ~1, a quadratic one ~8, so the default slack of 4
 * leaves a wide gap on both sides (measured: linear code scores 0.05 to 1.6, even at a machine load average above 100). The ratio
 * is of CPU times, so a loaded machine inflates both sides alike.
 * It fails fast: when the small run alone projects past the backstop even at linear cost, the large one is not attempted (a
 * quadratic regression would otherwise spend minutes proving what the small run already shows).
 * Returns the measurements so a caller can assert more.
 */
export function expectLinearCpu(run: (n: number) => void, small: number, large: number, label = 'input', slack = 4): { small: number; large: number; ratio: number } {
  run(small);                                              // warm-up: the first call pays for compiling the regexes
  const t1 = Math.max(bestCpuMs(() => run(small)), CPU_FLOOR_MS);
  expect(t1 * (large / small), `${label}: ${small} units took ${t1.toFixed(1)} ms of CPU, so ${large} units cannot stay under the ${CPU_BACKSTOP_MS} ms backstop`).toBeLessThan(CPU_BACKSTOP_MS);
  const t2 = bestCpuMs(() => run(large));
  const ratio = t2 / t1 / (large / small);
  expect(t2, `${label}: ${large} units took ${Math.round(t2)} ms of CPU (backstop ${CPU_BACKSTOP_MS} ms)`).toBeLessThan(CPU_BACKSTOP_MS);
  expect(ratio, `${label} is not linear: ${small} units took ${t1.toFixed(1)} ms of CPU, ${large} units took ${t2.toFixed(1)} ms`).toBeLessThan(slack);
  return { small: t1, large: t2, ratio };
}
