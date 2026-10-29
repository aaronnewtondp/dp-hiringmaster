import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
    // The suite runs on shared machines and CI runners. A test that is only slow (the first render of a big page, a 40-row FAQ
    // looked up by role and name) must not fail because the box is busy: Vitest's own 5 s default was reached by Help.test.tsx
    // under load (the work is synchronous, so only the awaited parts even gave the timeout a chance to fire). Raising these
    // only lengthens how long we wait for something that is expected to happen; absence is always asserted structurally.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
