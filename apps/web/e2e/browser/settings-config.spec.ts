import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { Effect } from 'effect'
import {
  type DaemonFixture,
  expect,
  test,
} from '../fixtures/browser-fixtures.js'
import { initRepo } from '../fixtures/git-fixture.js'

interface SettingsJourney {
  readonly projectId: string
  readonly projectName: string
  readonly tempRoots: readonly string[]
}

const seedSettingsJourney = async (
  daemon: DaemonFixture,
  label: string
): Promise<SettingsJourney> => {
  const tempRoots: string[] = []
  const repoPath = initRepo(`settings-${label}`, tempRoots)
  const project = await daemon.rpc.run((client) =>
    client['project.add']({ repoPath })
  )

  return {
    projectId: project.id,
    projectName: basename(repoPath),
    tempRoots,
  }
}

const cleanSettingsJourney = async (
  daemon: DaemonFixture,
  journey: SettingsJourney
): Promise<void> => {
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

test.describe('settings and config journeys', () => {
  test('edits app settings, rejects invalid connection input, and persists', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedSettingsJourney(daemon, 'app')

    try {
      const group = page
        .getByTestId('project-group')
        .filter({ hasText: journey.projectName })
      await expect(group).toBeVisible({ timeout: 30_000 })

      await page.getByTestId('open-app-settings').click()
      const settings = page.getByTestId('app-settings')
      await expect(settings).toBeVisible()
      await settings.getByTestId('default-agent-select').click()
      await page.getByTestId('default-agent-option-codex').click()
      await settings.getByTestId('save-default-agent').click()
      await expect(page.getByTestId('toast-region')).toContainText(
        'Saved default agent'
      )

      await settings
        .getByTestId('github-callback-url')
        .fill('https://example.test/oauth?state=invalid')
      await settings.getByTestId('submit-github-callback').click()
      await expect(settings.getByTestId('github-connection-error')).toHaveText(
        'No authorization code found in the URL.'
      )
      await expect(settings.getByTestId('github-connection-status')).toHaveText(
        'not connected'
      )

      await page.reload()
      await expect(page.getByTestId('mission-control')).toBeVisible({
        timeout: 30_000,
      })
      const reloadedGroup = page
        .getByTestId('project-group')
        .filter({ hasText: journey.projectName })
      await expect(
        reloadedGroup.getByTestId('start-agent')
      ).toHaveAccessibleName('Start codex agent')

      await page.getByTestId('open-app-settings').click()
      const reloadedSettings = page.getByTestId('app-settings')
      await expect(
        reloadedSettings.getByTestId('default-agent-select')
      ).toContainText('Codex')
      await expect(
        reloadedSettings.getByTestId('github-connection-status')
      ).toHaveText('not connected')
    } finally {
      await daemon.rpc.run((client) =>
        client['globalConfig.update']({ config: { agent: 'opencode2' } })
      )
      await cleanSettingsJourney(daemon, journey)
    }
  })

  test('edits project config and applies the project agent override', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedSettingsJourney(daemon, 'project')
    const worktreeDir = `${daemon.stateDir}/configured-worktrees-${crypto.randomUUID()}`
    const setupScript = 'printf configured > e2e-configured.txt'

    try {
      const group = page
        .getByTestId('project-group')
        .filter({ hasText: journey.projectName })
      await expect(group).toBeVisible({ timeout: 30_000 })
      await group.getByTestId('open-project-settings').click()

      const settings = page.getByTestId('project-settings')
      await expect(settings).toBeVisible()
      await settings.getByTestId('project-agent-select').click()
      await page.getByTestId('project-agent-option-claude').click()
      await settings.getByTestId('project-worktree-dir').fill(worktreeDir)
      await settings.getByTestId('add-project-setup-script').click()
      await settings.getByTestId('project-setup-script').fill(setupScript)
      await settings.getByTestId('save-project-settings').click()

      await expect(settings).toBeHidden()
      await expect(page.getByTestId('toast-region')).toContainText(
        `Saved settings for ${journey.projectName}`
      )
      await expect(group.getByTestId('start-agent')).toHaveAccessibleName(
        'Start claude agent'
      )

      await page.reload()
      await expect(page.getByTestId('mission-control')).toBeVisible({
        timeout: 30_000,
      })
      const reloadedGroup = page
        .getByTestId('project-group')
        .filter({ hasText: journey.projectName })
      await reloadedGroup.getByTestId('open-project-settings').click()
      const reloadedSettings = page.getByTestId('project-settings')
      await expect(
        reloadedSettings.getByTestId('project-agent-select')
      ).toContainText('Claude')
      await expect(
        reloadedSettings.getByTestId('project-worktree-dir')
      ).toHaveValue(worktreeDir)
      await expect(
        reloadedSettings.getByTestId('project-setup-script')
      ).toHaveValue(setupScript)
      await reloadedSettings.press('Escape')
      await expect(reloadedSettings).toBeHidden()
      await expect(
        reloadedGroup.getByTestId('start-agent')
      ).toHaveAccessibleName('Start claude agent')
    } finally {
      await cleanSettingsJourney(daemon, journey)
    }
  })
})
