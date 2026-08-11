/**
 * WorkspaceHelper — Shared helpers for adding projects and creating workspaces.
 *
 * Encapsulates the Electron-compatible flow:
 * 1. Navigate with `?reset` to clear local renderer state
 * 2. Mock `dialog.showOpenDialog` via `electronApp.evaluate`
 * 3. Click "Add Project" (Electron renders a button, not a text input)
 * 4. Optionally create a workspace via the per-project "+" button dialog
 *
 * All E2E tests that need a project or workspace should use these helpers
 * instead of duplicating the setup flow inline.
 *
 * @see apps/web/src/components/add-project-form.tsx — Electron vs browser branch
 */

import { execSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from './test-fixtures.js'

const CREATE_WORKSPACE_RE = /Create Workspace/

/**
 * Read the temp repo path from the global setup state file.
 *
 * Uses `realpathSync` to resolve symlinks (e.g. `/tmp` -> `/private/tmp`
 * on macOS) so the path matches what the backend reports.
 */
export function getTempRepoDir(): string {
  const stateFile = join(tmpdir(), 'laborer-e2e-state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
    readonly tempRepoDir: string
  }
  return realpathSync(state.tempRepoDir)
}

/**
 * Remove all git worktrees and reset repo config from previous test runs.
 *
 * The server auto-detects worktrees on disk, so stale worktrees cause
 * phantom workspaces. The project-management test writes a `laborer.json`
 * with a custom worktreeDir, which persists across tests since they share
 * the same temp repo.
 *
 * This cleanup:
 * 1. Removes all non-main git worktrees
 * 2. Removes the `laborer.json` so config doesn't leak between tests
 * 3. Removes the custom worktree directory if it exists
 */
export function cleanupRepo(): void {
  const tempRepoDir = getTempRepoDir()
  try {
    // 1. Read laborer.json to find custom worktreeDir before removing it
    const laborerJsonPath = join(tempRepoDir, 'laborer.json')
    let customWorktreeDir: string | undefined
    try {
      if (existsSync(laborerJsonPath)) {
        const config = JSON.parse(readFileSync(laborerJsonPath, 'utf-8')) as {
          readonly worktreeDir?: string
        }
        customWorktreeDir = config.worktreeDir
        unlinkSync(laborerJsonPath)
      }
    } catch {
      // Ignore JSON parse or unlink failures
    }

    // 2. Remove stale git lock files left by killed processes
    const lockFile = join(tempRepoDir, '.git', 'index.lock')
    if (existsSync(lockFile)) {
      try {
        unlinkSync(lockFile)
      } catch {
        // Ignore
      }
    }

    // 3. Remove all non-main git worktrees
    const output = execSync('git worktree list --porcelain', {
      cwd: tempRepoDir,
      encoding: 'utf-8',
    })

    const worktreePaths: string[] = []
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePaths.push(line.slice('worktree '.length))
      }
    }

    // The first worktree is the main repo — skip it
    for (const worktreePath of worktreePaths.slice(1)) {
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: tempRepoDir,
          stdio: 'pipe',
        })
      } catch {
        // Worktree may already be gone — ignore
      }
    }

    execSync('git worktree prune', { cwd: tempRepoDir, stdio: 'pipe' })

    // 4. Remove the custom worktree directory tree if it exists
    if (customWorktreeDir) {
      try {
        rmSync(customWorktreeDir, { recursive: true, force: true })
      } catch {
        // Directory may not exist
      }
    }
  } catch {
    // If the repo doesn't exist or git fails, skip cleanup
  }
}

/**
 * Navigate to the app with `?reset` to clear local renderer state,
 * then wait for the app to be ready.
 *
 * Also cleans up git worktrees from previous test runs so the server
 * doesn't auto-detect stale workspaces.
 *
 * Uses the VITE_PORT env var to build the dev server URL. Falls back to
 * extracting the origin from the current page URL if already loaded.
 */
