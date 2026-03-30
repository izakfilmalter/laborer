/**
 * E2E Tests - Dashboard
 *
 * Covers the cross-project dashboard summary flow through the real UI by
 * creating a project and workspace, switching to the dashboard, verifying
 * the overview and project section render, checking workspace status badges,
 * and then switching back to the terminal panel view.
 *
 * @see PRD-e2e-test-coverage.md - Issues 19 and 20
 */

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test-fixtures.js'
import { addProjectAndCreateWorkspace } from './fixtures/workspace-helper.js'

function getProjectDashboardCard(page: Page, repoPath: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(repoPath, { exact: true }) })
}

test.describe('dashboard', () => {
  test('can switch to the dashboard and see the cross-project summary', async ({
    electronApp,
    page,
    panels,
  }) => {
    const { branchName, projectName, repoPath } =
      await addProjectAndCreateWorkspace(electronApp, page)

    const paneRegions = page.locator('[data-pane-id]')
    await expect(paneRegions.first()).toBeVisible({ timeout: 15_000 })

    await panels.switchToDashboard()

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText('1 project', { exact: true })).toBeVisible()

    const projectCard = getProjectDashboardCard(page, repoPath)
    await expect(projectCard).toHaveCount(1)
    await expect(
      projectCard.getByText(projectName, { exact: true })
    ).toBeVisible()
    await expect(projectCard.getByText(repoPath, { exact: true })).toBeVisible()
    await expect(
      projectCard.getByText(branchName, { exact: true })
    ).toBeVisible()

    await panels.switchToPanels()

    await expect(paneRegions.first()).toBeVisible({ timeout: 10_000 })
  })

  test('shows workspace status badges in the dashboard', async ({
    electronApp,
    page,
    panels,
  }) => {
    const { branchName, repoPath } = await addProjectAndCreateWorkspace(
      electronApp,
      page
    )

    await panels.switchToDashboard()

    const projectCard = getProjectDashboardCard(page, repoPath)
    await expect(projectCard).toHaveCount(1)

    // Wait for the VM/container to boot — this is the one test that
    // intentionally validates the container "running" status badge,
    // so it uses a longer timeout.
    const workspaceRow = projectCard
      .locator('div')
      .filter({
        has: page.getByText(branchName, { exact: true }),
        hasText: 'running',
      })
      .first()
    await expect(
      workspaceRow.getByText(branchName, { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(workspaceRow).toContainText('running')
  })
})
