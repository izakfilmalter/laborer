import { rm } from 'node:fs/promises'
import type { Locator, Page } from '@playwright/test'
import { Effect } from 'effect'
import {
  type DaemonFixture,
  expect,
  test,
} from '../fixtures/browser-fixtures.js'
import { initRepo } from '../fixtures/git-fixture.js'

interface LayoutJourney {
  readonly projectId: string
  readonly tempRoots: readonly string[]
  readonly workspaces: readonly [
    { readonly branchName: string; readonly id: string },
    { readonly branchName: string; readonly id: string },
  ]
}

const CLOSE_BUTTON_RE = /^Close /

const seedLayoutJourney = async (
  daemon: DaemonFixture,
  label: string
): Promise<LayoutJourney> => {
  const tempRoots: string[] = []
  const repoPath = initRepo(`layout-${label}`, tempRoots)
  const seeded = await daemon.rpc.run((client) =>
    Effect.gen(function* () {
      const project = yield* client['project.add']({ repoPath })
      const firstBranch = `${label}-first-${crypto.randomUUID()}`
      const secondBranch = `${label}-second-${crypto.randomUUID()}`
      const first = yield* client['workspace.create']({
        branchName: firstBranch,
        projectId: project.id,
      })
      const second = yield* client['workspace.create']({
        branchName: secondBranch,
        projectId: project.id,
      })
      return { first, project, second }
    })
  )

  return {
    projectId: seeded.project.id,
    tempRoots,
    workspaces: [
      { branchName: seeded.first.branchName, id: seeded.first.id },
      { branchName: seeded.second.branchName, id: seeded.second.id },
    ],
  }
}

const cleanLayoutJourney = async (
  daemon: DaemonFixture,
  journey: LayoutJourney
): Promise<void> => {
  for (const workspace of journey.workspaces) {
    try {
      await daemon.rpc.run((client) =>
        client['workspace.destroy']({
          force: true,
          workspaceId: workspace.id,
        }).pipe(Effect.asVoid)
      )
    } catch {
      // The UI journey may already have removed the workspace record.
    }
  }
  try {
    await daemon.rpc.run((client) =>
      client['project.remove']({ projectId: journey.projectId }).pipe(
        Effect.asVoid
      )
    )
  } finally {
    for (const root of journey.tempRoots) {
      await rm(root, { force: true, recursive: true })
    }
  }
}

const frameFor = (page: Page, workspaceId: string): Locator =>
  page.locator(
    `[data-testid="workspace-frame"][data-workspace-id="${workspaceId}"]`
  )

const tabBar = (page: Page, label: 'Panel Tabs' | 'Window Tabs'): Locator =>
  page.locator(`[data-testid="tab-bar"][data-tab-bar-label="${label}"]`)

const openWorkspaceInEmptyTab = async (
  page: Page,
  workspaceId: string
): Promise<Locator> => {
  const emptyTab = page.getByTestId('empty-window-tab-state')
  await expect(emptyTab).toBeVisible()
  await emptyTab
    .locator(
      `[data-testid="workspace-picker-item"][data-workspace-id="${workspaceId}"]`
    )
    .click()
  const frame = frameFor(page, workspaceId)
  await expect(frame).toBeVisible()
  return frame
}

const dragTab = async (
  page: Page,
  source: Locator,
  target: Locator
): Promise<void> => {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  if (!(sourceBox && targetBox)) {
    throw new Error('Tab drag landmarks were not measurable')
  }
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 16, sourceBox.y, {
    steps: 4,
  })
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 16 }
  )
  await page.mouse.up()
}

