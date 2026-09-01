/**
 * Tests for the reorganized workspace card layout.
 *
 * Row 1 (Git): branch name + PR badge
 *
 * Row 2: workspace status
 *
 * @see Issue: Reorganize workspace actions
 */

import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  conflictPromptRef,
  destroyFn,
  mutationMap,
  openAgentPaneForWorkspaceFn,
  openCommentsForWorkspaceFn,
  tasksByIdRef,
  workspaceRowsRef,
} = vi.hoisted(() => ({
  conflictPromptRef: { current: '' },
  destroyFn: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  openAgentPaneForWorkspaceFn: vi.fn(),
  openCommentsForWorkspaceFn: vi.fn(),
  tasksByIdRef: { current: new Map<string, unknown>() },
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

const noopAtomRefresh = vi.hoisted(() => vi.fn())

vi.mock('@effect/atom-react/Hooks', () => ({
  // The sidebar polls its project's open pull requests, which needs a refresh
  // handle. One stable no-op keeps the poll's effect from re-running on every
  // render.
  useAtomRefresh: () => noopAtomRefresh,
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
  useAtomValue: (atom: symbol) =>
    (() => {
      if (atom === Symbol.for('workspaceViews')) {
        return workspaceRowsRef.current
      }
      if (atom === Symbol.for('tasksById')) {
        return tasksByIdRef.current
      }
      return {
        _tag: 'Success',
        value: {
          conflictPrompt: { source: 'test', value: conflictPromptRef.current },
          shortName: { source: 'test', value: 'LAB' },
        },
      }
    })(),
}))

vi.mock('@/db/shared-mutations', () => ({
  destroyWorkspace: vi.fn(),
  updateTask: vi.fn(),
}))

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({ data: [...tasksByIdRef.current.values()] }),
}))

vi.mock('@/db/shared-state', () => ({
  projectCollection: Symbol.for('projectCollection'),
  taskCollection: Symbol.for('taskCollection'),
  workspaceViewsFromRows: () => workspaceRowsRef.current,
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
  workspaceSyncReactivityKeys: (workspaceId: string) => ({
    'workspace-sync': [workspaceId],
  }),
}))