export async function resetAndWaitForApp(page: Page): Promise<void> {
  // Clean up worktrees and config before navigating — the server scans
  // the repo on startup and will detect any leftover worktrees from prior
  // tests. Also removes laborer.json to prevent config leaking between tests.
  cleanupRepo()

  const vitePort = Number(process.env.VITE_PORT ?? 2101)
  await page.goto(`http://localhost:${vitePort}/?reset`)

  // Wait for the app to be ready — the "Server" text appears in the sidebar
  await expect(page.getByText('Server', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

/**
 * Mock the native folder picker to return the given path.
 *
 * In Electron, `AddProjectForm` calls `bridge.pickFolder()` which
 * invokes `dialog.showOpenDialog`. This mock replaces that dialog
 * so it returns the specified repo path without user interaction.
 */
export async function mockFolderPicker(
  electronApp: ElectronApplication,
  repoPath: string
): Promise<void> {
  await electronApp.evaluate(({ dialog }, folderPath: string) => {
    const mockResult = { canceled: false, filePaths: [folderPath] }
    dialog.showOpenDialog = (() =>
      Promise.resolve(mockResult)) as typeof dialog.showOpenDialog
  }, repoPath)
}

/**
 * Add a project via the Electron "Add Project" button.
 *
 * Assumes `mockFolderPicker` has already been called to mock
 * `dialog.showOpenDialog` with the desired repo path.
 *
 * Returns the project name (basename of the repo path).
 */
export async function addProject(
  electronApp: ElectronApplication,
  page: Page
): Promise<string> {
  const tempRepoDir = getTempRepoDir()
  const expectedProjectName = basename(tempRepoDir)

  // Mock the native folder picker
  await mockFolderPicker(electronApp, tempRepoDir)

  // Click "Add Project" — the mocked dialog returns our temp repo path
  await page.getByRole('button', { name: 'Add Project' }).click()

  // Wait for the project to appear in the sidebar
  await expect(
    page.getByText(expectedProjectName, { exact: true }).first()
  ).toBeVisible({ timeout: 15_000 })

  return expectedProjectName
}

interface WorkspaceResult {
  readonly branchName: string
  readonly projectName: string
  readonly repoPath: string
}

/**
 * Full workspace setup: reset app, add project, create workspace.
 *
 * This is the Electron-compatible equivalent of the old browser-mode
 * `addProjectAndCreateWorkspace` that used a text input for the repo path.
 *
 * @param branchName - The branch name for the workspace. If not provided,
 *   a unique `e2e-{timestamp}` name is generated and filled in automatically.
 *   We always fill in a branch name so the returned `branchName` is reliable.
 */
export async function addProjectAndCreateWorkspace(
  electronApp: ElectronApplication,
  page: Page,
  branchName?: string
): Promise<WorkspaceResult> {
  const tempRepoDir = getTempRepoDir()
  const resolvedBranch = branchName ?? `e2e-${Date.now()}`

  // Reset and wait for app readiness
  await resetAndWaitForApp(page)

  // Add the project
  const projectName = await addProject(electronApp, page)

  // Create workspace via the per-project "+" button
  await page
    .getByRole('button', {
      name: `Create workspace in ${projectName}`,
    })
    .click()

  const dialogTitle = page.getByRole('heading', {
    name: 'Create Workspace',
  })
  await expect(dialogTitle).toBeVisible({ timeout: 10_000 })

  // Always fill in the branch name so we can reliably reference it in tests
  await page
    .getByRole('textbox', { name: 'Branch Name or Slack URL (optional)' })
    .fill(resolvedBranch)

  await page.getByRole('button', { name: CREATE_WORKSPACE_RE }).click()

  // Wait for the success toast which confirms the RPC completed and the
  // dialog is about to close. This is more reliable than waiting for the
  // dialog to close because the toast fires after the RPC resolves.
  await expect(page.getByText('is being set up', { exact: false })).toBeVisible(
    { timeout: 30_000 }
  )

  // Wait for the dialog to close
  await expect(dialogTitle).not.toBeVisible({ timeout: 10_000 })

  // Wait for the workspace card to appear in the sidebar.
  // the server state stream may lag behind the RPC response, so give it time.
  await expect(
    page.getByText(resolvedBranch, { exact: true }).first()
  ).toBeVisible({ timeout: 15_000 })

  return {
    projectName,
    branchName: resolvedBranch,
    repoPath: tempRepoDir,
  }
}
