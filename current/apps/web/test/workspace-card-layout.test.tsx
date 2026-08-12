/**
 * Tests for the reorganized workspace card layout.
 *
 * Row 1 (Git): branch name + PR badge
 *
 * Row 2: workspace status
 *
 * @see Issue: Reorganize workspace actions
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { destroyFn, mutationMap, workspaceRowsRef } = vi.hoisted(() => ({
  destroyFn: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  workspaceRowsRef: { current: [] as unknown[] },
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

vi.mock('sonner', () => ({
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
}))

vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
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
    <div>{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTrigger: ({ render }: { render: React.ReactElement }) => render,
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
  AlertDialogAction: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

// Import after mocks
import { WorkspaceList } from '../src/components/workspace-list'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REVIEW_PR_RE = /review pr/i
const FIX_FINDINGS_RE = /fix findings/i
const DESTROY_WORKSPACE_RE = /destroy workspace/i

const makeWorkspace = (
  overrides: Partial<{
    id: string
    projectId: string
    branchName: string
    worktreePath: string
    status: string
    origin: string
    createdAt: string
    taskSource: string | null
    worktreeSetupStep: string | null
    prNumber: number | null
    prUrl: string | null
    prTitle: string | null
    prState: string | null
  }> = {}
) => ({
  id: 'ws-1',
  projectId: 'project-1',
  branchName: 'feature/my-feature',
  worktreePath: '/path/to/worktree',
  status: 'running',
  origin: 'laborer',
  createdAt: new Date().toISOString(),
  taskSource: null,
  worktreeSetupStep: null,
  prNumber: null,
  prUrl: null,
  prTitle: null,
  prState: null,
  ...overrides,
})

const mockStore = (workspaces: unknown[]) => {
  workspaceRowsRef.current = workspaces
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workspace card layout — Row 1 (Git row)', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not render removed review actions when workspace has a PR', () => {
    mockStore([
      makeWorkspace({
        prNumber: 42,
        prState: 'OPEN',
        prTitle: 'Add feature',
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.queryByRole('button', { name: REVIEW_PR_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: FIX_FINDINGS_RE })).toBeNull()
  })
})

describe('Workspace card layout — status row', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the workspace status badge', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('running')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })
})
