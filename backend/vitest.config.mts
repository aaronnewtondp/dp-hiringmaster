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
    // No pool options: since vitest 4 `vitest run --maxWorkers=N` works as it is (on 2.1.9 a maximum below the default minimum, cores - 1, made the run find NO tests, which needed
    // `poolOptions.forks.minForks: 1`; that option was removed in 4). Checked on 5.1 with =1, =2, =4 and =16. Every file still runs in a fresh process (isolation on).
  },
});
