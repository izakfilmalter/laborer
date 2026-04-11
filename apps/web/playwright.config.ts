import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const serverRoot = fileURLToPath(new URL('../server', import.meta.url))
const serverPort = '27731'
const webPort = '20011'
const serverStateRoot = path.join(webRoot, '.playwright', 'server-state')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  globalSetup: './playwright.global-setup.ts',
  reporter: 'list',
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'bun run dev',
      cwd: serverRoot,
      env: {
        LABORER_PROJECT_STORE_DIRECTORY: path.join(
          serverStateRoot,
          'livestore'
        ),
        LABORER_SERVER_HOST: '127.0.0.1',
        LABORER_SERVER_PORT: serverPort,
        LABORER_TERMINAL_HISTORY_DIRECTORY: path.join(
          serverStateRoot,
          'terminal-history'
        ),
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://127.0.0.1:${serverPort}/health`,
    },
    {
      command: `bun run dev -- --host 127.0.0.1 --port ${webPort}`,
      cwd: webRoot,
      env: {
        VITE_WS_URL: `ws://127.0.0.1:${serverPort}/ws`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://127.0.0.1:${webPort}`,
    },
  ],
})
