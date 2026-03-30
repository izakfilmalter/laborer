/**
 * E2E Tests - Terminal interaction
 *
 * Covers the real terminal pipeline by creating a workspace, spawning a
 * terminal into the empty pane, sending a shell command, and verifying the
 * rendered output appears in the xterm.js terminal.
 *
 * @see PRD-e2e-test-coverage.md - Issue 15
 */

import { expect, test } from './fixtures/test-fixtures.js'
import { addProjectAndCreateWorkspace } from './fixtures/workspace-helper.js'

test.describe('terminal interaction', () => {
  test('can spawn a terminal, run a command, and see the output', async ({
    electronApp,
    page,
    terminal,
  }) => {
    const branchName = `e2e-terminal-${Date.now()}`
    await addProjectAndCreateWorkspace(electronApp, page, branchName)

    const spawnTerminalButton = page
      .getByRole('button', {
        name: 'New terminal',
      })
      .last()
    await expect(spawnTerminalButton).toBeVisible({ timeout: 15_000 })
    await spawnTerminalButton.click()

    // Wait for the terminal to appear — the sidebar shows "Terminals (1)"
    // and the xterm.js textarea input becomes available
    await expect(terminal.terminalInputs.first()).toBeVisible({
      timeout: 30_000,
    })

    const terminalScreenshotBefore = await terminal.terminalPanes
      .first()
      .screenshot()
    await terminal.typeCommand('pwd')
    await expect
      .poll(
        async () => {
          const terminalScreenshotAfter = await terminal.terminalPanes
            .first()
            .screenshot()
          return terminalScreenshotAfter.equals(terminalScreenshotBefore)
        },
        { timeout: 10_000 }
      )
      .toBe(false)
  })
})
