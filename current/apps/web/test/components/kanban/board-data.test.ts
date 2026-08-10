import type { BoardTask, TaskBoardEvent } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  applyTaskBoardEvents,
  boardTaskTitle,
  projectForTask,
  slackAnalysisState,
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
  worktreeExists: false,
  worktreePath: null,
  ...overrides,
})

describe('board task projection', () => {
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

  it('projects Slack planning progress and failure from durable card fields', () => {
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: 'queued',
        initialPrompt: null,
      })
    ).toBe('analyzing')
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: 'failed',
        initialPrompt: null,
      })
    ).toBe('failed')
    expect(
      slackAnalysisState({
        source: 'slack_url',
        executionMirror: null,
        initialPrompt: 'Implement it',
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
