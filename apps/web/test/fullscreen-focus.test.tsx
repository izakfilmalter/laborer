/**
 * Tests for focus retention across fullscreen transitions.
 *
 * Toggling fullscreen (Cmd+Shift+Enter / Ctrl+b z) moves the pane between
 * the normal panel tree and the fullscreen portal. React replaces the pane's
 * DOM subtree when the portal target changes, and the browser drops focus to
 * `document.body` as soon as the focused node leaves the document.
 *
 * The active pane must therefore re-claim DOM focus after the transition so
 * the user can keep typing into the terminal without clicking it again.
 */

import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (declared before imports of the modules under test) ---

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomValue: () => ({ _tag: 'Success', value: [] }),
  useAtomSet: () => vi.fn(),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: vi.fn(() => Symbol('mutation')),
  },
}))

vi.mock('@laborer/ui/components/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
}))

vi.mock('@/panels/panel-group-registry', () => ({
  usePanelGroupRegistry: () => null,
}))

/**
 * Stands in for the real terminal pane. xterm.js renders a helper textarea
 * that owns keyboard input, so the mock exposes one too — that element is
 * what focus must land on.
 */
vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-pane-type="terminal">
      <textarea
        aria-label={`terminal ${terminalId}`}
        data-testid={`terminal-input-${terminalId}`}
      />
    </div>
  ),
}))

vi.mock('@/panes/dev-server-terminal-pane', () => ({
  DevServerTerminalPane: () => <div data-testid="dev-server-terminal" />,
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: () => <div data-testid="diff-pane" />,
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

vi.mock('@laborer/ui/lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/errors', () => ({
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
 * Renders the split layout with a live fullscreen portal target and exposes
 * a toggle that mirrors what `toggleFullscreenPane` does in the route.
 */
function TestHarness() {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null)
  const actions = mockActions()

  return (
    <PanelActionsProvider
      activePaneId="pane-1"
      fullscreenPaneId={fullscreenPaneId}
      value={actions}
    >
      <FullscreenPortalContext.Provider value={portalElement}>
        <button
          data-testid="toggle-fullscreen"
          onClick={() =>
            setFullscreenPaneId((current) => (current ? null : 'pane-1'))
          }
          type="button"
        >
          toggle
        </button>
        <div data-testid="normal-tree">
          <PanelManager layout={SPLIT_LAYOUT} />
        </div>
        <div data-testid="fullscreen-container" ref={setPortalElement} />
      </FullscreenPortalContext.Provider>
    </PanelActionsProvider>
  )
}

// --- Tests ---

describe('Fullscreen focus retention', () => {
  afterEach(() => {
    cleanup()
  })

  /** Clicks the harness toggle inside `act` so effects flush. */
  function toggleFullscreen() {
    act(() => {
      screen.getByTestId('toggle-fullscreen').click()
    })
  }

  it('keeps focus on the active terminal when entering fullscreen', () => {
    render(<TestHarness />)

    expect(document.activeElement).toBe(
      screen.getByTestId('terminal-input-term-1')
    )

    toggleFullscreen()

    const portalContainer = screen.getByTestId('fullscreen-container')
    const terminalInput = screen.getByTestId('terminal-input-term-1')

    expect(portalContainer.contains(terminalInput)).toBe(true)
    expect(document.activeElement).toBe(terminalInput)
  })

  it('keeps focus on the active terminal when exiting fullscreen', () => {
    render(<TestHarness />)

    toggleFullscreen()
    toggleFullscreen()

    const normalTree = screen.getByTestId('normal-tree')
    const terminalInput = screen.getByTestId('terminal-input-term-1')

    expect(normalTree.contains(terminalInput)).toBe(true)
    expect(document.activeElement).toBe(terminalInput)
  })

  it('does not move focus to a sibling pane during fullscreen transitions', () => {
    render(<TestHarness />)

    toggleFullscreen()

    expect(document.activeElement).not.toBe(
      screen.getByTestId('terminal-input-term-2')
    )
  })
})
