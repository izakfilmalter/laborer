import { access, rm, writeFile } from 'node:fs/promises'
import type { Locator, Page } from '@playwright/test'
import { Effect } from 'effect'
import {
  type DaemonFixture,
  expect,
  test,
} from '../fixtures/browser-fixtures.js'
import { initRepo } from '../fixtures/git-fixture.js'

interface DiffJourney {
  readonly branchName: string
  readonly projectId: string
  readonly tempRoots: readonly string[]
  readonly workspaceId: string
  readonly worktreePath: string
}

const seedDiffJourney = async (
  daemon: DaemonFixture,
  label: string
): Promise<DiffJourney> => {
  const tempRoots: string[] = []
  const repoPath = initRepo(`diff-${label}`, tempRoots)
  const branchName = `${label}-${crypto.randomUUID()}`
  let projectId: string | undefined
  let workspaceId: string | undefined

  try {
    const project = await daemon.rpc.run((client) =>
      client['project.add']({
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        repoPath,
      })
    )
    projectId = project.id
    const workspace = await daemon.rpc.run((client) =>
      client['workspace.create']({
        branchName,
        operationId: crypto.randomUUID(),
        projectId: project.id,
      })
    )
    workspaceId = workspace.id

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

    return {
      branchName,
      projectId: project.id,
      tempRoots,
      workspaceId: workspace.id,
      worktreePath: workspace.worktreePath,
    }
  } catch (error) {
    const failedWorkspaceId = workspaceId
    if (failedWorkspaceId !== undefined) {
      try {
        await daemon.rpc.run((client) =>
          client['workspace.destroy']({
            force: true,
            operationId: crypto.randomUUID(),
            workspaceId: failedWorkspaceId,
          }).pipe(Effect.asVoid)
        )
      } catch {
        // Preserve the setup failure; worker teardown removes daemon state.
      }
    }
    const failedProjectId = projectId
    if (failedProjectId !== undefined) {
      try {
        await daemon.rpc.run((client) =>
          client['project.remove']({
            operationId: crypto.randomUUID(),
            projectId: failedProjectId,
          }).pipe(Effect.asVoid)
        )
      } catch {
        // Preserve the setup failure; worker teardown removes daemon state.
      }
    }
    for (const root of tempRoots) {
      await rm(root, { force: true, recursive: true })
    }
    throw error
  }
}

const cleanDiffJourney = async (
  daemon: DaemonFixture,
  journey: DiffJourney
): Promise<void> => {
  try {
    await daemon.rpc.run((client) =>
      client['workspace.destroy']({
        force: true,
        operationId: crypto.randomUUID(),
        workspaceId: journey.workspaceId,
      }).pipe(Effect.asVoid)
    )
  } catch {
    // Cleanup remains safe if a journey removed its own workspace.
  }
  try {
    await daemon.rpc.run((client) =>
      client['project.remove']({
        operationId: crypto.randomUUID(),
        projectId: journey.projectId,
      }).pipe(Effect.asVoid)
    )
  } finally {
    for (const root of journey.tempRoots) {
      await rm(root, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      })
    }
  }
}

const openDiff = async (page: Page, journey: DiffJourney): Promise<Locator> => {
  const card = page.getByTestId(`workspace-card-${journey.branchName}`).first()
  await expect(card).toBeVisible({ timeout: 30_000 })

  const openFrame = page
    .getByTestId('workspace-frame')
    .filter({ visible: true })
  await expect(openFrame).toHaveCount(1)
  await openFrame.getByRole('button', { name: 'Close workspace' }).click()
  const emptyTab = page.getByTestId('empty-window-tab-state')
  await expect(emptyTab).toBeVisible()
  await emptyTab
    .locator(
      `[data-testid="workspace-picker-item"][data-workspace-id="${journey.workspaceId}"]`
    )
    .click()

  const frame = page.locator(
    `[data-testid="workspace-frame"][data-workspace-id="${journey.workspaceId}"]`
  )
  await expect(frame).toBeVisible({ timeout: 30_000 })
  await frame
    .getByTestId('panel-type-picker-option')
    .filter({ hasText: 'Diff' })
    .click()

  const diff = frame.locator('[data-pane-text-selectable]')
  await expect(diff).toBeVisible()
  return diff
}

const diffFile = (diff: Locator, path: string): Locator =>
  diff.locator(`[data-diff-file-path="${path}"]`)

test.describe('diff and git view journeys', () => {
  test('shows seeded diffs and git status decorations', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedDiffJourney(daemon, 'seeded')

    try {
      await writeFile(
        `${journey.worktreePath}/README.md`,
        '# seeded diff\nvisible changed line\n'
      )
      await writeFile(
        `${journey.worktreePath}/added.ts`,
        'export const seeded = true\n'
      )

      const diff = await openDiff(page, journey)
      await expect(diffFile(diff, 'README.md')).toContainText(
        'visible changed line'
      )
      await expect(diffFile(diff, 'added.ts')).toContainText(
        'export const seeded = true'
      )

      const frame = page.locator(
        `[data-testid="workspace-frame"][data-workspace-id="${journey.workspaceId}"]`
      )
      await frame.getByRole('button', { name: 'Open file tree' }).click()
      const tree = frame.getByTestId('tree-pane')
      await expect(tree).toBeVisible()
      await expect(
        tree
          .getByRole('treeitem', { name: 'README.md' })
          .getByText('M', { exact: true })
      ).toBeVisible()
      await expect(
        tree
          .getByRole('treeitem', { name: 'added.ts' })
          .getByText('A', { exact: true })
      ).toBeVisible()
    } finally {
      await cleanDiffJourney(daemon, journey)
    }
  })

  test('updates the diff after an external file change without a reload', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedDiffJourney(daemon, 'watcher')

    try {
      await writeFile(
        `${journey.worktreePath}/README.md`,
        '# watcher journey\ninitial external state\n'
      )
      const diff = await openDiff(page, journey)
      await expect(diffFile(diff, 'README.md')).toContainText(
        'initial external state'
      )

      await writeFile(
        `${journey.worktreePath}/watcher-added.ts`,
        'export const watcherUpdate = "arrived"\n'
      )

      const added = diffFile(diff, 'watcher-added.ts')
      await expect(added).toBeVisible({ timeout: 30_000 })
      await expect(added).toContainText('watcherUpdate')
      await expect(page.getByTestId('mission-control')).toBeVisible()
    } finally {
      await cleanDiffJourney(daemon, journey)
    }
  })
})
