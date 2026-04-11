import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page, test } from '@playwright/test'

const workspaceRoot = path.resolve(
  fileURLToPath(new URL('../../..', import.meta.url))
)
const projectName = path.basename(workspaceRoot)

const openProjectInSidebar = async (page: Page) => {
  await page.getByLabel('Add project').click()
  await page.getByPlaceholder('/path/to/project').fill(workspaceRoot)
  await page.getByRole('button', { exact: true, name: 'Add' }).click()
  await expect(
    page.getByRole('button', { name: new RegExp(projectName, 'i') }).first()
  ).toBeVisible()
}

const createThread = async (page: Page): Promise<string> => {
  const projectButton = page
    .getByRole('button', { name: new RegExp(projectName, 'i') })
    .first()

  await projectButton.hover()
  await page.getByLabel(`Create new thread in ${projectName}`).click()

  const threadRow = page.getByTestId('thread-row').first()
  await expect(threadRow).toBeVisible()
  await expect(page.getByTestId('thread-terminal-workspace')).toBeVisible()

  return (await threadRow.getAttribute('data-thread-id')) ?? ''
}

const selectThread = async (page: Page, threadId: string) => {
  await page
    .locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`)
    .click()
}

const activeStatus = (page: Page) => page.getByTestId('thread-terminal-status')

const workspace = (page: Page): Locator =>
  page.getByTestId('thread-terminal-workspace')

const terminalPane = (page: Page, index = 0): Locator =>
  page.getByTestId('terminal-pane').nth(index)

const terminalViewport = (page: Page, index = 0): Locator =>
  terminalPane(page, index).getByTestId('terminal-viewport')

const terminalDisplay = (page: Page, index = 0): Locator =>
  terminalPane(page, index).locator('.xterm')

const terminalNavItems = (page: Page): Locator =>
  page.getByTestId('terminal-sidebar').getByTestId('terminal-nav-item')

const runTerminalCommand = async (
  page: Page,
  command: string,
  paneIndex = 0
) => {
  await terminalViewport(page, paneIndex).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test.describe('thread terminal workspace', () => {
  test('opens a live terminal for a new thread', async ({ page }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    await createThread(page)

    await expect(
      page.getByRole('heading', { name: 'New thread' })
    ).toBeVisible()
    await expect(
      page.getByTestId('thread-terminal-workspace').getByText(workspaceRoot)
    ).toBeVisible()
    await expect(activeStatus(page)).toHaveText('Ready')
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await runTerminalCommand(page, 'sleep 2')

    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })

  test('supports split and new layouts and restores them after reload', async ({
    page,
  }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    const threadId = await createThread(page)

    await workspace(page).getByRole('button', { name: 'Split' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)
    await expect(terminalNavItems(page)).toHaveCount(2)

    await workspace(page).getByRole('button', { name: 'New' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)
    await expect(terminalNavItems(page)).toHaveCount(3)

    await page.reload()
    await selectThread(page, threadId)
    await expect(terminalNavItems(page)).toHaveCount(3)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await terminalNavItems(page).first().click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)
  })

  test('keeps terminal layouts isolated per thread across reloads', async ({
    page,
  }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    const firstThreadId = await createThread(page)

    await workspace(page).getByRole('button', { name: 'Split' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    const secondThreadId = await createThread(page)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await selectThread(page, firstThreadId)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    await page.reload()
    await selectThread(page, firstThreadId)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    await selectThread(page, secondThreadId)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)
  })

  test('reattaches a thread to its running terminal session', async ({
    page,
  }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    const firstThreadId = await createThread(page)

    await runTerminalCommand(page, 'sleep 8')
    await expect(activeStatus(page)).toHaveText('Busy')

    const secondThreadId = await createThread(page)
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })

    await selectThread(page, firstThreadId)
    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 12_000 })

    await selectThread(page, secondThreadId)
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })

  test('restarts the active terminal and keeps it interactive', async ({
    page,
  }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    await createThread(page)

    await runTerminalCommand(page, 'sleep 10')
    await expect(activeStatus(page)).toHaveText('Busy')

    await workspace(page).getByRole('button', { name: 'Restart' }).click()
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })

    await runTerminalCommand(page, 'sleep 1')
    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })

  test('clears the active terminal output and keeps it interactive', async ({
    page,
  }) => {
    await page.goto('/')
    await openProjectInSidebar(page)
    await createThread(page)

    await runTerminalCommand(page, 'printf "clear-marker\\n"')
    await expect(terminalDisplay(page)).toContainText('clear-marker')

    await workspace(page).getByRole('button', { name: 'Clear' }).click()
    await expect(terminalDisplay(page)).not.toContainText('clear-marker')

    await runTerminalCommand(page, 'sleep 1')
    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })
})
