import { describe, it, expect, afterEach } from 'vitest';
import { performance } from 'perf_hooks';
import {
  REFERENCE_WORKLOAD_MS, advancingClock, assertLinear, assertLinearOn, cpuNowMs, expectCpuUnder, expectCpuUnderAsync, hostSlowdown, minCpu, scaled, steadyHeartbeat,
  withHeartbeat,
} from './timing.js';

// The helpers in timing.ts replaced dozens of "took under N milliseconds" assertions. A replacement is only worth having if it can still FAIL for the thing
// the old assertion guarded, and cannot fail for a slow or busy machine. These tests pin both halves on purpose-built functions: a linear one, a quadratic
// one, one that stalls this thread, one that only waits. Each case is a ratio or a floor-and-ceiling with a wide margin, never a bare millisecond figure.

/** Spends `ms` of this process's CPU time, synchronously (CPU time, not wall time, so a descheduled process still ends up having done the work). */
function burnCpu(ms: number): void {
  const end = cpuNowMs() + ms;
  while (cpuNowMs() < end) { /* burn */ }
}
/** Work that is linear in `n`. */
function linearWork(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = (s * 31 + i) | 0; return s; }
/** Work that is quadratic in `n` (a nested pass: the shape of the regex and the restarted-search bugs the speed guards exist for). */
function quadraticWork(n: number): number { let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s = (s * 31 + i + j) | 0; return s; }

describe('assertLinear', () => {
  it('passes a linear function, however the machine is doing: the speed cancels out of the ratio', () => {
    const r = assertLinear('linear', linearWork, 2_000_000, 16_000_000);
    expect(r.bigMs).toBeLessThanOrEqual(r.allowedMs);
  });

  it('fails a quadratic function (8x the input, 64x the work), and says what it measured', () => {
    expect(() => assertLinear('quadratic', quadraticWork, 800, 6_400)).toThrow(/quadratic: size 6400 used [\d.]+ ms of CPU, size 800 used [\d.]+ ms; linear scaling allows/);
  });

  it('a function that is linear but 4x slower per item still passes: only the SHAPE of the cost is judged, not its size', () => {
    assertLinear('slow linear', n => { for (let k = 0; k < 4; k++) linearWork(n); }, 2_000_000, 16_000_000);
  });
});

describe('assertLinear: noise on the big input is retried, a regression is not', () => {
  it('passes when only the first few big runs are disturbed (correlated noise on a loaded machine: three slow runs in a row, then a clean one)', () => {
    let bigCalls = 0;
    const r = assertLinear('noisy', n => { if (n === 100) { burnCpu(2); return; } bigCalls++; burnCpu(bigCalls <= 3 ? 400 : 16); }, 100, 800, { floorMs: 5, runs: 3 });
    expect(bigCalls).toBe(4);
    expect(r.bigMs).toBeLessThanOrEqual(r.allowedMs);
  });

  it('still fails when EVERY attempt is over the bound (a quadratic path at 8x the input is ~2.7x over, however often it is measured)', () => {
    let bigCalls = 0;
    expect(() => assertLinear('always slow', n => { if (n === 100) burnCpu(2); else { bigCalls++; burnCpu(2 * 64 * 0.9); } }, 100, 800, { floorMs: 0, runs: 3 })).toThrow(/always slow: size 800/);
    expect(bigCalls).toBeGreaterThan(3);                      // it did retry before failing
  });
});

describe('assertLinearOn', () => {
  it('passes a linear function and holds the big input to the absolute backstop as well', () => {
    const made: number[] = [];
    const r = assertLinearOn('linear on', n => { made.push(n); return n; }, linearWork, 2_000_000, 16_000_000, { backstopMs: 5_000 });
    expect(made).toEqual([2_000_000, 16_000_000]);           // both inputs are built once, before anything is measured
    expect(r.bigMs).toBeLessThan(scaled(5_000));
  });

  it('fails a function that is linear in shape but over the absolute backstop (a path a hundred times slower than it was)', () => {
    expect(() => assertLinearOn('slow', n => n, n => { burnCpu(n); }, 10, 20, { backstopMs: 1, runs: 1 })).toThrow(/the big input alone/);
  });

  it('fails a quadratic function even when its big input is under the backstop', () => {
    expect(() => assertLinearOn('quadratic on', n => n, quadraticWork, 800, 6_400, { backstopMs: 600_000 })).toThrow(/linear scaling allows/);
  });
});

describe('expectCpuUnder', () => {
  it('fails work that uses more CPU than the (scaled) bound, naming how much it used', () => {
    expect(() => expectCpuUnder(1, () => burnCpu(40), 'burner')).toThrow(/burner: used [\d.]+ ms of CPU, the bound is [\d.]+ ms/);
  });

  it('passes work that is well inside it and returns what the work returned', () => {
    expect(expectCpuUnder(2_000, () => linearWork(1_000), 'cheap')).toBe(linearWork(1_000));
  });

  it('does not count time spent waiting: a process that is descheduled (here: asleep) for four times the bound has used almost none of its CPU', async () => {
    // (process.cpuUsage covers every thread of the process, so a little background work of V8 can show up here: the bound leaves a wide margin for it)
    await expectCpuUnderAsync(100, () => new Promise<void>(resolve => setTimeout(resolve, 400)), 'asleep');
  });

  it('...but the async form still fails work that burns CPU', async () => {
    await expect(expectCpuUnderAsync(1, async () => { burnCpu(40); }, 'async burner')).rejects.toThrow(/async burner: used/);
  });
});

