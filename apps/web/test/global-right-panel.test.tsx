/**
 * The window hosts one right panel. It renders a single instance for the
 * workspace the store resolves to: the focused workspace by default, or an
 * explicitly selected one until focus moves again.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="diff-pane" data-workspace-id={workspaceId} />
  ),
}))

vi.mock('@/components/preview/preview-panel', () => ({
  PreviewPanel: ({
    visible,
    workspaceId,
  }: {
    visible: boolean
    workspaceId: string
  }) => (
    <div
      data-testid="preview-panel"
      data-visible={visible ? 'true' : 'false'}
      data-workspace-id={workspaceId}
    />
  ),
}))

import { GlobalRightPanel } from '@/components/right-panel/global-right-panel'
import { useRightPanelStore } from '@/right-panel-store'

const OPEN_WORKSPACE_IDS = ['workspace-1', 'workspace-2'] as const

function panels() {
  return Array.from(document.querySelectorAll('[data-right-panel]'))
}

function panelWorkspaceIds() {
  return panels().map((panel) => panel.getAttribute('data-workspace-id'))
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  useRightPanelStore.setState({
    byWorkspaceId: {},
    isOpen: false,
    selectedWorkspaceId: null,
  })
})

describe('GlobalRightPanel', () => {
  it('renders nothing while the panel is closed', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')
    useRightPanelStore.getState().close()

    render(
      <GlobalRightPanel
        activeWorkspaceId="workspace-1"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )

    expect(panels()).toHaveLength(0)
  })

  it('renders nothing when the window tab has no workspaces', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')

    render(<GlobalRightPanel activeWorkspaceId={null} openWorkspaceIds={[]} />)

    expect(panels()).toHaveLength(0)
  })

  it('renders exactly one panel, for the focused workspace', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')
    useRightPanelStore.getState().open('workspace-2', 'diff')

    render(
      <GlobalRightPanel
        activeWorkspaceId="workspace-2"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )

    expect(panelWorkspaceIds()).toEqual(['workspace-2'])
    expect(
      screen
        .getAllByTestId('diff-pane')
        .map((node) => node.getAttribute('data-workspace-id'))
    ).toEqual(['workspace-2'])
  })

  it('follows focus when the active workspace changes', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')
    useRightPanelStore.getState().open('workspace-2', 'diff')

    const view = render(
      <GlobalRightPanel
        activeWorkspaceId="workspace-1"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )
    expect(panelWorkspaceIds()).toEqual(['workspace-1'])

    view.rerender(
      <GlobalRightPanel
        activeWorkspaceId="workspace-2"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )

    expect(panelWorkspaceIds()).toEqual(['workspace-2'])
    expect(useRightPanelStore.getState().selectedWorkspaceId).toBe(
      'workspace-2'
    )
  })

  it('keeps an explicit selection until focus moves again', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')
    useRightPanelStore.getState().open('workspace-2', 'diff')

    const view = render(
      <GlobalRightPanel
        activeWorkspaceId="workspace-1"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )
    expect(panelWorkspaceIds()).toEqual(['workspace-1'])

    // Standing in for the T3 workspace tab strip: an explicit pick while
    // focus stays where it is.
    useRightPanelStore.getState().selectWorkspace('workspace-2')
    view.rerender(
      <GlobalRightPanel
        activeWorkspaceId="workspace-1"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )

    expect(panelWorkspaceIds()).toEqual(['workspace-2'])
  })

  it('falls back to an open workspace when the selection closes', () => {
    useRightPanelStore.getState().open('workspace-2', 'diff')

    render(
      <GlobalRightPanel
        activeWorkspaceId={null}
        openWorkspaceIds={['workspace-1']}
      />
    )

    expect(panelWorkspaceIds()).toEqual(['workspace-1'])
  })

  it('keeps the browser surface visible: the panel is never under the fullscreen overlay', () => {
    useRightPanelStore.getState().openBrowser('workspace-1', 'preview-tab-1')

    render(
      <GlobalRightPanel
        activeWorkspaceId="workspace-1"
        openWorkspaceIds={OPEN_WORKSPACE_IDS}
      />
    )

    const previews = screen.getAllByTestId('preview-panel')
    expect(previews).toHaveLength(1)
    expect(previews[0]?.getAttribute('data-visible')).toBe('true')
  })
})
