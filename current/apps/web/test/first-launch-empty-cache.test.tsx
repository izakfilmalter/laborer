/**
 * Tests for first-launch empty shared-state handling.
 *
 * When the authoritative task snapshot is empty, all views must render
 * meaningful placeholder/onboarding
 * content instead of broken empty tables or plain text stubs.
 *
 * These tests verify that key views handle the empty-store scenario gracefully
 * and that data populates reactively when the server stream delivers updates.
 *
 * @see Issue #3: First-launch empty cache handling
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Pattern to match "create" + "workspace" in description text. */
const CREATE_WORKSPACE_PATTERN = /create.*workspace/i

// ---------------------------------------------------------------------------
// Hoisted mocks — WorkspaceList
// ---------------------------------------------------------------------------

const { destroyFn, isElectronMock, mutationMap, workspaceRowsRef } = vi.hoisted(
  () => ({
    destroyFn: vi.fn(),
    isElectronMock: vi.fn(() => false),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    workspaceRowsRef: { current: [] as Record<string, unknown>[] },
  })
)

vi.mock('@/lib/desktop', () => ({
  isElectron: isElectronMock,
  openExternalUrl: vi.fn(async () => true),
  terminalRpcUrl: () => 'http://localhost:2101',
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({
    terminals: [],
    refresh: vi.fn(async () => []),
    errorMessage: null,
    isServiceAvailable: true,
    isLoading: false,
    serviceStatus: 'available' as const,
  }),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
  useAtomValue: (atom: symbol) =>
    atom === Symbol.for('workspaceViews')
      ? workspaceRowsRef.current
      : { _tag: 'Success', value: {} },
}))

vi.mock('@/atoms/shared-state', () => ({
  clearWorkspaceDestroyOverlayAtom: Symbol.for('clearWorkspaceDestroyOverlay'),
  installWorkspaceDestroyOverlayAtom: Symbol.for(
    'installWorkspaceDestroyOverlay'
  ),
  workspaceViewsAtom: Symbol.for('workspaceViews'),
}))

vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'] as const,
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.destroy') {
        mutationMap.set(sentinel, destroyFn)
      }
      return sentinel
    },
    query: () => Symbol.for('query:stub'),
  },
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
  },
}))

vi.mock('@/panels/panel-context', () => ({
  useActiveWorkspaceId: () => null,
  usePanelActions: () => ({
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
  }),
}))

vi.mock('@/components/terminal-list', () => ({
  TerminalList: () => <div data-testid="terminal-list" />,
  TerminalSpawnControls: () => <div data-testid="terminal-spawn-controls" />,
}))

vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
}))

vi.mock('@/components/github-pr-status-badge', () => ({
  GitHubPrStatusBadge: () => null,
}))

vi.mock('@/hooks/use-destroy-workspace-checks', () => ({
  useDestroyWorkspaceChecks: () => ({
    activeTerminals: [],
    dirtyFiles: [],
    isCheckingDirtyFiles: false,
    isCheckingTerminals: false,
    reset: vi.fn(),
    startChecks: vi.fn(),
  }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTrigger: ({ render }: { render: React.ReactElement }) => render,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/components/workspace-sync-status', () => ({
  WorkspaceSyncStatus: () => null,
}))

import { WorkspaceList } from '../src/components/workspace-list'

describe('First-launch empty cache handling', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    workspaceRowsRef.current = []
  })

  // Tracer bullet: empty workspace list shows onboarding content
  it('workspace list shows onboarding content when snapshot has no workspaces', () => {
    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Should use the Empty component pattern — not just plain "No workspaces" text
    const emptySlot = screen.getByText('No workspaces')
    expect(emptySlot).toBeTruthy()
    // The Empty component pattern uses data-slot="empty" on the container
    expect(emptySlot.closest('[data-slot="empty"]')).toBeTruthy()
  })

  it('workspace list shows guidance description in empty state', () => {
    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Should have a description guiding the user to create their first workspace
    expect(screen.getByText(CREATE_WORKSPACE_PATTERN)).toBeTruthy()
  })

  it('workspace list updates reactively when data arrives via sync', () => {
    // Start with an empty snapshot (simulating first launch)
    const { rerender } = render(
      <WorkspaceList projectId="project-1" repoPath="/repo" />
    )

    // Initially shows empty state
    expect(screen.getByText('No workspaces')).toBeTruthy()
    expect(
      screen.getByText('No workspaces').closest('[data-slot="empty"]')
    ).toBeTruthy()

    // Simulate data arriving via the authoritative server stream.
    workspaceRowsRef.current = [
      {
        id: 'ws-1',
        projectId: 'project-1',
        branchName: 'feature/first',
        worktreePath: '/repo/worktrees/feature-first',
        status: 'running',
        origin: 'manual',
        createdAt: '2026-03-14T00:00:00.000Z',
        taskSource: null,
        worktreeSetupStep: null,
        prNumber: null,
        prUrl: null,
        prTitle: null,
        prState: null,
        aheadCount: null,
        behindCount: null,
      },
    ]

    rerender(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Empty state should be gone, workspace card should be visible
    expect(screen.queryByText('No workspaces')).toBeNull()
    expect(screen.getAllByText('feature/first').length).toBeGreaterThan(0)
  })

  it('no console errors or rendering crashes with an empty snapshot', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(vi.fn())
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn())

    // Should not throw during render
    expect(() => {
      render(<WorkspaceList projectId="project-1" repoPath="/repo" />)
    }).not.toThrow()

    // Should not produce console errors
    expect(consoleErrorSpy).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })
})
