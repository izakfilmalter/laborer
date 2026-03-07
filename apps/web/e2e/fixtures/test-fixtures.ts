/**
 * E2E Test Fixtures
 *
 * Exports Playwright test instance extended with page object helpers.
 * All E2E tests should import `test` and `expect` from this module
 * instead of directly from @playwright/test.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { test as base, expect as playwrightExpect } from '@playwright/test'
import { PanelHelper } from './panel-helper.js'
import { SidebarHelper } from './sidebar-helper.js'
import { TerminalHelper } from './terminal-helper.js'

export const expect = playwrightExpect

/** Extended test fixtures with page object helpers. */
interface E2EFixtures {
  panels: PanelHelper
  sidebar: SidebarHelper
  terminal: TerminalHelper
}

/**
 * Extended Playwright test with page object helpers injected as fixtures.
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
