import { defineConfig } from '@playwright/test'

const vitePort = Number(process.env.VITE_PORT ?? 2101)

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',

  /* Maximum time one test can run for */
  timeout: 60_000,

  /* Assertion/locator timeout */
  expect: {
    timeout: 15_000,
  },

  /* Retry on failure to handle flakiness from xterm.js keyboard capture
   * and real service startup timing. Panel system tests with Ctrl+B
   * shortcuts are particularly affected by xterm.js focus races. */
  retries: 2,

  /* Run tests sequentially since they share real backend services */
  workers: 1,

  /* Reporter to use */
  reporter: 'list',

  /* Shared settings — no baseURL since Electron provides the page */
  use: {
    /* Capture screenshot on failure for debugging */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  /* Single project — Electron provides the browser context */
  projects: [
    {
      name: 'electron',
    },
  ],

  /* Start Vite dev server before tests, kill it after */
  webServer: {
    command: `bun run dev --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: true,
    timeout: 30_000,
  },

  /* Global setup and teardown */
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
})
