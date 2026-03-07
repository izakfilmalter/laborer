import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',

  /* Maximum time one test can run for */
  timeout: 30_000,

  /* Assertion/locator timeout */
  expect: {
    timeout: 10_000,
  },

  /* Retry on failure to handle rare flakiness from real service startup timing */
  retries: 1,

  /* Run tests sequentially since they share real backend services */
  workers: 1,

  /* Reporter to use */
  reporter: 'list',

  /* Shared settings for all projects */
  use: {
    baseURL: 'http://localhost:3001',
    /* Capture screenshot on failure for debugging */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  /* WebKit only — matches Tauri's engine on macOS */
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  /* Global setup and teardown — managed externally, not via webServer */
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
})
