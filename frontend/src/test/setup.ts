import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `globals: false` in vitest.config.ts means RTL can't auto-detect a global
// test framework to hook its automatic per-test cleanup into — without this,
// a component rendered in one test stays in the DOM for the next one.
afterEach(() => {
  cleanup();
});
