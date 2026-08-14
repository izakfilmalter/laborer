import type { Locator } from '@playwright/test'
import { expect, test } from '../fixtures/browser-fixtures.js'

const openTerminal = async (
  workspaceCard: Locator,
  terminal: { readonly terminalPanes: Locator; bufferText(): Promise<string> }
): Promise<void> => {
  await workspaceCard.getByRole('button', { name: 'New terminal' }).click()
  await expect(terminal.terminalPanes.first()).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await terminal.bufferText()).trim(), { timeout: 30_000 })
    .not.toBe('')
}

test.describe('browser terminal gate', () => {
  test('spawns a shell and completes an input round-trip', async ({
    app: _app,
    page,
    seededWorkspace,
    terminal,
  }) => {
    const card = page
      .getByTestId(`workspace-card-${seededWorkspace.branchName}`)
      .first()
    await openTerminal(card, terminal)

    const sentinel = `spawn-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${sentinel}`)
    await terminal.waitForOutput(sentinel)
  })

  test('keeps a terminal session across a UI reload', async ({
    app: _app,
    page,
    seededWorkspace,
    terminal,
  }) => {
    const card = page
      .getByTestId(`workspace-card-${seededWorkspace.branchName}`)
      .first()
    await openTerminal(card, terminal)

    const beforeReload = `before-reload-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${beforeReload}`)
    await terminal.waitForOutput(beforeReload)

    await page.reload()
    await expect(terminal.terminalPanes.first()).toBeVisible({
      timeout: 30_000,
    })
    await terminal.waitForOutput(beforeReload, 30_000)

    const afterReload = `after-reload-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${afterReload}`)
    await terminal.waitForOutput(afterReload)
  })

  test('preserves content and interactivity across a daemon restart', async ({
    app: _app,
    daemon,
    page,
    seededWorkspace,
    terminal,
  }) => {
    test.skip(
      process.env.LABORER_E2E_REUSE_DEV_STACK === '1',
      'restart journeys require the isolated fixture-owned daemon'
    )
    const card = page
      .getByTestId(`workspace-card-${seededWorkspace.branchName}`)
      .first()
    await openTerminal(card, terminal)

    const beforeRestart = `before-restart-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${beforeRestart}`)
    await terminal.waitForOutput(beforeRestart)

    await daemon.stop()
    await expect(page.getByTestId('terminal-connection-status')).toBeVisible({
      timeout: 10_000,
    })
    await daemon.restart()
    await expect(page.getByTestId('terminal-connection-status')).toBeHidden({
      timeout: 30_000,
    })
    await terminal.waitForOutput(beforeRestart, 30_000)

    const afterRestart = `after-restart-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${afterRestart}`)
    await terminal.waitForOutput(afterRestart, 30_000)
  })

  test('shows the disconnect banner after grace and clears it on reconnect', async ({
    app: _app,
    daemon,
    page,
    seededWorkspace,
    terminal,
  }) => {
    test.skip(
      process.env.LABORER_E2E_REUSE_DEV_STACK === '1',
      'disconnect journeys require the isolated fixture-owned daemon'
    )
    const card = page
      .getByTestId(`workspace-card-${seededWorkspace.branchName}`)
      .first()
    await openTerminal(card, terminal)

    const beforeDisconnect = `before-disconnect-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${beforeDisconnect}`)
    await terminal.waitForOutput(beforeDisconnect)

    await daemon.stop()
    await expect(page.getByTestId('reconnect-banner')).toBeVisible({
      timeout: 10_000,
    })

    await daemon.restart()
    await expect(page.getByTestId('reconnect-banner')).toBeHidden({
      timeout: 30_000,
    })
    await expect(page.getByTestId('terminal-connection-status')).toBeHidden({
      timeout: 30_000,
    })
    await terminal.waitForOutput(beforeDisconnect, 30_000)

    const afterDisconnect = `after-disconnect-${crypto.randomUUID()}`
    await terminal.typeCommand(`echo ${afterDisconnect}`)
    await terminal.waitForOutput(afterDisconnect, 30_000)
  })
})
