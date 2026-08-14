import { access, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { git } from '../../../../packages/server/test/helpers/git-helpers.js'
import {
  type DaemonFixture,
  expect,
  test,
} from '../fixtures/browser-fixtures.js'

interface RepoFixture {
  readonly branchName: string
  readonly name: string
  readonly path: string
}

const DESTROY_WORKSPACE_RE = /^Destroy workspace/
const FORCE_DESTROY_RE = /^Force Destroy/

const createRepo = async (
  daemon: DaemonFixture,
  label: string
): Promise<RepoFixture> => {
  const name = `e2e-${label}-${crypto.randomUUID()}`
  const repoPath = join(daemon.stateDir, name)
  await mkdir(repoPath, { recursive: true })
  const path = await realpath(repoPath)
  git('init', path)
  git('config user.email test@example.com', path)
  git('config user.name "E2E User"', path)
  await writeFile(join(path, 'README.md'), `# ${name}\n`)
  git('add README.md', path)
  git('commit -m initial', path)

  return {
    branchName: git('branch --show-current', path),
    name,
    path,
  }
}

const seedProject = (daemon: DaemonFixture, repoPath: string) =>
  daemon.rpc.run((client) => client['project.add']({ repoPath }))

const removeProject = async (
  daemon: DaemonFixture,
  projectId: string
): Promise<void> => {
  try {
    await daemon.rpc.run((client) =>
      client['project.remove']({ projectId }).pipe(Effect.asVoid)
    )
  } catch {
    // A journey may already have removed the project through the UI.
  }
}

const destroyWorkspace = async (
  daemon: DaemonFixture,
  workspaceId: string
): Promise<void> => {
  try {
    await daemon.rpc.run((client) =>
      client['workspace.destroy']({ force: true, workspaceId }).pipe(
        Effect.asVoid
      )
    )
  } catch {
    // A journey may already have destroyed the workspace through the UI.
  }
}

test.describe('projects and worktrees journeys', () => {
  test('adds a project, shows its metadata, and removes it', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const repo = await createRepo(daemon, 'add-project')
    try {
      await page.getByTestId('add-project').click()
      const picker = page.getByTestId('directory-picker')
      await expect(picker).toBeVisible()
      await picker
        .getByTestId('directory-option')
        .filter({ hasText: repo.name })
        .click()
      await expect(picker.getByTestId('directory-picker-path')).toContainText(
        repo.name
      )
      await picker.getByTestId('directory-picker-select').click()

      const project = page
        .getByTestId('project-group')
        .filter({ has: page.getByText(repo.path, { exact: true }) })
      await expect(project).toBeVisible({ timeout: 30_000 })
      await expect(project.getByTestId('project-repo-path')).toHaveText(
        repo.path
      )
      const rootWorkspace = project.getByTestId(
        `workspace-card-${repo.branchName}`
      )
      await expect(rootWorkspace).toBeVisible()
      await expect(
        rootWorkspace.getByRole('button', { name: DESTROY_WORKSPACE_RE })
      ).toHaveCount(0)

      await project
        .getByRole('button', { name: `Remove project ${repo.name}` })
        .click()
      const dialog = page.getByTestId('remove-project-dialog')
      await expect(dialog).toContainText(repo.name)
      await dialog.press('Enter')
      await expect(dialog).toBeVisible()
      await dialog.press('Escape')
      await expect(dialog).toBeHidden()

      await project
        .getByRole('button', { name: `Remove project ${repo.name}` })
        .click()
      await page.getByTestId('remove-project-dialog').press('Meta+Enter')
      await expect(project).toBeHidden()
      await expect(page.getByTestId('toast-region')).toContainText(
        `Project "${repo.name}" removed`
      )
    } finally {
      await rm(repo.path, { force: true, recursive: true })
    }
  })

  test('creates a real branch worktree and opens its workspace', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const repo = await createRepo(daemon, 'create-workspace')
    const project = await seedProject(daemon, repo.path)
    const branchName = `journey-${crypto.randomUUID()}`
    let workspaceId: string | null = null

    try {
      const group = page
        .getByTestId('project-group')
        .filter({ has: page.getByText(repo.path, { exact: true }) })
      await expect(group).toBeVisible({ timeout: 30_000 })
      await group
        .getByRole('button', { name: `Create workspace in ${repo.name}` })
        .click()
      const input = group.getByTestId('create-workspace-input')
      await input.fill(branchName)
      await input.press('Enter')

      const card = group.getByTestId(`workspace-card-${branchName}`)
      await expect(card).toBeVisible({ timeout: 30_000 })
      workspaceId = await card.getAttribute('data-workspace-id')
      expect(workspaceId).not.toBeNull()
      await expect(
        page.locator(
          `[data-testid="workspace-frame"][data-workspace-id="${workspaceId}"]`
        )
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        card.getByRole('button', { name: `Destroy workspace ${branchName}` })
      ).toBeVisible()
    } finally {
      if (workspaceId) {
        await destroyWorkspace(daemon, workspaceId)
      }
      await removeProject(daemon, project.id)
      await rm(repo.path, { force: true, recursive: true })
    }
  })

  test('warns about a dirty worktree before force destroying it', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const repo = await createRepo(daemon, 'dirty-worktree')
    const project = await seedProject(daemon, repo.path)
    const branchName = `dirty-${crypto.randomUUID()}`
    const workspace = await daemon.rpc.run((client) =>
      client['workspace.create']({ branchName, projectId: project.id })
    )

    try {
      await expect
        .poll(async () => {
          try {
            await access(workspace.worktreePath)
            return true
          } catch {
            return false
          }
        })
        .toBe(true)
      await writeFile(join(workspace.worktreePath, 'dirty-file.txt'), 'dirty\n')
      const card = page.getByTestId(`workspace-card-${branchName}`).first()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card
        .getByRole('button', { name: `Destroy workspace ${branchName}` })
        .click()

      const dialog = page.getByTestId('destroy-workspace-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Unsaved work')).toBeVisible({
        timeout: 30_000,
      })
      await expect(dialog).toContainText('dirty-file.txt')
      await dialog.getByRole('button', { name: FORCE_DESTROY_RE }).click()

      await expect(card).toBeHidden({ timeout: 30_000 })
      await expect(page.getByTestId('toast-region')).toContainText(
        `Workspace "${branchName}" destroyed successfully`
      )
    } finally {
      await destroyWorkspace(daemon, workspace.id)
      await removeProject(daemon, project.id)
      await rm(repo.path, { force: true, recursive: true })
    }
  })

  test('shows an error when the selected folder is not a git repository', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const name = `e2e-not-a-repo-${crypto.randomUUID()}`
    const path = join(daemon.stateDir, name)
    await mkdir(path)

    try {
      await page.getByTestId('add-project').click()
      const picker = page.getByTestId('directory-picker')
      await picker
        .getByTestId('directory-option')
        .filter({ hasText: name })
        .click()
      await picker.getByTestId('directory-picker-select').click()

      await expect(page.getByTestId('toast-region')).toContainText(
        'not a git repository'
      )
      await expect(
        page
          .getByTestId('project-group')
          .filter({ has: page.getByText(path, { exact: true }) })
      ).toHaveCount(0)
    } finally {
      await rm(path, { force: true, recursive: true })
    }
  })
})
