/**
 * E2E Test Fixtures
 *
 * Exports Playwright test instance extended with page object helpers.
 * All E2E tests should import `test` and `expect` from this module
 * instead of directly from @playwright/test.
 *
 * Uses Playwright's Electron support (`_electron.launch()`) following
 * VS Code's smoke test pattern. The Electron app is launched once per
 * test and torn down after, providing a real Electron environment with
 * utility processes (server, terminal, and file-watcher) all running.
 *
 * @see .reference/vscode/test/automation/src/playwrightElectron.ts
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron,
  test as base,
  type ElectronApplication,
  expect as playwrightExpect,
} from '@playwright/test'
import { PanelHelper } from './panel-helper.js'
import { SidebarHelper } from './sidebar-helper.js'
import { TerminalHelper } from './terminal-helper.js'
import { cleanupRepo } from './workspace-helper.js'

export const expect = playwrightExpect

/**
 * Electron has no true headless mode, so by default the app runs with
 * hidden windows (LABORER_HIDE_WINDOWS=1) and no dock icon. Playwright
 * drives the page over CDP, which works without a visible window.
 * Set E2E_HEADED=1 to show the real window while debugging tests.
 */
const runHeaded = process.env.E2E_HEADED === '1'

/** Resolve the Electron binary path. */
function resolveElectronPath(): string {
  const desktopDir = resolve(import.meta.dirname, '../../../../apps/desktop')
  const electronPath = join(desktopDir, 'node_modules', '.bin', 'electron')
  return electronPath
}

/** Extended test fixtures with page object helpers. */
interface E2EFixtures {
  electronApp: ElectronApplication
  panels: PanelHelper
  sidebar: SidebarHelper
  terminal: TerminalHelper
}

/**
 * Extended Playwright test with Electron app and page object helpers.
 *
 * Each test gets a fresh Electron app launched via `_electron.launch()`.
 * The app's first window is used as the test page.
 *
 * Usage:
 * ```ts
 * import { test, expect } from "./fixtures/test-fixtures.js";
 *
 * test("my test", async ({ page, sidebar, panels }) => {
 *   await sidebar.search("my-project");
 *   await panels.splitHorizontal();
 * });
 * ```
 */
export const test = base.extend<E2EFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring for fixture dependencies
  electronApp: async ({}, use) => {
    const desktopDir = resolve(import.meta.dirname, '../../../../apps/desktop')
    const vitePort = Number(process.env.VITE_PORT ?? 2101)
    const devServerUrl = `http://localhost:${vitePort}`

    // Resolve the data dir — use a temp dir for test isolation
    const dataDirBase = join(tmpdir(), `laborer-e2e-data-${Date.now()}`)

    // Strip host-process markers from the inherited environment. They leak
    // in when tests are launched from an Electron-hosted terminal (editors,
    // agents, Laborer itself):
    // - ELECTRON_RUN_AS_NODE makes the Electron binary boot as plain Node,
    //   which rejects Chromium flags with "bad option" and kills the launch.
    // - LABORER_BACKEND_CHILD trips main.ts's guard against launching the
    //   desktop app from a backend child process environment.
    const {
      ELECTRON_RUN_AS_NODE: _electronRunAsNode,
      LABORER_BACKEND_CHILD: _laborerBackendChild,
      ...inheritedEnv
    } = process.env

    const electronApp = await _electron.launch({
      executablePath: resolveElectronPath(),
      args: [
        `--laborer-dev-root=${desktopDir}`,
        join(desktopDir, 'dist-electron', 'main.cjs'),
      ],
      env: {
        ...inheritedEnv,
        VITE_DEV_SERVER_URL: devServerUrl,
        DATA_DIR: dataDirBase,
        // Isolate the Electron user data profile (localStorage, window
        // state, caches) so tests never read or pollute the developer's
        // real profile, and each test starts with a clean layout.
        LABORER_USER_DATA_DIR: join(dataDirBase, 'user-data'),
        // Disable GPU acceleration for consistent test rendering
        ELECTRON_DISABLE_GPU: '1',
        // Keep windows hidden unless explicitly running headed
        ...(runHeaded ? {} : { LABORER_HIDE_WINDOWS: '1' }),
      },
      timeout: 30_000,
    })

    await use(electronApp)

    // Close the Electron app with a timeout fallback.
    // The app has utility processes (server, terminal, file-watcher) that
    // may not shut down cleanly, causing `electronApp.close()` to hang.
    const closeTimeout = 5000
    try {
      await Promise.race([
        electronApp.close(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('Electron close timed out')),
            closeTimeout
          )
        ),
      ])
    } catch {
      // Force kill the entire process tree if close timed out.
      // Electron spawns utility processes (server, terminal, file-watcher)
      // that need to be killed along with the main process.
      try {
        const pid = electronApp.process().pid
        if (pid) {
          // Kill all child processes first, then the main process
          try {
            execSync(`pkill -9 -P ${pid}`, { stdio: 'pipe' })
          } catch {
            // pkill may fail if no children exist
          }
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Process may already be gone
          }
        }
      } catch {
        // Process may already be gone
      }
    }

    // Clean up git worktrees and laborer.json after the app is dead.
    // This prevents stale worktrees from poisoning the next test's
    // server, which auto-detects worktrees on startup.
    cleanupRepo()
  },

  page: async ({ electronApp }, use) => {
    // Wait for the first window to appear
    let page = electronApp.windows()[0]
    if (!page) {
      page = await electronApp.waitForEvent('window', { timeout: 30_000 })
    }

    // Wait for the page to be fully loaded
    await page.waitForLoadState('domcontentloaded')

    // When the window is hidden, Chromium reports document.hasFocus() as
    // false, which breaks focus-dependent code (xterm.js keyboard capture).
    // Enable CDP focus emulation so the page behaves as if focused — the
    // same mechanism headless Chromium uses.
    if (!runHeaded) {
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
    }

    // Auto-dismiss any unexpected JavaScript dialogs (alert/confirm/prompt).
    // The Electron app doesn't use native browser dialogs, but rare race
    // conditions in Playwright's CDP layer can cause
    // "Protocol error (Page.handleJavaScriptDialog): No dialog is showing".
    // This handler prevents that error from crashing the test.
    page.on('dialog', async (dialog) => {
      // Silently dismiss — the app doesn't use native browser dialogs
      await dialog.dismiss().catch(() => undefined)
    })

    await use(page)
  },

  sidebar: async ({ page }, use) => {
    await use(new SidebarHelper(page))
  },
  panels: async ({ page }, use) => {
    await use(new PanelHelper(page))
  },
  terminal: async ({ page }, use) => {
    await use(new TerminalHelper(page))
  },
})
