import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // A timeout here is a HANG detector, not a performance assertion (the timing tests measure CPU time or compare costs inside the test itself). Vitest's
    // default is 5 s: it failed the tests that start a real pdf-parse child process, render PDFs with pdfkit or walk 8-16 MB hostile files whenever the
    // machine was busy (8 of the 18 failures in the audited loaded run), although each takes 0.1-3 s on a quiet machine. 30 s is 10x the slowest of those
    // and still ends a real hang quickly. A describe or test that needs more sets its own, as pdf.cpu, sandbox and the hostile-file suites do.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
