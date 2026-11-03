// Test-only helpers for the tests that guard against a slow or stalling code path (a quadratic regex, a pass that hogs the event loop).
//
// Why they exist: those tests used to compare ONE wall-clock reading with a fixed number of milliseconds. On a shared or slower machine that fails with
// no regression (a descheduled process, a busy neighbour, a 2 vCPU runner), and on a fast one it can pass with a real one. Everything here keeps the
// meaning of the guard and drops the dependence on how fast, or how busy, the machine is:
//   * CPU time of this process (process.cpuUsage), not wall time: being descheduled costs none of it;
//   * the smallest of a few runs: noise (a garbage-collection pause, a cold cache) only ever adds time;
//   * a COST RATIO between a big and a small input in the same process (assertLinear) for "this is linear" claims, so the machine's speed cancels;
//   * a calibration of the machine against a fixed reference workload (hostSlowdown) for the few absolute bounds that remain, which exist to catch
//     failures that are 10x or 100x too slow, not 1.5x;
//   * a clock that crosses the 20 ms slice on every read (advancingClock), so "the pass gave the event loop a turn" is decided by the code, not by
//     whether this machine happened to be slow enough to run a pass for 20 ms.
// This file is not imported by anything that ships: only *.test.ts files use it (tsc still compiles it with the rest of src/).
import { performance } from 'perf_hooks';
import { expect, vi } from 'vitest';

/** With TIMING_DEBUG=1 every CPU reading is printed with the name of the test it belongs to (how much margin does each bound have on this machine?). */
function report(ms: number): void {
  if (process.env.TIMING_DEBUG) process.stderr.write(`[timing] ${ms.toFixed(2)} ms: ${expect.getState().currentTestName ?? '(outside a test)'}\n`);
}

/** CPU time (user + system, every thread of this process) used so far, in milliseconds. */
export function cpuNowMs(): number {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
}

/** Runs `work` once; returns what it returned and the CPU time it used. */
export function cpuTimed<T>(work: () => T): { value: T; ms: number } {
  const before = cpuNowMs();
  const value = work();
  const ms = cpuNowMs() - before;
  report(ms);
  return { value, ms };
}

/** The async form of cpuTimed. (CPU time of THIS process: a child process's work is not in it.) */
export async function cpuTimedAsync<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const before = cpuNowMs();
  const value = await work();
  const ms = cpuNowMs() - before;
  report(ms);
  return { value, ms };
}

/**
 * The smallest CPU cost of `runs` runs of `work` (and the first run's result). A stall is the code's and shows in every run; a pause for garbage collection or
 * a cold cache is not and does not.
 */
export function minCpu<T>(work: () => T, runs = 3): { value: T; ms: number } {
  const first = cpuTimed(work);
  let best = first.ms;
  for (let i = 1; i < runs; i++) best = Math.min(best, cpuTimed(work).ms);
  return { value: first.value, ms: best };
}

/** minCpu for work that returns a promise. */
export async function minCpuAsync<T>(work: () => Promise<T>, runs = 3): Promise<{ value: T; ms: number }> {
  const first = await cpuTimedAsync(work);
  let best = first.ms;
  for (let i = 1; i < runs; i++) best = Math.min(best, (await cpuTimedAsync(work)).ms);
  return { value: first.value, ms: best };
}

// ─── how fast is this machine? ───────────────────────────────────────────────────────────────────────────────────

/** What the reference workload below costs (CPU ms, smallest of several runs) on the 10-core arm64 laptop the bounds in the tests were written on. */
export const REFERENCE_WORKLOAD_MS = 30;
/** The calibration never reports a machine slower than this, so a calibration run that was itself disturbed cannot switch a bound off. */
const MAX_SLOWDOWN = 6;

