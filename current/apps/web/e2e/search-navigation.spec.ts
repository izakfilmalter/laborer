/**
 * E2E Tests - Search Navigation
 *
 * Tests sidebar search filtering through the real UI and backend-backed
 * project/workspace state.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md - Issues 16, 17, and 18
 */

import { expect, test } from './fixtures/test-fixtures.js'
import { addProjectAndCreateWorkspace } from './fixtures/workspace-helper.js'

const DARK_CLASS_PATTERN = /dark/

test.describe('search navigation', () => {
  test('filters projects and workspaces in real time and restores them when cleared', async ({
    electronApp,
    page,
    sidebar,
  }) => {
    const { branchName, projectName } = await addProjectAndCreateWorkspace(
      electronApp,
      page
    )

    // Use the "Create workspace in <project>" button as a sidebar-scoped
    // locator — the project name also appears in the tab header bar, so
    // a plain getByText would match outside the sidebar.
    const createWorkspaceInProject = page.getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    await expect(createWorkspaceInProject).toBeVisible({ timeout: 10_000 })

    const destroyWorkspaceButton = page.getByRole('button', {
      name: `Destroy workspace ${branchName}`,
    })
    await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 })

    await sidebar.search(branchName)
    await expect(sidebar.searchInput).toHaveValue(branchName)
    await expect(createWorkspaceInProject).toBeVisible()
    await expect(destroyWorkspaceButton).toBeVisible()

    const noMatchesText = page.getByText('No matching projects or workspaces.')
    await sidebar.search('definitely-no-search-match')
    await expect(noMatchesText).toBeVisible()
    await expect(createWorkspaceInProject).not.toBeVisible()
    await expect(destroyWorkspaceButton).not.toBeVisible()

    await sidebar.clearSearch()
    await expect(sidebar.searchInput).toHaveValue('')
    await expect(noMatchesText).not.toBeVisible()
    await expect(createWorkspaceInProject).toBeVisible()
    await expect(destroyWorkspaceButton).toBeVisible()
  })

  test('can collapse a project group, keep it collapsed across reload, and expand it again', async ({
    electronApp,
    page,
  }) => {
    const { branchName, projectName } = await addProjectAndCreateWorkspace(
      electronApp,
      page
    )

    const projectToggle = page.getByText(projectName, { exact: true }).first()
    const destroyWorkspaceButton = page.getByRole('button', {
      name: `Destroy workspace ${branchName}`,
    })

    // The project group should be expanded by default — the workspace is visible
    await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 })

    // Click the project name to collapse the group
    await projectToggle.click()

    await expect(destroyWorkspaceButton).not.toBeVisible()

    // Reload the page and verify the collapsed state persists.
    // Use page.evaluate to trigger a client-side reload because
    // page.reload() and page.goto() can timeout in Electron when
    // utility processes delay the load event or the Vite dev server
    // port doesn't match what Electron loaded.
    await page.evaluate(() => window.location.reload())
    // Wait a moment for the navigation to start
    await page.waitForTimeout(500)
    await expect(page.getByText('Server', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      page.getByText(projectName, { exact: true }).first()
    ).toBeVisible({ timeout: 10_000 })
    await expect(destroyWorkspaceButton).not.toBeVisible()

    // Click the project name to expand the group again
    await page.getByText(projectName, { exact: true }).first().click()

    await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 })
  })

  test('can toggle the theme and restore the original mode', async ({
    page,
  }) => {
    // The Electron app is already loaded — just wait for app readiness
    await expect(page.getByText('Server', { exact: true })).toBeVisible({
      timeout: 30_000,
    })

    const html = page.locator('html')
    const themeToggle = page.getByRole('button', { name: 'Toggle theme' })
    const isDarkModeInitially = (await html.getAttribute('class'))?.includes(
      'dark'
    )

    const nextTheme = isDarkModeInitially ? 'Light' : 'Dark'
    const originalTheme = isDarkModeInitially ? 'Dark' : 'Light'

    await themeToggle.click()
    await page.getByRole('menuitem', { name: nextTheme, exact: true }).click()

    if (isDarkModeInitially) {
      await expect(html).not.toHaveClass(DARK_CLASS_PATTERN)
    } else {
      await expect(html).toHaveClass(DARK_CLASS_PATTERN)
    }

    await themeToggle.click()
    await page
      .getByRole('menuitem', { name: originalTheme, exact: true })
      .click()

    if (isDarkModeInitially) {
      await expect(html).toHaveClass(DARK_CLASS_PATTERN)
    } else {
      await expect(html).not.toHaveClass(DARK_CLASS_PATTERN)
    }
  })
})
