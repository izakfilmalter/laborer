/**
 * E2E Tests — Project Management
 *
 * Tests project lifecycle flows: add project, open/save settings, delete.
 * All tests exercise the full stack: Electron UI -> RPC mutation -> backend
 * -> the server state stream -> UI re-render.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md — Issues 4, 5, 6
 */

import { basename } from 'node:path'
import { expect, test } from './fixtures/test-fixtures.js'
import {
  addProject,
  getTempRepoDir,
  resetAndWaitForApp,
} from './fixtures/workspace-helper.js'

test.describe('project management', () => {
  test('can add a project and see it in the sidebar', async ({
    electronApp,
    page,
  }) => {
    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // Verify the project name appears in the sidebar as a collapsible group
    const projectInSidebar = page
      .getByText(projectName, {
        exact: true,
      })
      .first()
    await expect(projectInSidebar).toBeVisible()
  })

  test('can open project settings, modify a field, save, and verify persistence', async ({
    electronApp,
    page,
  }) => {
    await resetAndWaitForApp(page)

    const projectName = await addProject(electronApp, page)

    // --- Step 2: Open the project settings modal ---
    const settingsButton = page.getByRole('button', {
      name: `Open settings for ${projectName}`,
    })
    await settingsButton.click()

    // Wait for the settings form to load (async config.get RPC)
    const modalTitle = page.getByText('Project settings')
    await expect(modalTitle).toBeVisible({ timeout: 10_000 })

    // Wait for the loading spinner to disappear and form fields to appear
    const worktreeDirInput = page.getByRole('textbox', {
      name: 'Worktree directory',
    })
    await expect(worktreeDirInput).toBeVisible({ timeout: 10_000 })

    // Read the initial value of the worktree directory field
    const initialWorktreeDir = await worktreeDirInput.inputValue()

    // --- Step 3: Modify the worktree directory field ---
    const newWorktreeDir = `/tmp/e2e-test-worktrees/${projectName}`
    await worktreeDirInput.clear()
    await worktreeDirInput.fill(newWorktreeDir)

    // Verify the input shows the new value before saving
    await expect(worktreeDirInput).toHaveValue(newWorktreeDir)

    // --- Step 4: Save the settings ---
    const saveButton = page.getByRole('button', { name: 'Save' })
    await saveButton.click()

    // Wait for the success toast
    const successToast = page.getByText(`Saved settings for ${projectName}`)
    await expect(successToast).toBeVisible({ timeout: 10_000 })

    // The dialog should close on successful save
    await expect(modalTitle).not.toBeVisible()

    // --- Step 5: Re-open settings and verify the saved value persists ---
    await settingsButton.click()

    // Wait for the form to load again
    const worktreeDirInputAgain = page.getByRole('textbox', {
      name: 'Worktree directory',
    })
    await expect(worktreeDirInputAgain).toBeVisible({ timeout: 10_000 })

    // Verify the worktree directory shows the updated value, not the initial one
    await expect(worktreeDirInputAgain).toHaveValue(newWorktreeDir)
    expect(newWorktreeDir).not.toBe(initialWorktreeDir)
  })

  test('can delete a project and verify it disappears from the sidebar', async ({
    electronApp,
    page,
  }) => {
    const tempRepoDir = getTempRepoDir()
    const expectedProjectName = basename(tempRepoDir)

    await resetAndWaitForApp(page)

    await addProject(electronApp, page)

    // Verify the project is in the sidebar
    const projectInSidebar = page
      .getByText(expectedProjectName, { exact: true })
      .first()
    await expect(projectInSidebar).toBeVisible({ timeout: 10_000 })

    // --- Step 2: Click the delete/remove button for the project ---
    const removeButton = page.getByRole('button', {
      name: `Remove project ${expectedProjectName}`,
    })
    await removeButton.click()

    // --- Step 3: Confirm the deletion in the alert dialog ---
    const dialogTitle = page.getByText('Remove project?')
    await expect(dialogTitle).toBeVisible()

    const confirmButton = page.getByRole('button', { name: 'Remove' })
    await confirmButton.click()

    // --- Step 4: Verify success toast ---
    const successToast = page.getByText(
      `Project "${expectedProjectName}" removed`
    )
    await expect(successToast).toBeVisible({ timeout: 10_000 })

    // --- Step 5: Verify the project is no longer in the sidebar ---
    await expect(projectInSidebar).not.toBeVisible()
  })
})