/** A fixed amount of the work the guarded code does: building and splitting strings, a regex pass, and a native buffer search. */
function referenceWorkload(): number {
  let sum = 0;
  const text = 'a plain sentence about a brand campaign, 38% more enquiries. '.repeat(20_000);
  for (const word of text.split(' ')) sum += word.length;
  sum += text.replace(/campaign|enquiries/g, m => m.toUpperCase()).length;
  const buf = Buffer.from(text, 'latin1');
  let at = 0;
  for (let i = 0; i < 40 && at >= 0; i++) { at = buf.indexOf('enquiries', at + 1); sum += at; }
  return sum;
}

let slowdown: number | undefined;
/**
 * How many times slower than the reference machine this one is at the moment this is first called (1 = as fast or faster; never more than 6), measured as
 * the smallest CPU cost of the reference workload over a few runs. Called once per test file (each file is its own process). Use it to scale an ABSOLUTE
 * bound that guards against something 10x or more too slow: `bound * hostSlowdown()`.
 */
export function hostSlowdown(): number {
  if (slowdown === undefined) {
    referenceWorkload();                                       // warm-up
    let ms = Infinity;                                         // (read straight off the CPU counter: the calibration is not one of the test's own readings)
    for (let i = 0; i < 7; i++) { const before = cpuNowMs(); referenceWorkload(); ms = Math.min(ms, cpuNowMs() - before); }
    slowdown = Math.min(MAX_SLOWDOWN, Math.max(1, ms / REFERENCE_WORKLOAD_MS));
  }
  return slowdown;
}

/** An absolute bound, in milliseconds, scaled to this machine. */
export const scaled = (boundMs: number): number => boundMs * hostSlowdown();

// ─── "this is linear" ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Asserts that `run(big)` costs no more CPU than linear scaling from `run(small)` allows: `factor` x (big / small) x (small's cost) plus a small floor for
 * noise. A quadratic code path costs (big / small) x more than that, so it fails; the speed of the machine cancels out, which no fixed number of
 * milliseconds can do. Choose `small` so that it costs a few milliseconds or more (below that the floor hides everything) and `big` so that a quadratic
 * version would still finish: a ratio of 4 to 10 between them is plenty. Returns what it measured so a test can also report it.
 */
export function assertLinear(
  label: string,
  run: (size: number) => unknown,
  small: number,
  big: number,
  opts: { factor?: number; floorMs?: number; runs?: number } = {},
): { smallMs: number; bigMs: number; allowedMs: number } {
  const { factor = 3, floorMs = 20, runs = 3 } = opts;
  run(small);                                                   // warm-up: compiled regular expressions, JIT, caches
  const smallMs = minCpu(() => run(small), runs).ms;
  const allowedMs = factor * (big / small) * smallMs + floorMs * hostSlowdown();
  // The big input is run again only when the first run is close enough to the bound for noise to matter: a run that is already many times over it is a
  // regression, not a pause for garbage collection, and a quadratic path can take minutes per run (repeating it would only slow the failure down).
  let bigMs = cpuTimed(() => run(big)).ms;
  for (let again = 1; again < runs && bigMs > allowedMs && bigMs <= 8 * allowedMs; again++) bigMs = Math.min(bigMs, cpuTimed(() => run(big)).ms);
  expect(
    bigMs,
    `${label}: size ${big} used ${bigMs.toFixed(1)} ms of CPU, size ${small} used ${smallMs.toFixed(1)} ms; linear scaling allows ${allowedMs.toFixed(1)} ms`,
  ).toBeLessThanOrEqual(allowedMs);
  return { smallMs, bigMs, allowedMs };
}

/**
 * `assertLinear` for "this input family stays linear": `make(size)` builds the input (both are built BEFORE anything is measured, so building is never counted),
 * `run(input)` is the code under test. Also holds the big input to an absolute `scaled(backstopMs)`, for a path that is linear but a hundred times slower than
 * it was. (A fixed millisecond bound alone is blind to a quadratic walk made of native searches that costs 0.9 s where the bound is 1 s.)
 */
