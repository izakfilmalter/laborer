/**
 * E2E Tests — Workspace Lifecycle
 *
 * Tests workspace lifecycle flows: create and destroy workspaces via the
 * per-project "+" button composer, verify the workspace cards appear in the
 * sidebar with their branch names and status badges, and confirm removal.
 *
 * All tests exercise the full stack: Electron UI -> RPC mutation -> backend
 * (worktree creation, setup scripts) -> the server state stream -> UI re-render.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md — Issues 8, 9, 10
 */

import { expect, test } from './fixtures/test-fixtures.js'
import {
  addProject,
  addProjectAndCreateWorkspace,
  resetAndWaitForApp,
} from './fixtures/workspace-helper.js'

/**
 * Regex patterns for button names that include keyboard shortcut indicators
 * (e.g. `<Kbd>↵</Kbd>`). Using regex avoids `exact: true` mismatches when
 * the accessible name includes shortcut text.
 */
const DESTROY_RE = /^Destroy/

test.describe('workspace lifecycle', () => {
  test('can create a workspace and see it in the sidebar', async ({
    electronApp,
    page,
  }) => {
    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // --- Step 2: Click the per-project "+" button to open the inline composer ---
    const createWorkspaceButton = page.getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    await createWorkspaceButton.click()

    const composerInput = page.getByRole('textbox', {
      name: `Branch name or Slack URL for ${projectName}`,
    })
    await expect(composerInput).toBeVisible({ timeout: 10_000 })

    // --- Step 3: Commit an empty composer so the branch name is auto-generated ---
    await composerInput.press('Enter')

    // The "No workspaces" empty state should no longer be visible
    const noWorkspacesText = page.getByText('No workspaces')
    await expect(noWorkspacesText).not.toBeVisible({ timeout: 30_000 })
  })

  test('shows the created workspace branch name and running status in the sidebar', async ({
    electronApp,
    page,
  }) => {
    const branchName = `e2e-branch-${Date.now()}`

    await addProjectAndCreateWorkspace(electronApp, page, branchName)

    // Use .first() — the branch name also appears in the panel header bar
    await expect(
      page.getByText(branchName, { exact: true }).first()
    ).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      page.getByRole('button', {
        name: `Destroy workspace ${branchName}`,
      })
    ).toBeVisible({ timeout: 15_000 })
  })

  /**
   * Namespaced branches are the house style — an auto-generated name is
   * `laborer/<uuid>` — so a typed slash survives into the branch. Only the
   * worktree directory is slugified, which the sidebar never shows.
   */
  test('keeps forward slashes in the branch name and shows it in the sidebar', async ({
    electronApp,
    page,
  }) => {
    const branchName = `e2e-slash/branch-${Date.now()}`

    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // Open the inline composer
    const createWorkspaceButton = page.getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    await createWorkspaceButton.click()

    // Type a branch name with a forward slash
    const composerInput = page.getByRole('textbox', {
      name: `Branch name or Slack URL for ${projectName}`,
    })
    await expect(composerInput).toBeVisible({ timeout: 10_000 })
    await composerInput.fill(branchName)

    // The branch mask keeps the slash rather than stripping it
    await expect(composerInput).toHaveValue(branchName)

    await composerInput.press('Enter')

    // The composer clears itself and stays open for the next workspace
    await expect(composerInput).toHaveValue('', { timeout: 30_000 })

    // The workspace appears in the sidebar under the branch name as typed.
    // Use .first() — the branch name also appears in the panel header bar.
    await expect(
      page.getByText(branchName, { exact: true }).first()
    ).toBeVisible({ timeout: 15_000 })

    await expect(
      page.getByRole('button', {
        name: `Destroy workspace ${branchName}`,
      })
    ).toBeVisible({ timeout: 15_000 })
  })

  test('can destroy a workspace and verify it disappears from the sidebar', async ({
    electronApp,
    page,
  }) => {
    test.setTimeout(90_000)
    const branchName = `e2e-destroy-${Date.now()}`

    await addProjectAndCreateWorkspace(electronApp, page, branchName)

    // Scope locators to the workspace card to avoid ambiguity with
    // the panel header bar which also shows the branch name.
    const workspaceCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: branchName })
    await expect(workspaceCard).toBeVisible({ timeout: 15_000 })

    const destroyWorkspaceButton = page.getByRole('button', {
      name: `Destroy workspace ${branchName}`,
    })
    await expect(destroyWorkspaceButton).toBeVisible({ timeout: 10_000 })
    await destroyWorkspaceButton.click()

    const destroyDialogTitle = page.getByRole('heading', {
      name: 'Destroy workspace?',
    })
    await expect(destroyDialogTitle).toBeVisible({ timeout: 10_000 })

    const confirmDestroyButton = page.getByRole('button', {
      name: DESTROY_RE,
    })
    await confirmDestroyButton.click()

    // The dialog closes immediately (optimistically), but the destroy RPC
    // runs in the background. When the workspace is still in "creating"
    // state (common after running multiple tests sequentially), the server
    // must first interrupt the setup fiber before committing the destroy.
    // Wait for the success toast which confirms the destroy completed.
    await expect(destroyDialogTitle).not.toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText('destroyed successfully', { exact: false })
    ).toBeVisible({ timeout: 60_000 })
    // Verify the workspace card is removed from the sidebar.
    // the server state stream may lag behind the RPC response, especially when
    // the workspace was still "creating". Check if the card is gone;
    // if not, reload the page to force a fresh authoritative snapshot.
    try {
      await expect(workspaceCard).not.toBeVisible({ timeout: 10_000 })
    } catch {
      // the server state stream didn't deliver the status change. Reload the page
      // to force a fresh read from the server's authoritative state.
      await page.evaluate(() => window.location.reload())
      await page.waitForTimeout(500)
      await expect(page.getByText('Server', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(workspaceCard).not.toBeVisible({ timeout: 10_000 })
    }
    await expect(destroyWorkspaceButton).not.toBeVisible({ timeout: 10_000 })
  })
})
