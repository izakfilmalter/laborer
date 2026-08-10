import type { BoardTask, TaskBoardEvent } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  applyTaskBoardEvents,
  projectForTask,
} from '@/components/kanban/board-data'

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  actionName: null,
  branchName: null,
  createdAt: 1,
  executionId: null,
  executionStatus: null,
  id: 'task-1',
  initialPrompt: null,
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
})