describe('minCpu and the machine calibration', () => {
  it('reports the smallest of the runs (a pause only ever adds time) and the first run\'s result', () => {
    let calls = 0;
    const r = minCpu(() => { calls++; if (calls === 1) burnCpu(60); return calls; }, 3);
    expect(calls).toBe(3);
    expect(r.value).toBe(1);
    expect(r.ms).toBeLessThan(30);                        // the 60 ms first run is not what is reported
  });

  it('hostSlowdown is between 1 and 6 and scaled() applies it to a bound', () => {
    const s = hostSlowdown();
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(6);
    expect(scaled(100)).toBeCloseTo(100 * s, 6);
    expect(hostSlowdown()).toBe(s);                       // measured once per process
    expect(REFERENCE_WORKLOAD_MS).toBeGreaterThan(0);
  });
});

describe('steadyHeartbeat: a stall that belongs to the code shows every time, a one-off pause does not', () => {
  it('a thread that is blocked for 150 ms on every run is reported as blocked (the guard still fails for the real thing)', async () => {
    const r = await steadyHeartbeat(async () => { burnCpu(150); }, 100, { tries: 3, tickMs: 5 });
    expect(r.maxGapMs).toBeGreaterThanOrEqual(140);
  });

  it('a pause on the first run only is measured away: the second, clean run is the one reported', async () => {
    let runs = 0;
    const r = await steadyHeartbeat(async () => { runs++; if (runs === 1) burnCpu(150); }, 100, { tries: 4, tickMs: 5 });
    expect(runs).toBe(2);                                 // measured again once, then stopped: the gap was under the limit
    expect(r.maxGapMs).toBeLessThan(100);
  });

  it('a gap under the limit is not measured again at all', async () => {
    let runs = 0;
    await steadyHeartbeat(async () => { runs++; }, 100, { tries: 4, tickMs: 5 });
    expect(runs).toBe(1);
  });

  /** Blocks this thread for `ms` of WALL time without using CPU: what an overloaded machine does to a process it does not schedule. */
  function notScheduled(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

  it('cpuAware: a thread held by code that BURNS CPU still shows the whole stall (an in-process pass that does not hand the loop back is caught)', async () => {
    const r = await steadyHeartbeat(async () => { burnCpu(150); }, 100, { tries: 3, tickMs: 5, cpuAware: true });
    expect(r.maxGapMs).toBeGreaterThanOrEqual(130);        // the CPU it burned, a little under the 150 ms wall
  });

  it('cpuAware: time the process simply was not running (descheduled on an overloaded machine) is not a stall, while the default wall-clock gap still counts it', async () => {
    const wall = await withHeartbeat(async () => { notScheduled(200); }, 5);
    expect(wall.maxGapMs).toBeGreaterThanOrEqual(190);     // the wall gap sees it (a synchronous wait of a child process is caught this way)
    const cpu = await withHeartbeat(async () => { notScheduled(200); }, 5, { cpuAware: true });
    expect(cpu.maxGapMs).toBeLessThan(60);                 // it used almost no CPU in those 200 ms
  });

  it('cpuAware reaches steadyHeartbeat: a stall that is over the limit on every run is reported, an unscheduled gap is measured away', async () => {
    const stalled = await steadyHeartbeat(async () => { burnCpu(150); }, 100, { tries: 2, tickMs: 5, cpuAware: true });
    expect(stalled.maxGapMs).toBeGreaterThanOrEqual(130);
    const idle = await steadyHeartbeat(async () => { notScheduled(150); }, 100, { tries: 2, tickMs: 5, cpuAware: true });
    expect(idle.maxGapMs).toBeLessThan(100);
  });

  it('withHeartbeat counts the ticks a cooperative pass gives the event loop, and none for a synchronous one', async () => {
    const sync = await withHeartbeat(async () => { burnCpu(60); }, 5);
    expect(sync.ticks).toBeLessThanOrEqual(1);
    const cooperative = await withHeartbeat(async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => setTimeout(r, 20)); }, 5);
    expect(cooperative.ticks).toBeGreaterThan(sync.ticks);
  });
});

describe('advancingClock: a clock on which every slice is a long one', () => {
  let clock: ReturnType<typeof advancingClock> | undefined;
  afterEach(() => { clock?.restore(); clock = undefined; });

  it('moves performance.now() on by exactly one step per read, and counts the reads', () => {
    clock = advancingClock(21);
    expect([performance.now(), performance.now(), performance.now()]).toEqual([21, 42, 63]);
    expect(clock.reads()).toBe(3);
  });

  it('a step of 0 holds the clock still (no slice can ever be long)', () => {
    clock = advancingClock(0);
    expect(performance.now()).toBe(0);
    expect(performance.now()).toBe(0);
  });

  it('restore puts the real clock back', () => {
    advancingClock(1_000_000).restore();
    const a = performance.now();
    const b = performance.now();
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThan(1_000);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
