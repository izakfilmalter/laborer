/**
 * SidebarHelper — Convenience methods for sidebar interactions.
 *
 * Provides locator-based helpers for searching, finding projects/workspaces,
 * and collapsing/expanding groups in the sidebar.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import type { Locator, Page } from '@playwright/test'

export class SidebarHelper {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Get the sidebar search input. */
  get searchInput(): Locator {
    return this.page.getByLabel('Search projects and workspaces')
  }

  /** Get the clear-search button that appears while a query is active. */
  get clearSearchButton(): Locator {
    return this.page.getByRole('button', { name: 'Clear search' })
  }

  /** Type a search query into the sidebar search box. */
  async search(query: string): Promise<void> {
    await this.searchInput.fill(query)
  }

  /** Clear the sidebar search. */
  async clearSearch(): Promise<void> {
    await this.clearSearchButton.click()
  }

  /** Get a project group by project name. */
  getProjectByName(name: string): Locator {
    return this.page.getByRole('button', { name })
  }

  /** Get the "Projects" heading in the sidebar. */
  get projectsHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Projects' })
  }

  /** Get the add-project form area. */
  get addProjectForm(): Locator {
    return this.page.locator('[data-testid="add-project-form"]')
  }

  /** Get the server status section. */
  get serverStatus(): Locator {
    return this.page.getByRole('heading', { name: 'Server Status' })
  }
}
