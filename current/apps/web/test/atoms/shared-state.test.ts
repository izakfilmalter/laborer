import type { SharedTaskRow } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  type AuthoritativeSharedState,
  applySharedStateUpdate,
} from '../../src/atoms/shared-state'

const task = (id: string, revision = 1): SharedTaskRow => ({
  actionName: null,
  baseBranch: null,
  baseSha: null,
  branchName: null,
  createdAt: 1,
  description: null,
  executionId: null,
  executionStatus: null,
  id,
  parentTaskId: null,
  prIsDraft: false,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  revision,
  rootPath: '/repo',
  setupCompletedAt: null,
  slackPermalink: null,
  sortOrder: null,
  source: 'manual',
  status: 'todo',
  title: id,
  updatedAt: revision,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

const empty: AuthoritativeSharedState = {
  projects: { cursor: 0, rows: [] },
  settings: { cursor: 0, rows: [] },
  tasks: { cursor: 0, rows: [] },
}

describe('applySharedStateUpdate', () => {
  it('installs snapshots and applies explicit deletion deltas', () => {
    const snapshotted = applySharedStateUpdate(empty, {
      tasks: { cursor: 1, rows: [task('one'), task('two')], type: 'snapshot' },
    })
    const changed = applySharedStateUpdate(snapshotted, {
      tasks: {
        cursor: 2,
        deletedRowIds: ['one'],
        mutationIds: ['move-1'],
        rows: [task('two', 2)],
        type: 'delta',
      },
    })

    expect(changed.tasks).toEqual({ cursor: 2, rows: [task('two', 2)] })
  })

  it('ignores duplicate deltas but accepts an equal-cursor reconnect snapshot', () => {
    const current: AuthoritativeSharedState = {
      ...empty,
      tasks: { cursor: 2, rows: [task('stale')] },
    }
    const duplicate = applySharedStateUpdate(current, {
      tasks: {
        cursor: 2,
        deletedRowIds: ['stale'],
        rows: [],
        type: 'delta',
      },
    })
    const reconnected = applySharedStateUpdate(duplicate, {
      tasks: { cursor: 2, rows: [task('fresh')], type: 'snapshot' },
    })

    expect(duplicate.tasks.rows[0]?.id).toBe('stale')
    expect(reconnected.tasks.rows[0]?.id).toBe('fresh')
  })
})
