/**
 * E2E Tests — Terminal close + sidebar sync
 *
 * Verifies that closing a terminal (via sidebar X button) properly
 * removes it from the sidebar, and that the terminal does not reappear
 * when subsequent actions (spawning new terminals) trigger events on
 * the terminal.events stream.
 *
 * This test catches a specific bug where the terminal.events stream's
 * internal Ref retained a removed terminal, and a ProcessChanged event
 * arriving after an optimistic removal would re-add the terminal to the
 * sidebar list.
 *
 * @see apps/web/src/hooks/use-terminal-list.ts — pendingRemovals guard
 */

import { expect, test } from './fixtures/test-fixtures.js'
import { addProjectAndCreateWorkspace } from './fixtures/workspace-helper.js'

test.describe('terminal close — sidebar sync', () => {
  test('closing a terminal via sidebar X removes it from the sidebar', async ({
    electronApp,
    page,
  }) => {
    const branchName = `e2e-close-sync-${Date.now()}`
    await addProjectAndCreateWorkspace(electronApp, page, branchName)

    // Scope all locators to this workspace's card by finding the card
    // that contains the branch name text. The Card renders as a div with
    // data-slot="card".
    const workspaceCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: branchName })
    await expect(workspaceCard).toBeVisible({ timeout: 10_000 })

    // Spawn a terminal via the workspace card's "New" button.
    // Retry if the terminal doesn't appear — the spawn can fail silently
    // when the workspace is still in "creating" state.
    const terminalRows = workspaceCard.locator('[data-testid^="terminal-row-"]')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const btn = workspaceCard.getByRole('button', { name: 'New terminal' })
      await expect(btn).toBeVisible({ timeout: 15_000 })
      await btn.click()
      try {
        await terminalRows
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
        break
      } catch {
        // Terminal spawn may have failed — retry
      }
    }
    await expect(terminalRows).toHaveCount(1, { timeout: 5000 })

    // Close the terminal via the sidebar X button inside this workspace card.
    // This may show a "Close terminal?" confirmation dialog if the terminal
    // has a running process. Confirm it with Meta+Enter.
    await workspaceCard
      .getByRole('button', { name: 'Close terminal' })
      .first()
      .click()

    const closeDialog = page.locator('[role="alertdialog"]')
    try {
      await closeDialog.waitFor({ state: 'visible', timeout: 2000 })
      await page.keyboard.press('Meta+Enter')
    } catch {
      // No dialog appeared — the close happened immediately
    }

    // The terminal should disappear — the card is left with no rows
    await expect(terminalRows).toHaveCount(0, { timeout: 15_000 })
  })

  test('closed terminal does not reappear after spawning a new one', async ({
    electronApp,
    page,
  }) => {
    const branchName = `e2e-close-ghost-${Date.now()}`
    await addProjectAndCreateWorkspace(electronApp, page, branchName)

    // Scope all locators to this workspace's card
    const workspaceCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: branchName })
    await expect(workspaceCard).toBeVisible({ timeout: 10_000 })

    // Spawn the first terminal via the workspace card's "New" button.
    // Retry if the terminal doesn't appear — the spawn can fail silently
    // when the workspace is still in "creating" state.
    const terminalRows = workspaceCard.locator('[data-testid^="terminal-row-"]')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const newTerminalButton = workspaceCard.getByRole('button', {
        name: 'New terminal',
      })
      await expect(newTerminalButton).toBeVisible({ timeout: 15_000 })
      await newTerminalButton.click()
      try {
        await terminalRows
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
        break
      } catch {
        // Terminal spawn may have failed — retry
      }
    }
    await expect(terminalRows).toHaveCount(1, { timeout: 5000 })

    // Close the terminal via the sidebar X button inside this workspace card.
    // Handle the "Close terminal?" confirmation dialog if it appears.
    await workspaceCard
      .getByRole('button', { name: 'Close terminal' })
      .first()
      .click()

    const closeDialog = page.locator('[role="alertdialog"]')
    try {
      await closeDialog.waitFor({ state: 'visible', timeout: 2000 })
      await page.keyboard.press('Meta+Enter')
    } catch {
      // No dialog appeared — the close happened immediately
    }

    // Wait for the terminal to actually disappear
    await expect(terminalRows).toHaveCount(0, { timeout: 15_000 })

    // Spawn a new terminal
    const newTerminalButton2 = workspaceCard.getByRole('button', {
      name: 'New terminal',
    })
    await expect(newTerminalButton2).toBeVisible({ timeout: 15_000 })
    await newTerminalButton2.click()

    // The critical assertion: the card holds exactly one row. Before the fix
    // the old terminal would reappear as a ghost alongside the new one.
    await expect(terminalRows).toHaveCount(1, { timeout: 30_000 })

    // Wait for any delayed ProcessChanged events from the 200ms
    // detection fiber, then verify the ghost still hasn't reappeared.
    await page.waitForTimeout(1000)
    await expect(terminalRows).toHaveCount(1)
  })
})