export function assertLinearOn<I>(
  label: string,
  make: (size: number) => I,
  run: (input: I) => unknown,
  small: number,
  big: number,
  opts: { backstopMs?: number; runs?: number; factor?: number } = {},
): { smallMs: number; bigMs: number; allowedMs: number } {
  const { backstopMs = 1000, runs = 3, factor } = opts;
  const inputs = new Map<number, I>([[small, make(small)], [big, make(big)]]);
  const r = assertLinear(label, size => run(inputs.get(size) as I), small, big, { runs, factor });
  expect(r.bigMs, `${label}: the big input alone`).toBeLessThan(scaled(backstopMs));
  return r;
}

// ─── "this is not slow" (absolute, in CPU time, scaled to the machine) ───────────────────────────────────────────

/**
 * Runs `work` and fails if it used more than `boundMs` of this process's CPU time, scaled to the machine (`scaled`). For code that is synchronous on this
 * thread: the bound exists to catch a quadratic pass or catastrophic backtracking (seconds or minutes on these inputs), so it is set at 5x or more above what
 * the code costs, and neither a descheduled process nor a slower runner can fail it.
 */
export function expectCpuUnder<T>(boundMs: number, work: () => T, label = 'work'): T {
  const { value, ms } = cpuTimed(work);
  expect(ms, `${label}: used ${ms.toFixed(1)} ms of CPU, the bound is ${scaled(boundMs).toFixed(0)} ms`).toBeLessThan(scaled(boundMs));
  return value;
}

/** expectCpuUnder for work that returns a promise (the CPU of THIS process: a child process's work is not in it, so use it for in-process passes). */
export async function expectCpuUnderAsync<T>(boundMs: number, work: () => Promise<T>, label = 'work'): Promise<T> {
  const { value, ms } = await cpuTimedAsync(work);
  expect(ms, `${label}: used ${ms.toFixed(1)} ms of CPU, the bound is ${scaled(boundMs).toFixed(0)} ms`).toBeLessThan(scaled(boundMs));
  return value;
}

// ─── is this thread's event loop getting its turns? ──────────────────────────────────────────────────────────────

/** Largest gap between ticks of a `tickMs` timer on THIS thread while `work` runs, how many ticks there were, and what `work` returned. */
export async function withHeartbeat<T>(work: () => Promise<T>, tickMs = 5): Promise<{ value: T; maxGapMs: number; ticks: number }> {
  let last = process.hrtime.bigint();
  let max = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    max = Math.max(max, Number(now - last) / 1e6);
    last = now;
    ticks++;
  }, tickMs);
  try {
    const value = await work();
    const tail = Number(process.hrtime.bigint() - last) / 1e6;
    return { value, maxGapMs: Math.max(max, tail), ticks };
  } finally {
    clearInterval(timer);
  }
}

/**
 * withHeartbeat, but a gap at or over `limitMs` is measured again (up to `tries` runs in all) and the SMALLEST is reported. A stall that belongs to the code
 * shows up every time; a gap that is only this process being descheduled on a busy machine does not. `work` must be safe to run again.
 */
export async function steadyHeartbeat<T>(work: () => Promise<T>, limitMs: number, opts: { tries?: number; tickMs?: number } = {}): Promise<{ value: T; maxGapMs: number; ticks: number }> {
  const { tries = 4, tickMs = 5 } = opts;
  let best = await withHeartbeat(work, tickMs);
  for (let again = 1; again < tries && best.maxGapMs >= limitMs; again++) {
    const next = await withHeartbeat(work, tickMs);
    if (next.maxGapMs < best.maxGapMs) best = next;
  }
  return best;
}

// ─── a clock that makes every slice a long one ───────────────────────────────────────────────────────────────────

/**
 * Makes `performance.now()` advance `stepMs` on every read (the clock `runCooperatively` times its slices with), so a pass that asks "has this slice lasted
 * 20 ms?" is told yes at its first check, whatever the machine's speed. Returns `restore`; call it in a `finally` (or an afterEach). Only the clock moves:
 * nothing waits, and `Date.now()` is untouched.
 */
export function advancingClock(stepMs: number): { restore: () => void; reads: () => number } {
  let t = 0;
  let reads = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => { reads++; t += stepMs; return t; });
  return { restore: () => spy.mockRestore(), reads: () => reads };
}
