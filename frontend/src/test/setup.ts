import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// `globals: false` in vitest.config.ts means RTL can't auto-detect a global
// test framework to hook its automatic per-test cleanup into — without this,
// a component rendered in one test stays in the DOM for the next one.
afterEach(() => {
  cleanup();
});

// Every waitFor / findBy* in the suite used Testing Library's 1000 ms default (265 waitFor and 454 findBy calls, none with an
// explicit timeout), and the first render of a large page under a busy machine took 1.4 s: ScorecardSummary.portfolio.test.tsx
// failed once in five full runs with "Unable to find role=button". This only lengthens how long a test waits for something that
// is EXPECTED to appear. It cannot make an absence assertion pass: those are structural (`queryBy…` is null, a spy was not called
// after the work that would have called it has provably run — see `drain` in ./helpers.ts).
configure({ asyncUtilTimeout: 5000 });

// React Router v6 prints two "Future Flag Warning" lines per <MemoryRouter> (32 lines from 16 files per run), which buries any real
// warning. Only those two exact notices are dropped; every other console.warn still goes through.
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('React Router Future Flag Warning')) return;
  realWarn(...args);
};
