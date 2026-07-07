import { defineConfig, devices } from '@playwright/test';

export const API_URL      = process.env.TEST_API_URL      || 'http://localhost:4000';
export const FRONTEND_URL = process.env.TEST_FRONTEND_URL || 'http://localhost:5173';

export default defineConfig({
  testDir:       './tests',
  fullyParallel: false,   // serial — tests share DB state
  retries:       0,
  workers:       1,
  globalSetup:   './tests/helpers/global-setup.ts',
  reporter:      [['html', { open: 'never' }], ['list']],

  use: {
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: [
    {
      name: 'api',
      testMatch: 'tests/api/**/*.spec.ts',
      use: { baseURL: API_URL },
    },
    {
      name: 'smoke',
      testMatch: 'tests/smoke/**/*.spec.ts',
      use: { baseURL: API_URL },
    },
    {
      name: 'e2e',
      testMatch: 'tests/e2e/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: FRONTEND_URL,
      },
    },
  ],
});
