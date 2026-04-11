import { cp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page, test } from '@playwright/test'

const fixtureRepoTemplateRoot = path.resolve(
  fileURLToPath(
    new URL(
      '../.playwright/server-state/repos/workspace-fixture',
      import.meta.url
    )
  )
)
const defaultWorkspaceName = 'laborer/my-feature'

interface ProjectFixture {
  readonly projectName: string
  readonly projectRoot: string
  readonly worktreesRoot: string
}

const resolveWorktreeRoot = (project: ProjectFixture, workspaceName: string) =>
  path.join(project.worktreesRoot, workspaceName.replaceAll('/', '-'))

interface CreatedWorkspace {
  readonly name: string
}

const escapeRegExp = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

const prepareProjectFixture = async (
  suffix: string
): Promise<ProjectFixture> => {
  const projectRoot = path.join(
    path.dirname(fixtureRepoTemplateRoot),
    `workspace-fixture-${suffix}`
  )

  await rm(projectRoot, { force: true, recursive: true })
  await cp(fixtureRepoTemplateRoot, projectRoot, { recursive: true })

  return {
    projectName: path.basename(projectRoot),
    projectRoot,
    worktreesRoot: `${projectRoot}.worktrees`,
  }
}

const openProjectInSidebar = async (page: Page, project: ProjectFixture) => {
  await page.getByLabel('Add project').click()
  await page.getByPlaceholder('/path/to/project').fill(project.projectRoot)
  await page.getByRole('button', { exact: true, name: 'Add' }).click()
  await expect(
    page
      .getByRole('button', { name: new RegExp(project.projectName, 'i') })
      .first()
  ).toBeVisible()
}

const createWorkspace = async (
  page: Page,
  project: ProjectFixture,
  workspaceName = defaultWorkspaceName
): Promise<CreatedWorkspace> => {
  const projectButton = page
    .getByRole('button', { name: new RegExp(project.projectName, 'i') })
    .first()

  await projectButton.hover()
  await page
    .getByLabel(`Create new workspace in ${project.projectName}`)
    .click()
  await page.getByLabel('Workspace name').fill(workspaceName)
  await page.getByRole('button', { name: 'Create workspace' }).click()

  const workspaceRow = page
    .getByTestId('workspace-row')
    .filter({ hasText: workspaceName })
    .first()
  await expect(workspaceRow).toBeVisible()
  await expect(page.getByTestId('workspace-terminal-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible()

  return {
    name: workspaceName,
  }
}

const selectWorkspace = async (page: Page, workspace: CreatedWorkspace) => {
  const row = page
    .getByRole('button', { name: new RegExp(escapeRegExp(workspace.name)) })
    .first()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await expect(
    page.getByRole('heading', { name: workspace.name })
  ).toBeVisible()
}

const activeStatus = (page: Page) =>
  page.getByTestId('workspace-terminal-status')

const workspace = (page: Page): Locator =>
  page.getByTestId('workspace-terminal-workspace')

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

test.describe('workspace terminal workspace', () => {
  test('opens a live terminal for a new workspace worktree', async ({
    page,
  }) => {
    const project = await prepareProjectFixture('basic')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    await createWorkspace(page, project)

    const expectedWorkspaceRoot = resolveWorktreeRoot(
      project,
      defaultWorkspaceName
    )

    await expect(
      page.getByRole('heading', { name: defaultWorkspaceName })
    ).toBeVisible()
    await expect(
      page
        .getByTestId('workspace-terminal-workspace')
        .getByText(expectedWorkspaceRoot)
    ).toBeVisible()
    await expect
      .poll(async () => (await stat(expectedWorkspaceRoot)).isDirectory())
      .toBe(true)
    await expect(activeStatus(page)).toHaveText('Ready')
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await runTerminalCommand(page, 'git branch --show-current')
    await expect(terminalDisplay(page)).toContainText(defaultWorkspaceName)

    await runTerminalCommand(page, 'sleep 2')

    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })

  test('supports split and new layouts and restores them after reload', async ({
    page,
  }) => {
    const project = await prepareProjectFixture('layout-restore')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    const createdWorkspace = await createWorkspace(
      page,
      project,
      'laborer/layout-restore'
    )

    await workspace(page).getByRole('button', { name: 'Split' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)
    await expect(terminalNavItems(page)).toHaveCount(2)

    await workspace(page).getByRole('button', { name: 'New' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)
    await expect(terminalNavItems(page)).toHaveCount(3)

    await page.reload()
    await selectWorkspace(page, createdWorkspace)
    await expect(terminalNavItems(page)).toHaveCount(3)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await terminalNavItems(page).first().click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)
  })

  test('keeps terminal layouts isolated per workspace across reloads', async ({
    page,
  }) => {
    const project = await prepareProjectFixture('layout-isolation')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    const firstWorkspace = await createWorkspace(page, project, 'laborer/first')

    await workspace(page).getByRole('button', { name: 'Split' }).click()
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    const secondWorkspace = await createWorkspace(
      page,
      project,
      'laborer/second'
    )
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)

    await selectWorkspace(page, firstWorkspace)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    await page.reload()
    await selectWorkspace(page, firstWorkspace)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(2)

    await selectWorkspace(page, secondWorkspace)
    await expect(page.getByTestId('terminal-pane')).toHaveCount(1)
  })

  test('reattaches a workspace to its running terminal session', async ({
    page,
  }) => {
    const project = await prepareProjectFixture('reattach')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    const firstWorkspace = await createWorkspace(
      page,
      project,
      'laborer/reattach-one'
    )

    await runTerminalCommand(page, 'sleep 8')
    await expect(activeStatus(page)).toHaveText('Busy')

    const secondWorkspace = await createWorkspace(
      page,
      project,
      'laborer/reattach-two'
    )
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })

    await selectWorkspace(page, firstWorkspace)
    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 12_000 })

    await selectWorkspace(page, secondWorkspace)
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })

  test('restarts the active terminal and keeps it interactive', async ({
    page,
  }) => {
    const project = await prepareProjectFixture('restart')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    await createWorkspace(page, project, 'laborer/restart')

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
    const project = await prepareProjectFixture('clear')

    await page.goto('/')
    await openProjectInSidebar(page, project)
    await createWorkspace(page, project, 'laborer/clear')

    await runTerminalCommand(page, 'printf "clear-marker\\n"')
    await expect(terminalDisplay(page)).toContainText('clear-marker')

    await workspace(page).getByRole('button', { name: 'Clear' }).click()
    await expect(terminalDisplay(page)).not.toContainText('clear-marker')

    await runTerminalCommand(page, 'sleep 1')
    await expect(activeStatus(page)).toHaveText('Busy')
    await expect(activeStatus(page)).toHaveText('Ready', { timeout: 10_000 })
  })
})
