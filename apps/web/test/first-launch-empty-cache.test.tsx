/**
 * Tests for first-launch empty cache handling.
 *
 * When the LiveStore OPFS cache is empty (first launch or cache cleared),
 * all tables are empty and the UI must render meaningful placeholder/onboarding
 * content instead of broken empty tables or plain text stubs.
 *
 * These tests verify that key views handle the empty-store scenario gracefully
 * and that data populates reactively when sync delivers events.
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

const {
  destroyFn,
  isElectronMock,
  mutationMap,
  queryDbMock,
  startLoopFn,
  useLaborerStoreMock,
} = vi.hoisted(() => ({
  destroyFn: vi.fn(),
  isElectronMock: vi.fn(() => false),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  queryDbMock: vi.fn((_table, options: { label: string }) => options),
  startLoopFn: vi.fn(),
  useLaborerStoreMock: vi.fn(),
}))

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

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
  useAtomValue: () => ({
    _tag: 'Success',
    value: { devServer: { autoOpen: { value: false } } },
  }),
}))

vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'] as const,
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.destroy') {
        mutationMap.set(sentinel, destroyFn)
      }
      if (name === 'brrr.startLoop') {
        mutationMap.set(sentinel, startLoopFn)
      }
      return sentinel
    },
    query: () => Symbol.for('query:stub'),
  },
}))

vi.mock('@livestore/livestore', () => ({
  queryDb: queryDbMock,
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: useLaborerStoreMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  prds: { name: 'prds' },
  workspaces: { name: 'workspaces' },
  tasks: { name: 'tasks' },
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
  },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => ({
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
  }),
}))

vi.mock('@/components/terminal-list', () => ({
  TerminalList: () => <div data-testid="terminal-list" />,
}))

vi.mock('@/components/review-pr-form', () => ({
  ReviewPrForm: () => null,
}))

vi.mock('@/components/fix-findings-form', () => ({
  FixFindingsForm: () => null,
}))

vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
}))

vi.mock('@/components/github-pr-status-badge', () => ({
  GitHubPrStatusBadge: () => null,
}))

vi.mock('@/components/review-verdict-badge', () => ({
  ReviewVerdictBadge: () => null,
}))

vi.mock('@/components/review-findings-count', () => ({
  ReviewFindingsCount: () => null,
  useUnresolvedFindingsCount: () => 0,
}))

vi.mock('@/components/plan-issues-list', () => ({
  PlanIssuesList: () => null,
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
  })

  // Tracer bullet: empty workspace list shows onboarding content
  it('workspace list shows onboarding content when store has no workspaces', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Should use the Empty component pattern — not just plain "No workspaces" text
    const emptySlot = screen.getByText('No workspaces')
    expect(emptySlot).toBeTruthy()
    // The Empty component pattern uses data-slot="empty" on the container
    expect(emptySlot.closest('[data-slot="empty"]')).toBeTruthy()
  })

  it('workspace list shows guidance description in empty state', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Should have a description guiding the user to create their first workspace
    expect(screen.getByText(CREATE_WORKSPACE_PATTERN)).toBeTruthy()
  })

  it('workspace list updates reactively when data arrives via sync', () => {
    // Start with empty store (simulating first launch)
    let workspaceData: Record<string, unknown>[] = []

    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return workspaceData
        }
        return []
      },
    })

    const { rerender } = render(
      <WorkspaceList projectId="project-1" repoPath="/repo" />
    )

    // Initially shows empty state
    expect(screen.getByText('No workspaces')).toBeTruthy()
    expect(
      screen.getByText('No workspaces').closest('[data-slot="empty"]')
    ).toBeTruthy()

    // Simulate data arriving via sync — LiveStore reactivity re-renders
    workspaceData = [
      {
        id: 'ws-1',
        projectId: 'project-1',
        branchName: 'feature/first',
        worktreePath: '/repo/worktrees/feature-first',
        port: 3001,
        status: 'running',
        origin: 'manual',
        createdAt: '2026-03-14T00:00:00.000Z',
        taskSource: null,
        containerId: null,
        containerUrl: null,
        containerStatus: null,
        containerSetupStep: null,
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

  it('no console errors or rendering crashes with empty store', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(vi.fn())
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn())

    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

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
