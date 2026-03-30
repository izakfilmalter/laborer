/**
 * Tracer Bullet E2E Test
 *
 * Proves the full Playwright Electron infrastructure works end-to-end:
 * - Global setup created the temp repo and verified builds exist
 * - Electron app launches and loads the Vite dev server page
 * - The app renders its basic UI structure
 *
 * This is the foundational test — if this passes, the Playwright
 * infrastructure is working and other E2E tests can be built on top.
 *
 * @see PRD-e2e-test-coverage.md — Issue 3
 */

import { expect, test } from './fixtures/test-fixtures.js'
import { resetAndWaitForApp } from './fixtures/workspace-helper.js'

test.describe('tracer bullet', () => {
  test('app loads and renders basic page structure', async ({ page }) => {
    // Reset OPFS state and wait for the app to be ready
    await resetAndWaitForApp(page)

    // Verify the sidebar structure is present
    // When no projects exist, we should see the "Add Project" button
    const addProjectButton = page.getByRole('button', { name: 'Add Project' })
    await expect(addProjectButton).toBeVisible()

    // Verify the server status section is present in the sidebar
    await expect(page.getByText('Server', { exact: true })).toBeVisible()
  })

  test('page title is set to laborer', async ({ page }) => {
    await expect(page).toHaveTitle('laborer')
  })
})
