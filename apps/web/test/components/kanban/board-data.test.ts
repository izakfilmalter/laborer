import type { BoardTask, SharedTaskRow } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  boardTasksFromSharedRows,
  boardTaskTitle,
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
  prApprovals: null,
  prIsDraft: false,
  prNumber: null,
  prReviewDecision: null,
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
      boardTasksFromSharedRows([
        sharedTask({
          executionStatus: 'queued',
          source: 'execution',
          status: 'in_progress',
          worktreePath: '/repo.worktrees/task',
        }),
      ])[0]?.worktreeState
    ).toBe('provisioning')
    expect(
      boardTasksFromSharedRows([
        sharedTask({
          executionStatus: 'completed',
          source: 'execution',
          status: 'in_review',
          worktreePath: '/repo.worktrees/task',
        }),
      ])[0]?.worktreeState
    ).toBe('gone')
  })

  it('preserves shared parent and PR facts in presentation mapping', () => {
    const [projected] = boardTasksFromSharedRows([
      sharedTask({
        parentTaskId: 'parent',
        prIsDraft: true,
        prNumber: 421,
        prState: 'open',
        prTitle: 'Stream workspace surfaces',
        prUrl: 'https://github.com/example/repo/pull/421',
      }),
    ])

    expect(projected).toMatchObject({
      parentTaskId: 'parent',
      pr: {
        isDraft: true,
        number: 421,
        state: 'open',
        title: 'Stream workspace surfaces',
      },
    })
  })

  it('carries the review verdict and its approvals onto the card', () => {
    const [projected] = boardTasksFromSharedRows([
      sharedTask({
        prApprovals: 2,
        prNumber: 421,
        prReviewDecision: 'approved',
        prState: 'open',
        prTitle: 'Stream workspace surfaces',
        prUrl: 'https://github.com/example/repo/pull/421',
      }),
    ])

    expect(projected?.pr).toMatchObject({
      approvals: 2,
      isDraft: false,
      reviewDecision: 'approved',
    })
  })

  it('keeps an unread review verdict unread rather than unapproved', () => {
    const [projected] = boardTasksFromSharedRows([
      sharedTask({
        prNumber: 421,
        prState: 'open',
        prTitle: 'Stream workspace surfaces',
        prUrl: 'https://github.com/example/repo/pull/421',
      }),
    ])

    expect(projected?.pr).toMatchObject({
      approvals: null,
      reviewDecision: null,
    })
  })

  it('preserves the durable manual order in the board projection', () => {
    const [projected] = boardTasksFromSharedRows([
      sharedTask({ sortOrder: 12.5 }),
    ])

    expect(projected?.sortOrder).toBe(12.5)
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