vi.mock('@/hooks/use-workspace-sync-status', () => ({
  useWorkspaceSyncStatus: () => ({ aheadCount: null, behindCount: null }),
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
    openAgentPaneForWorkspace: openAgentPaneForWorkspaceFn,
    openCommentsPaneForWorkspace: openCommentsForWorkspaceFn,
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

vi.mock('@laborer/ui/components/tooltip', () => ({
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

vi.mock('@laborer/ui/components/alert-dialog', () => ({
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
    taskNumber: number | null
    worktreeSetupStep: string | null
    prNumber: number | null
    prBaseBranch: string | null
    prCheckStatus: 'pending' | 'success' | 'failure' | null
    prChecks: readonly PullRequestCheckRun[] | null
    prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
    prUrl: string | null
    prTitle: string | null
    prState: string | null
    prUnresolvedThreads: number | null
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
  taskNumber: null,
  worktreeSetupStep: null,
  prNumber: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prMergeStatus: null,
  prUrl: null,
  prTitle: null,
  prState: null,
  prUnresolvedThreads: null,
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
        taskNumber: 7,
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

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    expect(screen.queryByRole('button', { name: REVIEW_PR_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: FIX_FINDINGS_RE })).toBeNull()
  })

  it('uses a compact workspace name and branch icon in the sidebar', () => {
    mockStore([makeWorkspace()])

    const { container } = render(
      <WorkspaceList projectId="project-1" rootPath="/repo" />
    )

    expect(
      container
        .querySelector('[data-slot="card-title"] > span')
        ?.getAttribute('class')
    ).toContain('text-xs')
    expect(
      container.querySelector('.lucide-git-branch')?.getAttribute('class')
    ).toContain('size-3.5')
  })
})

const UNRESOLVED_RE = /unresolved conversation/i

/**
 * The card names a workspace mission control can reveal, so the count of
 * unresolved conversations answers itself in place instead of degrading to
 * a browser tab the way a board card for unstarted work must.
 */
describe('Workspace card layout — unresolved conversations', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  const renderCardWithThreads = () => {
    mockStore([
      makeWorkspace({
        prNumber: 42,
        prState: 'OPEN',
        prTitle: 'Add feature',
        prUnresolvedThreads: 3,
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    return screen.getByRole('link', { name: UNRESOLVED_RE })
  }

  it('opens the conversation for its own workspace, not the focused one', async () => {
    const user = userEvent.setup()
    const count = renderCardWithThreads()

    await user.click(count)

    expect(openCommentsForWorkspaceFn).toHaveBeenCalledWith('ws-1')
  })

  it('asks again rather than closing when clicked a second time', async () => {
    const user = userEvent.setup()
    const count = renderCardWithThreads()

    await user.click(count)
    await user.click(count)

    // The action opens and never toggles, so the card has nothing to track:
    // the same ask twice is the same ask twice.
    expect(openCommentsForWorkspaceFn).toHaveBeenCalledTimes(2)
    expect(openCommentsForWorkspaceFn).toHaveBeenNthCalledWith(2, 'ws-1')
  })

  it('still points at the diff on GitHub for a modifier click', async () => {
    const user = userEvent.setup()
    const count = renderCardWithThreads()

    expect(count.getAttribute('href')).toBe(
      'https://github.com/org/repo/pull/42/files'
    )

    await user.keyboard('{Meta>}')
    await user.click(count)
    await user.keyboard('{/Meta}')

    expect(openCommentsForWorkspaceFn).not.toHaveBeenCalled()
  })
})

const EDIT_CARD_RE = /edit card for/i

describe('Workspace card layout — editing the card behind the workspace', () => {
  afterEach(() => {
    cleanup()
    tasksByIdRef.current = new Map()
  })

  it('offers to edit the card a workspace is doing the work of', () => {
    mockStore([makeWorkspace({ taskNumber: 7 })])
    mockTask('ws-1')

    render(
      <WorkspaceList
        projectId="project-1"
        projectShortName="LAB"
        rootPath="/repo"
      />
    )

    expect(screen.getByRole('button', { name: EDIT_CARD_RE })).toBeTruthy()
    expect(screen.getByText('LAB-7')).toBeTruthy()
  })

  it('offers nothing to edit when the workspace has no card', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    expect(screen.queryByRole('button', { name: EDIT_CARD_RE })).toBeNull()
  })
})

describe('Workspace card layout — status row', () => {
  afterEach(() => {
    cleanup()
    conflictPromptRef.current = ''
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stays quiet about a healthy workspace', () => {
    mockStore([makeWorkspace({ status: 'running' })])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

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

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

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
      <WorkspaceList projectId="project-1" rootPath="/repo" />
    )

    const statusRow = container.querySelector('[data-slot="card-status-row"]')
    expect(statusRow?.contains(screen.getByText('#42'))).toBe(true)
  })

  it('shares the status row with the start-work controls', () => {
    mockStore([makeWorkspace({ status: 'errored' })])

    const { container } = render(
      <WorkspaceList projectId="project-1" rootPath="/repo" />
    )

    const statusRow = container.querySelector('[data-slot="card-status-row"]')
    expect(statusRow).toBeTruthy()
    expect(statusRow?.contains(screen.getByText('errored'))).toBe(true)
    expect(
      statusRow?.contains(screen.getByTestId('terminal-spawn-controls'))
    ).toBe(true)
  })

  it('marks a merge conflict without spending words on it', () => {
    mockStore([
      makeWorkspace({
        prBaseBranch: 'dev',
        prCheckStatus: null,
        prMergeStatus: 'conflicting',
      }),
    ])

    const { container } = render(
      <WorkspaceList projectId="project-1" rootPath="/repo" />
    )

    const mark = screen.getByRole('img', { name: 'Conflicts with dev' })
    expect(mark).toBeTruthy()
    // Last on the rail: an obstacle to landing work, not a stage of it.
    const statusRow = container.querySelector('[data-slot="card-status-row"]')
    const badges = statusRow?.firstElementChild
    expect(badges?.lastElementChild?.contains(mark)).toBe(true)
  })

  it('turns the conflict mark into the action that clears it', async () => {
    conflictPromptRef.current = 'Rebase onto dev and resolve the conflicts.'
    mockStore([
      makeWorkspace({
        prBaseBranch: 'dev',
        prCheckStatus: null,
        prMergeStatus: 'conflicting',
      }),
    ])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    const action = screen.getByRole('button', {
      name: 'Resolve conflicts with dev',
    })
    await userEvent.click(action)

    expect(openAgentPaneForWorkspaceFn).toHaveBeenCalledWith('ws-1', {
      initialPrompt: 'Rebase onto dev and resolve the conflicts.',
    })
  })

  it('leaves the conflict mark read-only without a project prompt', () => {
    mockStore([
      makeWorkspace({
        prBaseBranch: 'dev',
        prCheckStatus: null,
        prMergeStatus: 'conflicting',
      }),
    ])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    expect(
      screen.queryByRole('button', { name: 'Resolve conflicts with dev' })
    ).toBeNull()
    expect(screen.getByRole('img', { name: 'Conflicts with dev' })).toBeTruthy()
  })

  it('hangs the check rollup off the pull request pill', () => {
    mockStore([
      makeWorkspace({
        prCheckStatus: 'failure',
        prChecks: [
          {
            bucket: 'failure',
            durationMs: 179_000,
            group: 'Merge Checks',
            name: 'Unit Tests',
            url: null,
          },
          {
            bucket: 'success',
            durationMs: 40_000,
            group: 'Merge Checks',
            name: 'Build',
            url: null,
          },
        ],
        prNumber: 42,
        prState: 'OPEN',
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ])

    render(<WorkspaceList projectId="project-1" rootPath="/repo" />)

    const pill = screen
      .getByText('#42')
      .closest('[data-slot="pr-status-badge"]')
    const checks = screen.getByRole('link', {
      name: 'Some checks were not successful: 1 failed · 1 passed',
    })
    expect(pill?.contains(checks)).toBe(true)
    expect(checks.getAttribute('href')).toBe(
      'https://github.com/org/repo/pull/42/checks'
    )
  })
})
