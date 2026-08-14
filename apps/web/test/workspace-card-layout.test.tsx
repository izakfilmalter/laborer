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

const { destroyFn, mutationMap, tasksByIdRef, workspaceRowsRef } = vi.hoisted(
  () => ({
    destroyFn: vi.fn(),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    tasksByIdRef: { current: new Map<string, unknown>() },
    workspaceRowsRef: { current: [] as unknown[] },
  })
)

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
    (() => {
      if (atom === Symbol.for('workspaceViews')) {
        return workspaceRowsRef.current
      }
      if (atom === Symbol.for('tasksById')) {
        return tasksByIdRef.current
      }
      return { _tag: 'Success', value: {} }
    })(),
}))

vi.mock('@/atoms/shared-state', () => ({
  clearWorkspaceDestroyOverlayAtom: Symbol.for('clearWorkspaceDestroyOverlay'),
  installWorkspaceDestroyOverlayAtom: Symbol.for(
    'installWorkspaceDestroyOverlay'
  ),
  clearTaskEditOverlayAtom: Symbol.for('clearTaskEditOverlay'),
  installTaskEditOverlayAtom: Symbol.for('installTaskEditOverlay'),
  // The card looks its task up here to offer the "Edit card" button; these
  // fixtures have no tasks, so every card is a workspace without one.
  tasksByIdAtom: Symbol.for('tasksById'),
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
  TerminalSpawnControls: () => <div data-testid="terminal-spawn-controls" />,
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

import { showsWorkspaceCardAgentStatus } from '../src/components/workspace-card'
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
    prBaseBranch: string | null
    prCheckStatus: 'pending' | 'success' | 'failure' | null
    prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
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
  prBaseBranch: null,
  prCheckStatus: null,
  prMergeStatus: null,
  prUrl: null,
  prTitle: null,
  prState: null,
  ...overrides,
})

const mockStore = (workspaces: unknown[]) => {
  workspaceRowsRef.current = workspaces
}

/**
 * A non-root workspace is projected from the task that owns its worktree, so
 * the two share an id — which is how the card finds the card to edit.
 */
const mockTask = (workspaceId: string) => {
  tasksByIdRef.current = new Map([
    [
      workspaceId,
      {
        branchName: 'feature/my-feature',
        createdAt: Date.now(),
        description: null,
        executionStatus: null,
        id: workspaceId,
        parentTaskId: null,
        prNumber: null,
        prState: null,
        prTitle: null,
        prUrl: null,
        revision: 1,
        slackPermalink: null,
        sortOrder: null,
        source: 'manual',
        status: 'in_progress',
        title: 'Add feature',
        updatedAt: Date.now(),
        worktreeExists: true,
        worktreePath: '/path/to/worktree',
      },
    ],
  ])
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

const EDIT_CARD_RE = /edit card for/i

describe('Workspace card layout — editing the card behind the workspace', () => {
  afterEach(() => {
    cleanup()
    tasksByIdRef.current = new Map()
  })

  it('offers to edit the card a workspace is doing the work of', () => {
    mockStore([makeWorkspace()])
    mockTask('ws-1')

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByRole('button', { name: EDIT_CARD_RE })).toBeTruthy()
  })

  it('offers nothing to edit when the workspace has no card', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.queryByRole('button', { name: EDIT_CARD_RE })).toBeNull()
  })
})

describe('Workspace card layout — status row', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stays quiet about a healthy workspace', () => {
    mockStore([makeWorkspace({ status: 'running' })])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Running is what a healthy workspace simply is — chipping it would
    // spend a slot on every card to say nothing.
    expect(screen.queryByText('running')).toBeNull()
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('keeps working status on terminal rows instead of repeating it on the card', () => {
    expect(showsWorkspaceCardAgentStatus('working')).toBe(false)
    expect(showsWorkspaceCardAgentStatus('needs_input')).toBe(true)
    expect(showsWorkspaceCardAgentStatus('done')).toBe(true)
  })

  it.each([
    'errored',
    'paused',
    'stopped',
  ])('shows the status badge when the workspace is %s', (status) => {
    mockStore([makeWorkspace({ status })])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText(status)).toBeTruthy()
  })

  it('reads the pull request on the status rail, opposite the controls', () => {
    mockStore([
      makeWorkspace({
        prNumber: 42,
        prState: 'OPEN',
        prTitle: 'Add feature',
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ])

    const { container } = render(
      <WorkspaceList projectId="project-1" repoPath="/repo" />
    )

    const statusRow = container.querySelector('[data-slot="card-status-row"]')
    expect(statusRow?.contains(screen.getByText('#42'))).toBe(true)
  })

  it('shares the status row with the start-work controls', () => {
    mockStore([makeWorkspace({ status: 'errored' })])

    const { container } = render(
      <WorkspaceList projectId="project-1" repoPath="/repo" />
    )

    const statusRow = container.querySelector('[data-slot="card-status-row"]')
    expect(statusRow).toBeTruthy()
    expect(statusRow?.contains(screen.getByText('errored'))).toBe(true)
    expect(
      statusRow?.contains(screen.getByTestId('terminal-spawn-controls'))
    ).toBe(true)
  })

  it('shows merge conflicts and the GitHub Actions result compactly', () => {
    mockStore([
      makeWorkspace({
        prBaseBranch: 'dev',
        prCheckStatus: 'failure',
        prMergeStatus: 'conflicting',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('conflicts with dev')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
  })
})
