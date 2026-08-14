import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import { E2E_STATE_FILE_ENV } from './e2e/global-setup.js'

const vitePort = Number(process.env.VITE_PORT ?? 2101)
const reuseDevStack = process.env.LABORER_E2E_REUSE_DEV_STACK === '1'
process.env[E2E_STATE_FILE_ENV] ??= join(
  tmpdir(),
  `laborer-e2e-state-${String(process.pid)}-${randomUUID()}.json`
)

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

  /* Shared settings. Electron supplies its own page; Chromium uses baseURL. */
  use: {
    baseURL: `http://127.0.0.1:${String(vitePort)}`,
    /* Capture screenshot on failure for debugging */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  /* Keep the legacy Electron suite and the browser gate in one config. */
  projects: [
    {
      name: 'electron',
      testIgnore: /browser\/.*\.spec\.ts/,
    },
    {
      name: 'browser',
      testMatch: /browser\/.*\.spec\.ts/,
      use: {
        browserName: 'chromium',
      },
    },
  ],

  /* Start Vite dev server before tests, kill it after */
  webServer: {
    command: 'bun e2e/start-vite.ts',
    port: vitePort,
    reuseExistingServer: reuseDevStack,
    timeout: 30_000,
  },

  /* Global setup and teardown */
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
})
