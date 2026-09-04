/**
 * The right panel's workspace tab strip: every open workspace, filed under
 * its project, with a badge counting the surfaces each holds.
 */

import type { SharedProjectRow } from '@laborer/shared/rpc'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RightPanelProjectGroup } from '@/components/right-panel/right-panel-workspace-groups'
import { RightPanelWorkspaceTabs } from '@/components/right-panel/right-panel-workspace-tabs'
import type { WorkspaceView } from '@/db/shared-state'

const FEATURE_TAB = /feature/
const MAIN_TAB = /main/
const BETA_TAB = /Beta/

afterEach(cleanup)

function project(id: string, name: string): SharedProjectRow {
  return {
    id,
    name,
    rootPath: `/repos/${id}`,
    createdAt: 0,
  } as SharedProjectRow
}

function workspace(id: string, projectId: string): WorkspaceView {
  return {
    branchName: id,
    id,
    projectId,
    worktreePath: `/repos/${projectId}/${id}`,
  } as WorkspaceView
}

const GROUPS: readonly RightPanelProjectGroup[] = [
  {
    project: project('alpha', 'Alpha'),
    workspaces: [workspace('main', 'alpha'), workspace('feature', 'alpha')],
  },
  {
    project: project('beta', 'Beta'),
    workspaces: [workspace('trunk', 'beta')],
  },
]

function renderTabs(
  overrides: Partial<Parameters<typeof RightPanelWorkspaceTabs>[0]> = {}
) {
  const onSelectWorkspace = vi.fn()
  render(
    <RightPanelWorkspaceTabs
      groups={GROUPS}
      onSelectWorkspace={onSelectWorkspace}
      selectedWorkspaceId="main"
      surfaceCounts={{ main: 2, feature: 0, trunk: 3 }}
      {...overrides}
    />
  )
  return { onSelectWorkspace }
}

describe('RightPanelWorkspaceTabs', () => {
  it('renders each project followed by its workspaces', () => {
    renderTabs()

    const strip = screen.getByRole('tablist', { name: 'Open workspaces' })
    const labels = Array.from(strip.querySelectorAll('button')).map(
      (button) => button.textContent
    )

    expect(labels).toEqual(['Alpha', 'main2', 'feature', 'Beta', 'trunk3'])
  })

  it('badges only workspaces holding surfaces, never the project tab', () => {
    renderTabs({ surfaceCounts: { main: 2, feature: 0, trunk: 3 } })

    const [alpha, main, feature] = Array.from(
      screen
        .getByRole('tablist', { name: 'Open workspaces' })
        .querySelectorAll('button')
    )
    expect(alpha?.querySelector('[data-surface-count-badge]')).toBeNull()
    expect(main?.querySelector('[data-surface-count-badge]')?.textContent).toBe(
      '2'
    )
    expect(feature?.querySelector('[data-surface-count-badge]')).toBeNull()
  })

  it('marks the selected workspace tab', () => {
    renderTabs()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ])
    expect(tabs[0]?.getAttribute('data-active-tab')).toBe('true')
  })

  it('selects a workspace when its tab is clicked', () => {
    const { onSelectWorkspace } = renderTabs()

    fireEvent.click(screen.getByRole('tab', { name: FEATURE_TAB }))

    expect(onSelectWorkspace).toHaveBeenCalledWith('feature')
  })

  it('selects a project’s first workspace when the project tab is clicked', () => {
    const { onSelectWorkspace } = renderTabs()

    fireEvent.click(screen.getByRole('button', { name: BETA_TAB }))

    expect(onSelectWorkspace).toHaveBeenCalledWith('trunk')
  })

  it('moves selection with the arrow keys, across projects', () => {
    const { onSelectWorkspace } = renderTabs()

    fireEvent.keyDown(screen.getByRole('tab', { name: MAIN_TAB }), {
      key: 'ArrowRight',
    })
    expect(onSelectWorkspace).toHaveBeenCalledWith('feature')

    fireEvent.keyDown(screen.getByRole('tab', { name: MAIN_TAB }), {
      key: 'ArrowLeft',
    })
    expect(onSelectWorkspace).toHaveBeenCalledWith('trunk')

    fireEvent.keyDown(screen.getByRole('tab', { name: MAIN_TAB }), {
      key: 'End',
    })
    expect(onSelectWorkspace).toHaveBeenCalledWith('trunk')
  })
})