test.describe('workspaces, panels, and window tabs journeys', () => {
  test('opens, splits, rearranges, closes, and restores the layout', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedLayoutJourney(daemon, 'layout')
    const [first, second] = journey.workspaces

    try {
      const initialFrame = page.getByTestId('workspace-frame').filter({
        visible: true,
      })
      await expect(initialFrame).toHaveCount(1, { timeout: 30_000 })
      await initialFrame
        .getByRole('button', { name: 'Close workspace' })
        .click()

      const firstFrame = await openWorkspaceInEmptyTab(page, first.id)
      await firstFrame
        .getByTestId('panel-type-picker-option')
        .filter({ hasText: 'Terminal' })
        .click()
      const initialPane = firstFrame.getByTestId('panel-pane')
      await expect(initialPane).toHaveCount(1, { timeout: 30_000 })
      await initialPane.click()
      await page.keyboard.press('Meta+d')
      const splitPicker = firstFrame.getByTestId('panel-type-picker')
      await expect(splitPicker).toBeVisible()
      await splitPicker
        .getByTestId('panel-type-picker-option')
        .filter({ hasText: 'Diff' })
        .click()

      await expect(firstFrame.getByTestId('panel-pane')).toHaveCount(2)
      await expect(
        firstFrame.locator('[data-testid="panel-pane"][data-pane-type="diff"]')
      ).toBeVisible()

      const panels = tabBar(page, 'Panel Tabs')
      await panels.getByRole('button', { name: 'New tab' }).click()
      await page
        .getByTestId('panel-type-picker-option')
        .filter({ hasText: 'Diff' })
        .click()
      await expect(panels.getByTestId('tab-bar-tab')).toHaveCount(2)
      const panelLabelsBefore = await panels
        .getByTestId('tab-bar-tab')
        .allTextContents()
      await dragTab(
        page,
        panels.getByTestId('tab-bar-tab').nth(1),
        panels.getByTestId('tab-bar-tab').nth(0)
      )
      await expect
        .poll(() => panels.getByTestId('tab-bar-tab').allTextContents())
        .toEqual([...panelLabelsBefore].reverse())

      await panels
        .getByTestId('tab-bar-tab')
        .filter({ hasText: 'Terminal' })
        .click()
      await expect(firstFrame.getByTestId('panel-pane')).toHaveCount(2)

      await page.keyboard.press('Meta+t')
      const secondFrame = await openWorkspaceInEmptyTab(page, second.id)
      const windows = tabBar(page, 'Window Tabs')
      await expect(windows.getByTestId('tab-bar-tab')).toHaveCount(2)
      const windowIdsBefore = await windows
        .getByTestId('tab-bar-tab')
        .evaluateAll((tabs) =>
          tabs.map((tab) => tab.getAttribute('data-tab-id'))
        )
      await dragTab(
        page,
        windows.getByTestId('tab-bar-tab').nth(1),
        windows.getByTestId('tab-bar-tab').nth(0)
      )
      await expect
        .poll(() =>
          windows
            .getByTestId('tab-bar-tab')
            .evaluateAll((tabs) =>
              tabs.map((tab) => tab.getAttribute('data-tab-id'))
            )
        )
        .toEqual([...windowIdsBefore].reverse())
      await expect(secondFrame).toBeVisible()

      await page.reload()
      await expect(page.getByTestId('mission-control')).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        page.getByTestId('window-tab-content').filter({ visible: true })
      ).toHaveCount(1)
      await expect(frameFor(page, second.id)).toBeVisible({ timeout: 30_000 })
      await expect(
        tabBar(page, 'Window Tabs').getByTestId('tab-bar-tab')
      ).toHaveCount(2)

      const activeWindowTab = tabBar(page, 'Window Tabs').locator(
        '[data-testid="tab-bar-tab"][aria-selected="true"]'
      )
      await activeWindowTab
        .getByRole('button', { name: CLOSE_BUTTON_RE })
        .click()
      await expect(
        tabBar(page, 'Window Tabs').getByTestId('tab-bar-tab')
      ).toHaveCount(1)
      await expect(frameFor(page, first.id)).toBeVisible()
      await expect(
        frameFor(page, first.id).getByTestId('panel-pane')
      ).toHaveCount(2)

      const restoredPanels = tabBar(page, 'Panel Tabs')
      await restoredPanels
        .getByTestId('tab-bar-tab')
        .filter({ hasText: 'Diff' })
        .getByRole('button', { name: CLOSE_BUTTON_RE })
        .click()
      await expect(restoredPanels.getByTestId('tab-bar-tab')).toHaveCount(1)

      const diffPane = frameFor(page, first.id).locator(
        '[data-testid="panel-pane"][data-pane-type="diff"]'
      )
      await diffPane.click()
      await page.keyboard.press('Meta+w')
      await expect(
        frameFor(page, first.id).getByTestId('panel-pane')
      ).toHaveCount(1)
    } finally {
      await cleanLayoutJourney(daemon, journey)
    }
  })

  test('opens files and terminals in their intended workspace', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedLayoutJourney(daemon, 'cross-panel')
    const [first, second] = journey.workspaces

    try {
      const initialFrame = page.getByTestId('workspace-frame').filter({
        visible: true,
      })
      await expect(initialFrame).toHaveCount(1, { timeout: 30_000 })
      await initialFrame
        .getByRole('button', { name: 'Close workspace' })
        .click()
      await openWorkspaceInEmptyTab(page, first.id)

      const terminal = await daemon.rpc.run((client) =>
        client['terminal.spawn']({ workspaceId: second.id })
      )
      const terminalRow = page
        .getByTestId(`workspace-card-${second.branchName}`)
        .first()
        .getByTestId(`terminal-row-${terminal.id}`)
      await expect(terminalRow).toBeVisible({ timeout: 30_000 })
      await terminalRow.getByRole('button').first().click()

      const secondFrame = frameFor(page, second.id)
      await expect(secondFrame).toBeVisible({ timeout: 30_000 })
      await expect(
        secondFrame.locator(
          `[data-testid="panel-pane"][data-terminal-id="${terminal.id}"]`
        )
      ).toBeVisible()
      await expect(frameFor(page, first.id)).toBeVisible()

      await secondFrame.getByTestId('workspace-frame-header').click()
      await secondFrame.getByRole('button', { name: 'Open file tree' }).click()
      const tree = secondFrame.locator(
        `[data-testid="tree-pane"][data-workspace-id="${second.id}"]`
      )
      await expect(tree).toBeVisible()
      const readme = tree.getByRole('treeitem', { name: 'README.md' })
      await expect(readme).toBeVisible()
      await readme.click()
      await expect(readme).toHaveAttribute('aria-selected', 'true')
      await expect(
        frameFor(page, first.id).locator('[data-testid="tree-pane"]')
      ).toHaveCount(0)
    } finally {
      await cleanLayoutJourney(daemon, journey)
    }
  })
})
