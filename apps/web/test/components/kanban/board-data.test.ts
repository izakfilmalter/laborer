import type {
  BoardTask,
  SharedTaskRow,
  TaskBoardEvent,
} from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  applySharedTaskUpdates,
  applyTaskBoardEvents,
  boardTaskTitle,
  projectForTask,
  slackAnalysisState,
  workspaceForTask,
} from '@/components/kanban/board-data'

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  actionName: null,
  branchName: null,
  createdAt: 1,
  executionId: null,
  executionStatus: null,
  id: 'task-1',
  labelIds: [],
  description: null,
  revision: 1,
  rootPath: '/repo',
  slackPermalink: null,
  source: 'manual',
  status: 'todo',
  title: 'Task',
  updatedAt: 1,
  worktreeBotOwned: false,
  worktreeExists: false,
  worktreePath: null,
  ...overrides,
})

const sharedTask = (overrides: Partial<SharedTaskRow> = {}): SharedTaskRow => ({
  ...task(overrides),
  baseBranch: null,
  baseSha: null,
  parentTaskId: null,
  prIsDraft: false,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  setupCompletedAt: null,
  sortOrder: null,
  worktreeError: null,
  worktreeStatus: null,
  ...overrides,
})

describe('board task projection', () => {
  it('projects queued worktrees as provisioning and missing completed worktrees as gone', () => {
    expect(
      applyTaskBoardEvents([
        {
          _tag: 'snapshot',
          cursor: 1,
          tasks: [
            task({
              executionStatus: 'queued',
              source: 'execution',
              status: 'in_progress',
              worktreePath: '/repo.worktrees/task',
            }),
          ],
        },
      ])[0]?.worktreeState
    ).toBe('provisioning')
    expect(
      applyTaskBoardEvents([
        {
          _tag: 'snapshot',
          cursor: 1,
          tasks: [
            task({
              executionStatus: 'completed',
              source: 'execution',
              status: 'in_review',
              worktreePath: '/repo.worktrees/task',
            }),
          ],
        },
      ])[0]?.worktreeState
    ).toBe('gone')
  })

  it('replaces snapshots and applies updates and deletions', () => {
    const events: TaskBoardEvent[] = [
      { _tag: 'snapshot', cursor: 1, tasks: [task()] },
      {
        _tag: 'delta',
        cursor: 2,
        deletedTaskIds: [],
        tasks: [task({ revision: 2, status: 'in_review' })],
      },
      {
        _tag: 'delta',
        cursor: 3,
        deletedTaskIds: ['task-1'],
        tasks: [],
      },
    ]

    expect(applyTaskBoardEvents(events)).toEqual([])
  })

  it('applies a non-accumulating delta to the prior projection', () => {
    const initial = applyTaskBoardEvents([
      { _tag: 'snapshot', cursor: 1, tasks: [task()] },
    ])
    const updated = applyTaskBoardEvents(
      [
        {
          _tag: 'delta',
          cursor: 2,
          deletedTaskIds: [],
          tasks: [task({ revision: 2, status: 'in_progress' })],
        },
      ],
      initial
    )

    expect(updated).toMatchObject([
      { id: 'task-1', revision: 2, status: 'in_progress' },
    ])
  })

  it('preserves shared parent and PR facts while applying updates', () => {
    const [projected] = applySharedTaskUpdates([
      {
        tasks: {
          cursor: 1,
          rows: [
            sharedTask({
              parentTaskId: 'parent',
              prIsDraft: true,
              prNumber: 421,
              prState: 'open',
              prTitle: 'Stream workspace surfaces',
              prUrl: 'https://github.com/example/repo/pull/421',
            }),
          ],
          type: 'snapshot',
        },
      },
    ])

    expect(projected).toMatchObject({
      parentTaskId: 'parent',
      pr: {
        number: 421,
        state: 'open',
        title: 'Stream workspace surfaces',
      },
    })
  })

  it('preserves the durable manual order in the board projection', () => {
    const [projected] = applySharedTaskUpdates([
      {
        tasks: {
          cursor: 1,
          rows: [sharedTask({ sortOrder: 12.5 })],
          type: 'snapshot',
        },
      },
    ])

    expect(projected?.sortOrder).toBe(12.5)
  })

  it('chooses the nearest ancestor project without prefix collisions', () => {
    const projects = [
      { id: 'broad', repoPath: '/repo' },
      { id: 'nearest', repoPath: '/repo/packages/app' },
      { id: 'collision', repoPath: '/rep' },
    ]
    expect(
      projectForTask(task({ rootPath: '/repo/packages/app/src' }), projects)?.id
    ).toBe('nearest')
    expect(projectForTask(task({ rootPath: '/repository' }), projects)).toBe(
      undefined
    )
  })

  it('projects Slack planning progress and failure from durable card fields', () => {
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: 'queued',
        description: null,
      })
    ).toBe('analyzing')
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: 'failed',
        description: null,
      })
    ).toBe('failed')
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: null,
        description: 'Implement it',
      })
    ).toBeNull()
  })

  it('shows a readable stand-in until the planner names a Slack card', () => {
    const permalink = 'https://acme.slack.com/archives/C0ABCD123/p1700000000'
    expect(
      boardTaskTitle({
        slackPermalink: permalink,
        source: 'slack_url',
        title: permalink,
      })
    ).toEqual({ isPlaceholder: true, text: 'Slack thread · C0ABCD123' })

    expect(
      boardTaskTitle({
        slackPermalink: permalink,
        source: 'slack_url',
        title: 'Fix the flaky board test',
      })
    ).toEqual({ isPlaceholder: false, text: 'Fix the flaky board test' })

    expect(
      boardTaskTitle({
        slackPermalink: null,
        source: 'manual',
        title: 'https://example.com/docs',
      })
    ).toEqual({ isPlaceholder: false, text: 'https://example.com/docs' })
  })
})

describe('the workspace a card leads to', () => {
  const workspace = (
    overrides: Partial<{
      id: string
      status: string
      worktreePath: string
    }> = {}
  ) => ({
    id: 'ws-1',
    status: 'running',
    worktreePath: '/repo.worktrees/task',
    ...overrides,
  })

  it('matches the workspace sharing the card’s worktree path', () => {
    expect(
      workspaceForTask({ worktreePath: '/repo.worktrees/task' }, [
        workspace({ id: 'ws-other', worktreePath: '/repo.worktrees/other' }),
        workspace(),
      ])?.id
    ).toBe('ws-1')
  })

  it('leads nowhere for a card whose work has no worktree yet', () => {
    expect(workspaceForTask({ worktreePath: null }, [workspace()])).toBe(
      undefined
    )
  })

  it('ignores a destroyed workspace that still shares the path', () => {
    expect(
      workspaceForTask({ worktreePath: '/repo.worktrees/task' }, [
        workspace({ status: 'destroyed' }),
      ])
    ).toBe(undefined)
  })
})
