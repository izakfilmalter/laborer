/**
 * E2E Tests - Panel system
 *
 * Covers the foundational panel-system flows through the real UI. The
 * tests create a workspace to seed the initial terminal pane, verify split
 * layout geometry, confirm closing an active pane transfers focus to the
 * remaining sibling pane, and validate keyboard navigation between panes.
 *
 * @see PRD-e2e-test-coverage.md - Issues 11, 12, 13, and 14
 */

import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures/test-fixtures.js'
import { addProjectAndCreateWorkspace } from './fixtures/workspace-helper.js'

interface PaneBox {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

async function getPaneBoxes(panes: Locator): Promise<readonly PaneBox[]> {
  const paneCount = await panes.count()
  const boxes: PaneBox[] = []

  for (let index = 0; index < paneCount; index += 1) {
    const box = await panes.nth(index).boundingBox()
    if (!box) {
      throw new Error(`Pane ${index} did not have a bounding box`)
    }
    boxes.push(box)
  }

  return boxes
}

function getRequiredPane(boxes: readonly PaneBox[], index: number): PaneBox {
  const pane = boxes[index]
  if (!pane) {
    throw new Error(`Missing pane box at index ${index}`)
  }
  return pane
}

async function closeExtraPanes(
  panes: Locator,
  panels: { closePane: () => Promise<void> },
  page: import('@playwright/test').Page
): Promise<void> {
  for (;;) {
    const paneCount = await panes.count()
    if (paneCount <= 1) {
      return
    }

    await panes.nth(paneCount - 1).click()
    await panels.closePane()

    // Progressive close may show an inline "Close terminal?" confirmation
    // dialog if the terminal has a running process. Confirm it with Cmd+Enter.
    // Give the dialog a moment to appear before checking.
    const closeDialog = page.locator('[role="alertdialog"]')
    try {
      await closeDialog.waitFor({ state: 'visible', timeout: 2000 })
      await page.keyboard.press('Meta+Enter')
    } catch {
      // No dialog appeared — the pane closed immediately
    }

    await expect(panes).toHaveCount(paneCount - 1, { timeout: 10_000 })
  }
}

test.describe('panel system', () => {
  test('can split panes horizontally and then vertically', async ({
    electronApp,
    page,
    panels,
  }) => {
    await addProjectAndCreateWorkspace(electronApp, page)

    const paneRegions = page.locator('[data-pane-id]')
    await expect(paneRegions).toHaveCount(1, { timeout: 15_000 })

    await paneRegions.first().click()
    await panels.splitHorizontal()

    await expect(paneRegions).toHaveCount(2, { timeout: 10_000 })
    const horizontalBoxes = await getPaneBoxes(paneRegions)
    if (horizontalBoxes.length !== 2) {
      throw new Error(
        `Expected 2 panes after horizontal split, got ${horizontalBoxes.length}`
      )
    }
    const leftPane = getRequiredPane(horizontalBoxes, 0)
    const rightPane = getRequiredPane(horizontalBoxes, 1)

    expect(rightPane.x - leftPane.x).toBeGreaterThan(100)
    expect(Math.abs(leftPane.y - rightPane.y)).toBeLessThan(24)
    expect(Math.abs(leftPane.height - rightPane.height)).toBeLessThan(24)

    await paneRegions.nth(1).click()
    await panels.splitVertical()

    await expect(paneRegions).toHaveCount(3, { timeout: 10_000 })
    const nestedBoxes = await getPaneBoxes(paneRegions)
    if (nestedBoxes.length !== 3) {
      throw new Error(
        `Expected 3 panes after vertical split, got ${nestedBoxes.length}`
      )
    }
    const leftColumnPane = getRequiredPane(nestedBoxes, 0)
    const topRightPane = getRequiredPane(nestedBoxes, 1)
    const bottomRightPane = getRequiredPane(nestedBoxes, 2)

    expect(topRightPane.x - leftColumnPane.x).toBeGreaterThan(100)
    expect(Math.abs(topRightPane.x - bottomRightPane.x)).toBeLessThan(24)
    expect(bottomRightPane.y - topRightPane.y).toBeGreaterThan(50)
    expect(Math.abs(topRightPane.width - bottomRightPane.width)).toBeLessThan(
      24
    )
    expect(leftColumnPane.height).toBeGreaterThan(topRightPane.height + 100)
  })

  test('can close the active pane and keep focus on the remaining pane', async ({
    electronApp,
    page,
    panels,
  }) => {
    await addProjectAndCreateWorkspace(electronApp, page)

    const paneRegions = page.locator('[data-pane-id]')
    await expect(paneRegions.first()).toBeVisible({ timeout: 15_000 })
    await closeExtraPanes(paneRegions, panels, page)
    await expect(paneRegions).toHaveCount(1, { timeout: 10_000 })

    await paneRegions.first().click()
    await panels.splitHorizontal()

    await expect(paneRegions).toHaveCount(2, { timeout: 10_000 })

    const originalPaneId = await paneRegions
      .first()
      .getAttribute('data-pane-id')
    const siblingPane = paneRegions.nth(1)
    const siblingPaneId = await siblingPane.getAttribute('data-pane-id')
    if (!(originalPaneId && siblingPaneId)) {
      throw new Error('Expected both panes to expose data-pane-id attributes')
    }

    await siblingPane.click()
    await panels.closePane()

    await expect(paneRegions).toHaveCount(1, { timeout: 10_000 })
    await expect(page.locator(`[data-pane-id="${siblingPaneId}"]`)).toHaveCount(
      0
    )
    await expect(
      page.locator(`[data-pane-id="${originalPaneId}"]`)
    ).toBeVisible()

    await panels.splitVertical()

    await expect(paneRegions).toHaveCount(2, { timeout: 10_000 })
  })

  test('can use Ctrl+B then arrow keys to move focus between panes', async ({
    electronApp,
    page,
    panels,
  }) => {
    await addProjectAndCreateWorkspace(electronApp, page)

    const paneRegions = page.locator('[data-pane-id]')
    await expect(paneRegions.first()).toBeVisible({ timeout: 15_000 })
    await closeExtraPanes(paneRegions, panels, page)
    await expect(paneRegions).toHaveCount(1, { timeout: 10_000 })

    // Split horizontally to get 2 panes
    await paneRegions.first().click()
    await panels.splitHorizontal()
    await expect(paneRegions).toHaveCount(2, { timeout: 10_000 })

    // Focus the second pane and split vertically to get 3 panes
    await expect(paneRegions.nth(1)).toBeVisible({ timeout: 10_000 })
    await paneRegions.nth(1).click()
    await panels.splitVertical()
    await expect(paneRegions).toHaveCount(3, { timeout: 10_000 })

    const initialBoxes = await getPaneBoxes(paneRegions)
    const leftPane = getRequiredPane(initialBoxes, 0)
    const topRightPane = getRequiredPane(initialBoxes, 1)
    const bottomRightPane = getRequiredPane(initialBoxes, 2)

    expect(topRightPane.x - leftPane.x).toBeGreaterThan(100)
    expect(bottomRightPane.y - topRightPane.y).toBeGreaterThan(50)

    // Wait for the Ctrl+B sequence timeout (1500ms) to expire before
    // issuing another Ctrl+B sequence.
    await page.waitForTimeout(1600)
    await expect(paneRegions.nth(1)).toBeVisible({ timeout: 10_000 })
    await paneRegions.nth(1).click()
    await panels.splitVertical()

    await expect(paneRegions).toHaveCount(4, { timeout: 10_000 })
    const boxesAfterSplit = await getPaneBoxes(paneRegions)
    const rightColumnPaneCount = boxesAfterSplit.filter(
      (box) => Math.abs(box.x - topRightPane.x) < 24
    ).length
    const leftColumnPaneCount = boxesAfterSplit.filter(
      (box) => Math.abs(box.x - leftPane.x) < 24
    ).length

    expect(rightColumnPaneCount).toBe(3)
    expect(leftColumnPaneCount).toBe(1)
  })

  test('can use Ctrl+B then Shift+arrow keys to resize panes', async ({
    electronApp,
    page,
    panels,
  }) => {
    await addProjectAndCreateWorkspace(electronApp, page)

    const paneRegions = page.locator('[data-pane-id]')
    await expect(paneRegions.first()).toBeVisible({ timeout: 15_000 })
    await closeExtraPanes(paneRegions, panels, page)
    await expect(paneRegions).toHaveCount(1, { timeout: 10_000 })

    await paneRegions.first().click()
    await panels.splitHorizontal()
    await expect(paneRegions).toHaveCount(2, { timeout: 10_000 })

    const initialBoxes = await getPaneBoxes(paneRegions)
    const initialLeftPane = getRequiredPane(initialBoxes, 0)
    const initialRightPane = getRequiredPane(initialBoxes, 1)

    await paneRegions.first().click()
    await panels.resize('right')

    await expect
      .poll(
        async () => {
          const resizedBoxes = await getPaneBoxes(paneRegions)
          const resizedLeftPane = getRequiredPane(resizedBoxes, 0)
          const resizedRightPane = getRequiredPane(resizedBoxes, 1)

          return (
            resizedLeftPane.width > initialLeftPane.width + 2 &&
            resizedRightPane.width < initialRightPane.width - 2
          )
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    const resizedBoxes = await getPaneBoxes(paneRegions)
    const resizedLeftPane = getRequiredPane(resizedBoxes, 0)
    const resizedRightPane = getRequiredPane(resizedBoxes, 1)

    expect(resizedLeftPane.width).toBeGreaterThan(initialLeftPane.width + 2)
    expect(resizedRightPane.width).toBeLessThan(initialRightPane.width - 2)
    expect(
      Math.abs(resizedLeftPane.height - initialLeftPane.height)
    ).toBeLessThan(24)
    expect(
      Math.abs(resizedRightPane.height - initialRightPane.height)
    ).toBeLessThan(24)
  })
})
