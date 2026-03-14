/**
 * Tests for the fullscreen portal behavior.
 *
 * When a pane is fullscreened, its content should be portaled into a
 * separate container that sits above the panel hierarchy — leaving all
 * sibling terminals mounted and untouched in their original DOM positions.
 *
 * Previously, fullscreen mode unmounted all non-fullscreened workspaces
 * and re-rendered the tree from scratch on exit. This caused terminals
 * to remount with stale dimensions (fitAddon.fit() ran before
 * react-resizable-panels finished computing layout sizes).
 *
 * The portal approach avoids this: siblings never unmount, never change
 * size, and need no re-fit on fullscreen exit.
 */

import type { LeafNode, PanelNode, SplitNode } from '@laborer/shared/types'
import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (declared before imports of the modules under test) ---

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: () => ({ _tag: 'Success', value: [] }),
  useAtomSet: () => vi.fn(),
}))

vi.mock('@livestore/livestore', () => ({
  queryDb: vi.fn(() => ({ table: 'mock' })),
}))

vi.mock('@laborer/shared/schema', () => ({
  workspaces: { table: 'workspaces' },
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: () => ({
    useQuery: () => [],
    query: () => [],
    commit: vi.fn(),
  }),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: vi.fn(() => Symbol('mutation')),
  },
}))

vi.mock('@/components/terminal-overlay-toolbar', () => ({
  TerminalOverlayToolbar: () => null,
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizablePanelGroup: ({
    children,
    orientation,
  }: {
    children: React.ReactNode
    orientation?: string
  }) => (
    <div data-orientation={orientation} data-testid="resizable-panel-group">
      {children}
    </div>
  ),
}))

vi.mock('@/panels/panel-group-registry', () => ({
  usePanelGroupRegistry: () => null,
}))

vi.mock('@/panels/terminal-pane-with-sidebars', () => ({
  TerminalPaneWithSidebars: ({ node }: { node: LeafNode }) => (
    <div data-pane-type="terminal" data-testid={`terminal-${node.id}`}>
      terminal:{node.terminalId}
    </div>
  ),
}))

vi.mock('@/panes/dev-server-terminal-pane', () => ({
  DevServerTerminalPane: () => <div data-testid="dev-server-terminal" />,
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: () => <div data-testid="diff-pane" />,
}))

vi.mock('@/panes/review-pane', () => ({
  ReviewPane: () => <div data-testid="review-pane" />,
}))

vi.mock('@/routes/-components/close-dialogs', () => ({
  PaneCloseConfirmDialog: () => null,
}))

vi.mock('@/hooks/use-responsive-layout', () => ({
  useResponsiveLayout: () => ({ paneMin: '10%' }),
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
  extractErrorMessage: (e: unknown) => String(e),
}))

// --- Import after mocks ---

import {
  FullscreenPortalContext,
  PanelActionsProvider,
} from '../src/panels/panel-context'
import { PanelManager } from '../src/panels/panel-manager'

// --- Test helpers ---

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
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
    toggleReviewPane: vi.fn(() => false),
    addPanelTab: vi.fn(),
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
    reorderWindowTabsDnd: vi.fn(),
    windowLayout: undefined,
  }
}

const LEAF_1: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-1',
  paneType: 'terminal',
  terminalId: 'term-1',
  workspaceId: 'ws-1',
}

const LEAF_2: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-2',
  paneType: 'terminal',
  terminalId: 'term-2',
  workspaceId: 'ws-1',
}

const SPLIT_LAYOUT: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [LEAF_1, LEAF_2],
  sizes: [50, 50],
}

/**
 * Wrapper component that provides a fullscreen portal target via
 * useState + callback ref. This ensures the portal element exists
 * before PanelManager renders (React processes children after the
 * parent's effects, and useState triggers a re-render once the
 * callback ref sets the element).
 */
function TestHarness({
  layout,
  fullscreenPaneId = null,
}: {
  readonly layout: PanelNode
  readonly fullscreenPaneId?: string | null
}) {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)
  const actions = mockActions()

  return (
    <PanelActionsProvider
      activePaneId="pane-1"
      fullscreenPaneId={fullscreenPaneId}
      value={actions}
    >
      <FullscreenPortalContext.Provider value={portalElement}>
        <div data-testid="normal-tree">
          <PanelManager layout={layout} />
        </div>
        <div data-testid="fullscreen-container" ref={setPortalElement} />
      </FullscreenPortalContext.Provider>
    </PanelActionsProvider>
  )
}

// --- Tests ---

describe('Fullscreen portal behavior', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders all panes in the normal tree when no pane is fullscreened', () => {
    render(<TestHarness layout={SPLIT_LAYOUT} />)

    const normalTree = screen.getByTestId('normal-tree')
    const pane1 = screen.getByTestId('terminal-pane-1')
    const pane2 = screen.getByTestId('terminal-pane-2')

    // Both terminals are inside the normal tree
    expect(normalTree.contains(pane1)).toBe(true)
    expect(normalTree.contains(pane2)).toBe(true)

    // Fullscreen container is empty
    const portalContainer = screen.getByTestId('fullscreen-container')
    expect(portalContainer.children).toHaveLength(0)
  })

  it('portals the fullscreened pane into the fullscreen container', () => {
    render(<TestHarness fullscreenPaneId="pane-1" layout={SPLIT_LAYOUT} />)

    const portalContainer = screen.getByTestId('fullscreen-container')
    const pane1 = screen.getByTestId('terminal-pane-1')

    // The fullscreened pane renders inside the portal container
    expect(portalContainer.contains(pane1)).toBe(true)
  })

  it('keeps sibling panes mounted in the normal tree during fullscreen', () => {
    render(<TestHarness fullscreenPaneId="pane-1" layout={SPLIT_LAYOUT} />)

    const normalTree = screen.getByTestId('normal-tree')
    const pane2 = screen.getByTestId('terminal-pane-2')

    // The non-fullscreened sibling stays in the normal tree
    expect(normalTree.contains(pane2)).toBe(true)
  })

  it('returns the pane to the normal tree when fullscreen exits', () => {
    const { rerender } = render(
      <TestHarness fullscreenPaneId="pane-1" layout={SPLIT_LAYOUT} />
    )

    // Verify pane-1 is in the portal
    const portalContainer = screen.getByTestId('fullscreen-container')
    expect(
      portalContainer.contains(screen.getByTestId('terminal-pane-1'))
    ).toBe(true)

    // Exit fullscreen by re-rendering with null
    rerender(<TestHarness fullscreenPaneId={null} layout={SPLIT_LAYOUT} />)

    const normalTree = screen.getByTestId('normal-tree')
    const pane1 = screen.getByTestId('terminal-pane-1')
    const pane2 = screen.getByTestId('terminal-pane-2')

    // Both panes are back in the normal tree
    expect(normalTree.contains(pane1)).toBe(true)
    expect(normalTree.contains(pane2)).toBe(true)

    // Portal container is empty
    const portalAfter = screen.getByTestId('fullscreen-container')
    expect(portalAfter.children).toHaveLength(0)
  })

  it('works with a single-pane layout (no siblings to worry about)', () => {
    render(<TestHarness fullscreenPaneId="pane-1" layout={LEAF_1} />)

    const portalContainer = screen.getByTestId('fullscreen-container')
    const pane1 = screen.getByTestId('terminal-pane-1')

    expect(portalContainer.contains(pane1)).toBe(true)
  })
})
