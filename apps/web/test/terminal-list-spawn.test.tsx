/**
 * Tests for the TerminalSpawnControls spawn button behavior.
 *
 * Verifies that the "Agent" and "New" (terminal) buttons in the sidebar
 * workspace card split the active pane instead of creating new tabs:
 * - Default click → split right (horizontal)
 * - Cmd+click → split down (vertical)
 * - No active pane → falls back to addPanelTab
 *
 * @see apps/web/src/components/terminal-list.tsx
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mutable refs — shared between vi.mock factories and test body
// ---------------------------------------------------------------------------

const {
  activePaneIdRef,
  activeWorkspaceIdRef,
  addPanelTabMock,
  splitPaneMock,
} = vi.hoisted(() => ({
  activePaneIdRef: { current: null as string | null },
  activeWorkspaceIdRef: { current: null as string | null },
  addPanelTabMock: vi.fn(),
  splitPaneMock: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks — must be declared before component import
// ---------------------------------------------------------------------------

// Panel context — expose splitPane and addPanelTab as spies
vi.mock('@/panels/panel-context', () => ({
  useActivePaneId: () => activePaneIdRef.current,
  useActiveWorkspaceId: () => activeWorkspaceIdRef.current,
  usePanelActions: () => ({
    assignTerminalToPane: vi.fn(),
    closePane: vi.fn(),
    closeTerminalPane: vi.fn(),
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    resizePane: vi.fn(),
    setActivePaneId: vi.fn(),
    showPanelTypePicker: vi.fn(),
    splitPane: splitPaneMock,
    toggleDevServerPane: vi.fn(),
    toggleDiffPane: vi.fn(),
    toggleFullscreenPane: vi.fn(),
    addPanelTab: addPanelTabMock,
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
  }),
}))

// Terminal list hook — service available with no terminals
vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({
    terminals: [],
    refresh: vi.fn(async () => []),
    errorMessage: null,
    isServiceAvailable: true,
    isLoading: false,
    serviceStatus: 'available' as const,
  }),
  upsertTerminalListItem: vi.fn(),
}))

// Atom hooks — stub the Effect atom hooks
vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: () =>
    vi.fn(async () => ({
      id: 'mock-terminal',
      command: '/bin/zsh',
      status: 'running',
      workspaceId: 'ws-1',
    })),
  useAtomValue: () => ({
    _tag: 'Success',
    value: { agent: { value: 'opencode2' } },
  }),
}))

// Laborer client
vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'] as const,
  LaborerClient: {
    mutation: () => Symbol.for('mutation:stub'),
    query: () => Symbol.for('query:stub'),
  },
}))

// Terminal service client
vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: {
    mutation: () => Symbol.for('mutation:stub'),
  },
}))

// Lifecycle phase — always report Ready so buttons are enabled
vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/components/lifecycle-phase-context', () => ({
  LifecyclePhase: { Ready: 'ready' },
}))

// Toast
vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
  },
}))

// Agent icons
vi.mock('@/components/agent-icons', () => ({
  AGENT_ICONS: {
    opencode2: ({ className }: { className?: string }) => (
      <span className={className} data-testid="agent-icon" />
    ),
  },
}))

// Tooltip — stub the portal-based tooltip so the trigger renders its content
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

// Workspace agent status
vi.mock('@/lib/workspace-agent-status', () => ({
  deriveWorkspaceAgentStatus: () => null,
}))

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { TerminalSpawnControls } from '../src/components/terminal-list'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  activePaneIdRef.current = null
  activeWorkspaceIdRef.current = null
})

describe('TerminalSpawnControls', () => {
  describe('with an active pane in the SAME workspace', () => {
    beforeEach(() => {
      activePaneIdRef.current = 'pane-1'
      activeWorkspaceIdRef.current = 'ws-1'
    })

    it('clicking Agent button splits right from the active pane', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const agentButton = screen.getByRole('button', {
        name: 'Start opencode2 agent',
      })
      fireEvent.click(agentButton)

      expect(splitPaneMock).toHaveBeenCalledWith(
        'pane-1',
        'horizontal',
        expect.objectContaining({
          paneType: 'agent',
          workspaceId: 'ws-1',
        })
      )
      expect(addPanelTabMock).not.toHaveBeenCalled()
    })

    it('Cmd+clicking Agent button splits down from the active pane', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const agentButton = screen.getByRole('button', {
        name: 'Start opencode2 agent',
      })
      fireEvent.click(agentButton, { metaKey: true })

      expect(splitPaneMock).toHaveBeenCalledWith(
        'pane-1',
        'vertical',
        expect.objectContaining({
          paneType: 'agent',
          workspaceId: 'ws-1',
        })
      )
      expect(addPanelTabMock).not.toHaveBeenCalled()
    })

    it('clicking New terminal button splits right from the active pane', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const terminalButton = screen.getByRole('button', {
        name: 'New terminal',
      })
      fireEvent.click(terminalButton)

      expect(splitPaneMock).toHaveBeenCalledWith(
        'pane-1',
        'horizontal',
        expect.objectContaining({
          paneType: 'terminal',
          workspaceId: 'ws-1',
        })
      )
      expect(addPanelTabMock).not.toHaveBeenCalled()
    })

    it('Cmd+clicking New terminal button splits down from the active pane', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const terminalButton = screen.getByRole('button', {
        name: 'New terminal',
      })
      fireEvent.click(terminalButton, { metaKey: true })

      expect(splitPaneMock).toHaveBeenCalledWith(
        'pane-1',
        'vertical',
        expect.objectContaining({
          paneType: 'terminal',
          workspaceId: 'ws-1',
        })
      )
      expect(addPanelTabMock).not.toHaveBeenCalled()
    })
  })

  describe('with an active pane in a DIFFERENT workspace', () => {
    beforeEach(() => {
      // The active pane belongs to ws-other, but we'll render the controls
      // for ws-1. The spawn should NOT split the other workspace's pane.
      activePaneIdRef.current = 'pane-other'
      activeWorkspaceIdRef.current = 'ws-other'
    })

    it('clicking New terminal button calls addPanelTab for the target workspace', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const terminalButton = screen.getByRole('button', {
        name: 'New terminal',
      })
      fireEvent.click(terminalButton)

      // Should NOT split the other workspace's pane
      expect(splitPaneMock).not.toHaveBeenCalled()
      // Should create a new panel tab in the correct workspace
      expect(addPanelTabMock).toHaveBeenCalledWith('ws-1', 'terminal')
    })

    it('clicking Agent button calls addPanelTab for the target workspace', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const agentButton = screen.getByRole('button', {
        name: 'Start opencode2 agent',
      })
      fireEvent.click(agentButton)

      // Should NOT split the other workspace's pane
      expect(splitPaneMock).not.toHaveBeenCalled()
      // Should create a new panel tab in the correct workspace
      expect(addPanelTabMock).toHaveBeenCalledWith('ws-1', 'agent')
    })

    it('Cmd+clicking New terminal button calls addPanelTab (not split) for different workspace', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const terminalButton = screen.getByRole('button', {
        name: 'New terminal',
      })
      fireEvent.click(terminalButton, { metaKey: true })

      // Even with Cmd+click, should NOT split the other workspace's pane
      expect(splitPaneMock).not.toHaveBeenCalled()
      expect(addPanelTabMock).toHaveBeenCalledWith('ws-1', 'terminal')
    })
  })

  describe('without an active pane', () => {
    beforeEach(() => {
      activePaneIdRef.current = null
    })

    it('clicking Agent button falls back to addPanelTab', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const agentButton = screen.getByRole('button', {
        name: 'Start opencode2 agent',
      })
      fireEvent.click(agentButton)

      expect(addPanelTabMock).toHaveBeenCalledWith('ws-1', 'agent')
      expect(splitPaneMock).not.toHaveBeenCalled()
    })

    it('clicking New terminal button falls back to addPanelTab', () => {
      render(<TerminalSpawnControls projectId="proj-1" workspaceId="ws-1" />)

      const terminalButton = screen.getByRole('button', {
        name: 'New terminal',
      })
      fireEvent.click(terminalButton)

      expect(addPanelTabMock).toHaveBeenCalledWith('ws-1', 'terminal')
      expect(splitPaneMock).not.toHaveBeenCalled()
    })
  })
})
