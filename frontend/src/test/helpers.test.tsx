import { useEffect, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { getConfig, render, screen } from '@testing-library/react';
import { drain, expectLinearCpu, cpuMs, bestCpuMs } from './helpers.ts';

// The frontend has no @types/node, so the one Node global used here is typed by hand (as in helpers.ts).
const nodeProcess = (globalThis as unknown as { process: { cpuUsage(previous?: { user: number; system: number }): { user: number; system: number } } }).process;
const nodeSetImmediate = (globalThis as unknown as { setImmediate: (callback: () => void) => unknown }).setImmediate;
/** Spins until the process has used `ms` milliseconds of CPU time: the same cost on a fast machine and a slow one, loaded or not. */
function burn(ms: number): void {
  const start = nodeProcess.cpuUsage();
  for (;;) { const spent = nodeProcess.cpuUsage(start); if ((spent.user + spent.system) / 1000 >= ms) return; }
}

// The stability work of this suite stands on three things: the settings in setup.ts / vitest.config.ts, `drain` (which replaced every "sleep 20 ms, then
// assert something was NOT called") and `expectLinearCpu` (which replaced every wall-clock bound). If any of them quietly stopped doing its job, the
// tests built on it would keep passing while proving nothing — so each is pinned here, and each test can fail.

describe('setup.ts', () => {
  it('Testing Library waits up to 5 s for something that is expected to appear (its default is 1 s, which a busy machine exceeds on a first render)', () => {
    expect(getConfig().asyncUtilTimeout).toBe(5000);
  });
});

describe('drain — everything already in flight has run when it returns', () => {
  it('runs a promise chain, a zero-delay timer and the work they queue in turn (timer -> promise -> timer)', async () => {
    const log: string[] = [];
    setTimeout(() => {
      log.push('timer 1');
      void Promise.resolve().then(() => { log.push('promise'); setTimeout(() => log.push('timer 2'), 0); });
    }, 0);
    let chain = Promise.resolve();
    for (let i = 0; i < 20; i++) chain = chain.then(() => { log.push(`micro ${i}`); });
    await drain();
    expect(log).toContain('timer 1');
    expect(log).toContain('promise');
    expect(log).toContain('timer 2');
    expect(log.filter(l => l.startsWith('micro'))).toHaveLength(20);
  });

  it('follows a chain of eight zero-delay timers, each queued by the one before (the depth drain() promises by default)', async () => {
    let ran = 0;
    const link = (n: number) => { ran = n; if (n < 8) setTimeout(() => link(n + 1), 0); };
    setTimeout(() => link(1), 0);
    await drain();
    expect(ran).toBe(8);
  });

  it('one turn runs a timer AND the setImmediate that timer queued (the check phase is where React runs passive effects)', async () => {
    const log: string[] = [];
    setTimeout(() => { log.push('timer'); nodeSetImmediate(() => log.push('immediate')); }, 0);
    await drain(1);
    expect(log).toEqual(['timer', 'immediate']);
  });

  // React's own act() already waits one check phase when its async scope ends, so ONE immediate queued by a timer would be caught even without drain's own
  // `setImmediate` step (the test above cannot tell). A second, nested immediate can only be caught by that step: it is queued during the first one's check
  // phase, so it runs after act's single wait unless drain waits one more phase itself.
  it('follows an immediate that queues another immediate (the second check phase is drain\'s own step, not act\'s)', async () => {
    const log: string[] = [];
    setTimeout(() => {
      log.push('timer');
      nodeSetImmediate(() => { log.push('immediate 1'); nodeSetImmediate(() => log.push('immediate 2')); });
    }, 0);
    await drain(1);
    expect(log).toEqual(['timer', 'immediate 1', 'immediate 2']);
  });

  it('a state change queued by a mount effect has rendered when it returns — no waitFor needed', async () => {
    function Late() {
      const [text, setText] = useState('first');
      useEffect(() => { setTimeout(() => setText('second'), 0); }, []);
      return <p>{text}</p>;
    }
    render(<Late />);
    expect(screen.getByText('first')).toBeInTheDocument();
    await drain();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('is what turns "was never called" into a real claim: a call scheduled by an effect after the first render is seen by it', async () => {
    const calls: string[] = [];
    function Asks() {
      const [ready, setReady] = useState(false);
      useEffect(() => { setTimeout(() => setReady(true), 0); }, []);
      useEffect(() => { if (ready) calls.push('asked'); }, [ready]);
      return null;
    }
    render(<Asks />);
    expect(calls).toEqual([]);          // right after the render nothing has been asked yet: asserting absence HERE would pass whatever the code does
    await drain();
    expect(calls).toEqual(['asked']);   // and after drain it has, so an absence asserted after drain means the code never asks
  });
});

// The synthetic costs are in plain loops so the test measures the helper, not the code under test elsewhere. Sizes are chosen so the small run is well above the
// helper's 2 ms noise floor and the large run is a fraction of a second.
describe('expectLinearCpu — passes linear code, fails quadratic code', () => {
  const sink = { value: 0 };
  const linear = (n: number) => { let s = 0; for (let i = 0; i < n * 2000; i++) s += i % 7; sink.value = s; };
  const quadratic = (n: number) => { let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += (i ^ j) % 7; sink.value = s; };

  it('a linear function passes and reports a growth ratio near 1', () => {
    const { ratio } = expectLinearCpu(linear, 2_000, 16_000, 'linear loop');
    expect(ratio).toBeLessThan(4);
  });

  it('a quadratic function is refused, with the measured costs in the message', () => {
    expect(() => expectLinearCpu(quadratic, 2_000, 16_000, 'quadratic loop')).toThrow(/quadratic loop is not linear/);
  });

  it('a function that already projects past the backstop at linear cost is refused without running the large size at all', () => {
    // `burn` spins until the process has used that much CPU time, so the cost is the same on a fast and a slow machine, loaded or not.
    // Small size: 150 ms of CPU. At 100x that would be 15 s of CPU, above the 10 s backstop, so the large size must never be attempted.
    let largeRuns = 0;
    const run = (n: number) => { if (n === 100_000) largeRuns++; burn(n === 1_000 ? 150 : 0); };
    expect(() => expectLinearCpu(run, 1_000, 100_000, 'slow')).toThrow(/cannot stay under the 10000 ms backstop/);
    expect(largeRuns).toBe(0);
  });
});

describe('cpuMs / bestCpuMs', () => {
  const sink = { value: 0 };
  const spin = (iterations: number) => () => { let s = 0; for (let i = 0; i < iterations; i++) s += i % 3; sink.value = s; };

  it('measure CPU time that grows with the work done', () => {
    const light = bestCpuMs(spin(1e4));
    const heavy = bestCpuMs(spin(1e8));
    expect(light).toBeGreaterThanOrEqual(0);
    expect(heavy).toBeGreaterThan(light);
  });

  // Noise only ever ADDS to a measurement, so the cheapest run is the honest one: the first, the last or the largest of the runs would each make expectLinearCpu
  // noisier and flakier without changing anything else, which is why the position of the cheap run is varied.
  it.each([
    ['the first run is the expensive one', [40, 0, 0]],
    ['the last runs are the expensive ones', [0, 40, 40]],
    ['only the middle run is cheap', [40, 0, 40]],
  ])('bestCpuMs is the LOWEST of its runs: %s', (_label, costs) => {
    let call = 0;
    const best = bestCpuMs(() => { burn(costs[call++]); }, 3);
    expect(call).toBe(3);
    expect(best).toBeLessThan(20);                 // the cheap run costs ~0 ms of CPU; any of the 40 ms runs would break this
  });

  it('cpuMs runs the function exactly once and bestCpuMs at most `runs` times (a run already past 500 ms is not repeated)', () => {
    let runs = 0;
    cpuMs(() => { runs++; });
    expect(runs).toBe(1);
    runs = 0;
    bestCpuMs(() => { runs++; }, 5);
    expect(runs).toBe(5);
    runs = 0;
    bestCpuMs(() => { runs++; burn(600); }, 5);
    expect(runs).toBe(1);
  });
});
