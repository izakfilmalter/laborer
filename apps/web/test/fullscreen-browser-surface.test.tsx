/**
 * The browser surface is an Electron `<webview>` layer positioned over the
 * DOM, so it ignores stacking contexts: a background workspace's preview kept
 * painting as a black rectangle on top of a fullscreened terminal. Only the
 * right panel the fullscreen overlay owns may show its browser surface while a
 * pane is fullscreened.
 */

import type {
  PanelNode,
  WindowLayout,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: Array<() => void>) =>
    () => {
      for (const c of cleanups) {
        c()
      }
    },
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/reorder', () => ({
  reorder: vi.fn(),
}))

vi.mock('@/panels/panel-manager', () => ({
  PanelManager: ({ layout }: { layout: PanelNode | undefined }) => (
    <div data-layout={JSON.stringify(layout)} data-testid="panel-manager" />
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

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: ({
    workspaceId,
  }: {
    workspaceId: string | undefined
  }) => (
    <div data-testid="workspace-frame-header" data-workspace-id={workspaceId} />
  ),
}))

vi.mock('@laborer/ui/components/resizable', () => ({
  ResizableHandle: () => <div data-testid="resizable-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
}))

import { useRightPanelStore } from '@/right-panel-store'
import { PanelActionsProvider } from '../src/panels/panel-context'
import { PanelContent } from '../src/routes/-components/panel-content'

function mockActions() {
  return {
    assignTerminalToPane: vi.fn(),
    closePane: vi.fn(),
    closeTerminalPane: vi.fn(),
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    resizePane: vi.fn(),
    setActivePaneId: vi.fn(),
    showPanelTypePicker: vi.fn(),
    splitPane: vi.fn(),
    updatePaneType: vi.fn(),
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
    toggleFilesPane: vi.fn(() => false),
    addPanelTab: vi.fn(),
    addWorkspaceToCurrentTab: vi.fn(),
    addWindowTab: vi.fn(),
    closeWindowTab: vi.fn(),
    removePanelTab: vi.fn(),
    reorderPanelTabsDnd: vi.fn(),
    switchPanelTab: vi.fn(),
    switchPanelTabByIndex: vi.fn(),
    switchPanelTabRelative: vi.fn(),
    switchWindowTab: vi.fn(),
    switchWindowTabByIndex: vi.fn(),
    switchWindowTabRelative: vi.fn(),
    renameWindowTab: vi.fn(),
    reorderWindowTabsDnd: vi.fn(),
    windowLayout: undefined,
  }
}

const TWO_WORKSPACE_TILE: WorkspaceTileNode = {
  _tag: 'WorkspaceTileSplit',
  id: 'tile-root',
  direction: 'vertical',
  children: [
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-1',
      workspaceId: 'workspace-1',
      panelTabs: [
        {
          id: 'tab-1',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-1',
            paneType: 'terminal',
            terminalId: 'term-1',
            workspaceId: 'workspace-1',
          },
        },
      ],
      activePanelTabId: 'tab-1',
    },
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-2',
      workspaceId: 'workspace-2',
      panelTabs: [
        {
          id: 'tab-2',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-2',
            paneType: 'terminal',
            terminalId: 'term-2',
            workspaceId: 'workspace-2',
          },
        },
      ],
      activePanelTabId: 'tab-2',
    },
  ],
  sizes: [50, 50],
}

const WINDOW_LAYOUT: WindowLayout = {
  activeTabId: 'win-tab-1',
  tabs: [{ id: 'win-tab-1', workspaceLayout: TWO_WORKSPACE_TILE }],
}

function renderPanelContent(fullscreenPaneId: string | null) {
  render(
    <PanelActionsProvider
      activePaneId="pane-1"
      fullscreenPaneId={fullscreenPaneId}
      value={mockActions()}
    >
      <PanelContent
        activePaneId="pane-1"
        activeTabId={WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId={fullscreenPaneId}
        isReconciling={false}
        windowLayout={WINDOW_LAYOUT}
        windowTabs={WINDOW_LAYOUT.tabs}
      />
    </PanelActionsProvider>
  )
}

function previewVisibility(workspaceId: string) {
  return screen
    .getAllByTestId('preview-panel')
    .filter((node) => node.getAttribute('data-workspace-id') === workspaceId)
    .map((node) => node.getAttribute('data-visible'))
}

describe('Browser surface visibility during fullscreen', () => {
  afterEach(() => {
    cleanup()
    useRightPanelStore.setState({ byWorkspaceId: {} })
  })

  it('shows the browser surface when no pane is fullscreened', () => {
    useRightPanelStore.getState().openBrowser('workspace-2', 'preview-tab-2')

    renderPanelContent(null)

    expect(previewVisibility('workspace-2')).toEqual(['true'])
  })

  it('hides a background workspace browser surface while a pane is fullscreened', () => {
    useRightPanelStore.getState().openBrowser('workspace-2', 'preview-tab-2')

    renderPanelContent('pane-1')

    expect(previewVisibility('workspace-2')).toEqual(['false'])
  })

  it('keeps the fullscreened workspace browser surface visible', () => {
    useRightPanelStore.getState().openBrowser('workspace-1', 'preview-tab-1')

    renderPanelContent('pane-1')

    expect(previewVisibility('workspace-1')).toEqual(['true'])
  })
})
