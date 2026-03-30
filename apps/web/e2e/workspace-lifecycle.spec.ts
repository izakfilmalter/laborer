/**
 * E2E Tests — Workspace Lifecycle
 *
 * Tests workspace lifecycle flows: create and destroy workspaces via the
 * per-project "+" button dialog, verify the workspace cards appear in the
 * sidebar with their branch names and status badges, and confirm removal.
 *
 * All tests exercise the full stack: Electron UI -> RPC mutation -> backend
 * (worktree creation, setup scripts) -> LiveStore sync -> UI re-render.
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
 * the accessible name includes shortcut text like "Create Workspace ↵".
 */
const CREATE_WORKSPACE_RE = /Create Workspace/
const DESTROY_RE = /^Destroy/

test.describe('workspace lifecycle', () => {
  test('can create a workspace and see it in the sidebar', async ({
    electronApp,
    page,
  }) => {
    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // --- Step 2: Click the per-project "+" button to open the Create Workspace dialog ---
    const createWorkspaceButton = page.getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    await createWorkspaceButton.click()

    // Wait for the Create Workspace dialog to appear
    const dialogTitle = page.getByRole('heading', {
      name: 'Create Workspace',
    })
    await expect(dialogTitle).toBeVisible({ timeout: 10_000 })

    // --- Step 3: Submit the form (leave branch name empty to auto-generate) ---
    const submitButton = page.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await submitButton.click()

    // Wait for the dialog to close (workspace creation started)
    await expect(dialogTitle).not.toBeVisible({ timeout: 30_000 })

    // The "No workspaces" empty state should no longer be visible
    const noWorkspacesText = page.getByText('No workspaces')
    await expect(noWorkspacesText).not.toBeVisible()
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

  test('converts forward slashes to hyphens in branch name on create and shows correctly in sidebar', async ({
    electronApp,
    page,
  }) => {
    const timestamp = Date.now()
    const inputBranchName = `e2e-slash/branch-${timestamp}`
    const expectedBranchName = `e2e-slash-branch-${timestamp}`

    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // Open the Create Workspace dialog
    const createWorkspaceButton = page.getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    await createWorkspaceButton.click()

    const dialogTitle = page.getByRole('heading', {
      name: 'Create Workspace',
    })
    await expect(dialogTitle).toBeVisible({ timeout: 10_000 })

    // Type a branch name with a forward slash
    const branchNameInput = page.getByRole('textbox', {
      name: 'Branch Name (optional)',
    })
    await branchNameInput.fill(inputBranchName)

    // Verify the input displays the slash as typed
    await expect(branchNameInput).toHaveValue(inputBranchName)

    // Submit — the form should transform / to -
    const submitButton = page.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await submitButton.click()

    // Wait for the success toast — it should contain the transformed branch name
    const successToast = page.getByText('is being set up', {
      exact: false,
    })
    await expect(successToast).toBeVisible({ timeout: 30_000 })
    await expect(successToast).toContainText(expectedBranchName)

    // Dialog should close on success
    await expect(dialogTitle).not.toBeVisible()

    // The workspace should appear in the sidebar with the transformed branch name.
    // Use .first() — the branch name also appears in the panel header bar.
    await expect(
      page.getByText(expectedBranchName, { exact: true }).first()
    ).toBeVisible({
      timeout: 15_000,
    })

    // The destroy button should reference the transformed branch name
    await expect(
      page.getByRole('button', {
        name: `Destroy workspace ${expectedBranchName}`,
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
    // LiveStore sync may lag behind the RPC response, especially when
    // the workspace was still "creating". Check if the card is gone;
    // if not, reload the page to force a fresh LiveStore read.
    try {
      await expect(workspaceCard).not.toBeVisible({ timeout: 10_000 })
    } catch {
      // LiveStore sync didn't deliver the status change. Reload the page
      // to force a fresh read from the server's LiveStore state.
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
