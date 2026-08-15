/**
 * A board card whose work has a workspace is that workspace's card.
 *
 * The board and the sidebar show one unit of work, so a card in a column
 * carries the same branch, status, and terminal controls the sidebar offers —
 * plus the board's own provenance and editing affordances.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { cloneElement, isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardTask } from '@/components/kanban/board-data'
import { TaskBoardCard } from '@/components/kanban/task-board'

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: () => vi.fn(),
  useAtomValue: () => ({ _tag: 'Success', value: {} }),
}))

vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'] as const,
  LaborerClient: {
    mutation: (name: string) => name,
    query: () => Symbol.for('query:stub'),
  },
}))

vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: { mutation: (name: string) => name },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({
    errorMessage: null,
    isLoading: false,
    isServiceAvailable: true,
    refresh: vi.fn(async () => []),
    serviceStatus: 'available' as const,
    terminals: [],
  }),
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

vi.mock('@/components/copy-button', () => ({ CopyButton: () => null }))

vi.mock('@/components/github-pr-status-badge', () => ({
  GitHubPrStatusBadge: () => null,
}))

vi.mock('@/components/kanban/worktree-affordance', () => ({
  TerminalAttachButton: () => null,
  WorktreeChip: () => null,
}))

vi.mock('@/panes/terminal-pane', () => ({ TerminalPane: () => null }))

// Stub tooltip — the real trigger merges its children into `render`, so the
// stub has to as well or every control loses its label.
vi.mock('@laborer/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) =>
    render && isValidElement(render)
      ? cloneElement(render, render.props as Record<string, unknown>, children)
      : children,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const AGENT_RE = /agent/i
const CREATE_SUB_WORKSPACE_RE = /create sub-workspace/i
const DESTROY_WORKSPACE_RE = /destroy workspace/i

const task: BoardTask = {
  actionName: null,
  branch: 'matching-cards',
  branchName: 'matching-cards',
  createdAt: 1,
  description: null,
  executionId: null,
  executionMirror: null,
  executionStatus: null,
  id: 'task-1',
  labelIds: [],
  parentTaskId: null,
  pr: null,
  revision: 1,
  rootPath: '/repo',
  slackPermalink: null,
  source: 'manual',
  status: 'in_progress',
  title: 'matching cards',
  updatedAt: 2,
  worktreeBotOwned: false,
  worktreeExists: true,
  worktreePath: '/repo.worktrees/matching-cards',
  worktreeState: 'exists',
}

const workspace = {
  isRoot: false,
  projectName: 'laborer',
  row: {
    aheadCount: null,
    behindCount: null,
    branchName: 'matching-cards',
    createdAt: new Date().toISOString(),
    errorMessage: null,
    id: 'ws-1',
    origin: 'laborer',
    prNumber: null,
    projectId: 'project-1',
    prState: null,
    prTitle: null,
    prUrl: null,
    status: 'running',
    taskSource: null,
    worktreePath: '/repo.worktrees/matching-cards',
    worktreeSetupStep: null,
  },
}

describe('board card for work that has a workspace', () => {
  it('is the sidebar card: branch, status, and terminal controls', () => {
    render(
      <TaskBoardCard
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onOpen={vi.fn()}
        task={task}
        workspace={workspace}
      />
    )

    expect(screen.getByTestId('workspace-card-matching-cards')).toBeTruthy()
    // Quiet about a healthy workspace, exactly as the sidebar is.
    expect(screen.queryByText('running')).toBeNull()
    expect(screen.getByRole('button', { name: AGENT_RE })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeTruthy()
  })

  it('surfaces a broken workspace on the board too', () => {
    render(
      <TaskBoardCard
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onOpen={vi.fn()}
        task={task}
        workspace={{
          ...workspace,
          row: { ...workspace.row, status: 'errored' },
        }}
      />
    )

    expect(screen.getByText('errored')).toBeTruthy()
  })

  it('keeps the board affordances the workspace knows nothing about', () => {
    render(
      <TaskBoardCard
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onOpen={vi.fn()}
        task={task}
        workspace={workspace}
      />
    )

    expect(screen.getByText('matching cards')).toBeTruthy()
    expect(screen.getByText('Manual')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Edit matching cards' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Cancel matching cards' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Open workspace for matching cards' })
    ).toBeTruthy()
  })

  it('shows the parent task badge for sub-task cards', () => {
    render(
      <TaskBoardCard
        parentTitle="Parent task"
        task={{ ...task, parentTaskId: 'parent' }}
        workspace={workspace}
      />
    )

    expect(screen.getByText('Parent: Parent task')).toBeTruthy()
  })

  it('leaves destroying the workspace to the surface that owns it', () => {
    render(<TaskBoardCard onOpen={vi.fn()} task={task} workspace={workspace} />)

    expect(
      screen.queryByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: CREATE_SUB_WORKSPACE_RE })
    ).toBeNull()
  })
})
