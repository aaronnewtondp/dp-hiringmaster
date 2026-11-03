import { defineConfig, devices } from '@playwright/test';
import type { PlaywrightTestProject } from '@playwright/test';
import { isLocalTarget } from './tests/helpers/smoke-env';

export const API_URL      = process.env.TEST_API_URL      || 'http://localhost:4000';
export const FRONTEND_URL = process.env.TEST_FRONTEND_URL || 'http://localhost:5173';

const CI = !!process.env.CI;
const OUTPUT_DIR = process.env.PW_OUTPUT_DIR || 'test-results';

const apiProject: PlaywrightTestProject = {
  name: 'api',
  testMatch: 'tests/api/**/*.spec.ts',
  use: { baseURL: API_URL },
};
const smokeProject: PlaywrightTestProject = {
  name: 'smoke',
  testMatch: 'tests/smoke/**/*.spec.ts',
  // Run against production: a failing test must not leave candidate data behind in traces, videos or screenshots.
  use: { baseURL: API_URL, trace: 'off', video: 'off', screenshot: 'off' },
};
const dbProject: PlaywrightTestProject = {
  name: 'db',
  testMatch: 'tests/db/**/*.spec.ts',
  use: { baseURL: API_URL },
};
const e2eProject: PlaywrightTestProject = {
  name: 'e2e',
  testMatch: 'tests/e2e/**/*.spec.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: FRONTEND_URL,
  },
};
// Phone / tablet-width browser checks (the sidebar drawer below `lg:`, touch targets, the PWA install surface). Chromium with an
// iPhone-13-class viewport and touch: the e2e project's engine, so no second browser has to be installed. Specs live in tests/e2e-mobile/.
const e2eMobileProject: PlaywrightTestProject = {
  name: 'e2e-mobile',
  testMatch: 'tests/e2e-mobile/**/*.spec.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: FRONTEND_URL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

// api, db, e2e and e2e-mobile CREATE, CHANGE and DELETE data (and the db specs rewrite tables and settings), so they exist only for a
// local target. Against anything else the one project that is safe is `smoke` (read-only, signs in with the two smoke accounts):
// `playwright test --project=api` against a remote URL stops with "Project(s) "api" not found" instead of running.
const LOCAL = isLocalTarget(API_URL);
if (!LOCAL && !process.env.HMS_PW_CONFIG_WARNED) {
  process.env.HMS_PW_CONFIG_WARNED = '1';
  console.warn(`[playwright.config] TEST_API_URL=${API_URL} is not a local address: only the read-only "smoke" project is enabled.`);
}

export default defineConfig({
  testDir:       './tests',
  outputDir:     OUTPUT_DIR,

  // One worker, files and tests in declaration order, no retries — on purpose, not an oversight:
  //  * every spec shares ONE database, and several files depend on what an earlier test in the same file created (api/10, e2e/07 ...);
  //  * the SLA sweep, the sourcing engine and the dashboard totals are global, so two specs running at once change each other's numbers;
  //  * a retry would restart a failed test in a NEW worker where that module-level state is gone, and a test that skips itself when its
  //    precondition is missing would then pass vacuously instead of failing.
  // Speed comes from running several isolated STACKS side by side (scripts/test-stack.sh), not from parallel workers on one database.
  fullyParallel: false,
  workers:       1,
  retries:       0,
  forbidOnly:    CI,                      // a committed test.only must fail the CI run, not silently narrow it

  timeout:       60_000,                  // the default 30 s is below one real JD generation, one Chromium round trip or a cold SLA sweep
  expect:        { timeout: 10_000 },

  globalSetup:   './tests/helpers/global-setup.ts',

  // Tests that need a real Anthropic key or Google credentials carry `@live` in their title and are skipped unless TEST_LIVE=1
  // (npm run test:live runs ONLY those, with --grep @live).
  grepInvert:    process.env.TEST_LIVE ? undefined : /@live/,

  reporter: CI
    ? [['list'], ['github'], ['junit', { outputFile: `${OUTPUT_DIR}/junit.xml` }], ['html', { open: 'never' }]]
    : [['html', { open: 'never' }], ['list']],

  use: {
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: LOCAL
    ? [apiProject, smokeProject, dbProject, e2eProject, e2eMobileProject]
    : [smokeProject],
});
