// Imported first by the candidate-page test files, which render large tables and whole pages many times each.
// The suite's defaults (5 s per test, 1 s per waitFor/findBy) are tuned for a quiet machine: with other work running they
// were hit by tests that are correct, so these files get a wide margin. Only how long a test may wait changes — what is
// asserted, and any fake clock a test uses, is untouched, and a test that waits for something that never happens still fails.
import { vi } from 'vitest';
import { configure } from '@testing-library/react';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });
