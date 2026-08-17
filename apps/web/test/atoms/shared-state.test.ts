import type {
  SharedLabelRow,
  SharedProjectRow,
  SharedSettingRow,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  type AuthoritativeSharedState,
  applySharedStateUpdate,
  confirmAuthoritativeTask,
  settleProjectRemoveOverlays,
  settleTaskOverlays,
  settleWorkspaceDestroyOverlays,
  workspaceViewsFromRows,
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
  labelIds: [],
  parentTaskId: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prIsDraft: false,
  prMergeStatus: null,
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
  labels: { cursor: 0, rows: [] },
  projects: { cursor: 0, rows: [] },
  settings: { cursor: 0, rows: [] },
  tasks: { cursor: 0, rows: [] },
}

const project = (rootPath: string, revision = 1): SharedProjectRow => ({
  branchName: null,
  canonicalGitCommonDir: `${rootPath}/.git`,
  createdAt: 1,
  id: 'project-one',
  name: 'one',
  repoId: 'repo-one',
  revision,
  rootPath,
  updatedAt: revision,
})

const setting = (value: string, revision = 1): SharedSettingRow => ({
  createdAt: 1,
  key: 'github_desktop_token',
  revision,
  updatedAt: revision,
  value,
})

describe('applySharedStateUpdate', () => {
  it('carries labels, and drops one the server hard-deleted', () => {
    const label = (id: string, name: string): SharedLabelRow => ({
      color: 'blue',
      createdAt: 1,
      id,
      name,
      revision: 1,
      updatedAt: 1,
    })
    const snapshotted = applySharedStateUpdate(empty, {
      labels: {
        cursor: 1,
        rows: [label('a', 'Worship'), label('b', 'Admin')],
        type: 'snapshot',
      },
    })
    const deleted = applySharedStateUpdate(snapshotted, {
      labels: { cursor: 2, deletedRowIds: ['a'], rows: [], type: 'delta' },
    })

    expect(deleted.labels.rows).toEqual([label('b', 'Admin')])
  })

  it('installs snapshots and applies explicit deletion deltas', () => {
    const snapshotted = applySharedStateUpdate(empty, {
      tasks: { cursor: 1, rows: [task('one'), task('two')], type: 'snapshot' },
    })
    const changed = applySharedStateUpdate(snapshotted, {
      tasks: {
        cursor: 2,
        deletedRowIds: ['one'],
        operationIds: ['move-1'],
        rows: [task('two', 2)],
        type: 'delta',
      },
    })

    expect(changed.tasks).toEqual({ cursor: 2, rows: [task('two', 2)] })
  })

  it('ignores duplicate deltas but accepts authoritative reconnect snapshots', () => {
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
      tasks: { cursor: 1, rows: [task('fresh')], type: 'snapshot' },
    })

    expect(duplicate.tasks.rows[0]?.id).toBe('stale')
    expect(reconnected.tasks.rows[0]?.id).toBe('fresh')
    expect(reconnected.tasks.cursor).toBe(1)
  })

  it('applies project registration, re-point, and removal updates', () => {
    const registered = applySharedStateUpdate(empty, {
      projects: { cursor: 1, rows: [project('/first')], type: 'snapshot' },
    })
    const rePointed = applySharedStateUpdate(registered, {
      projects: {
        cursor: 2,
        deletedRowIds: [],
        rows: [project('/second', 2)],
        type: 'delta',
      },
    })
    const removed = applySharedStateUpdate(rePointed, {
      projects: {
        cursor: 3,
        deletedRowIds: ['project-one'],
        rows: [],
        type: 'delta',
      },
    })

    expect(rePointed.projects).toEqual({
      cursor: 2,
      rows: [project('/second', 2)],
    })
    expect(removed.projects).toEqual({ cursor: 3, rows: [] })
  })

  it('applies live setting changes from another writer', () => {
    const connected = applySharedStateUpdate(empty, {
      settings: { cursor: 1, rows: [setting('first')], type: 'snapshot' },
    })
    const externallyChanged = applySharedStateUpdate(connected, {
      settings: {
        cursor: 2,
        deletedRowIds: [],
        rows: [setting('second', 2)],
        type: 'delta',
      },
    })

    expect(externallyChanged.settings).toEqual({
      cursor: 2,
      rows: [setting('second', 2)],
    })
  })
})

describe('workspaceViewsFromRows', () => {
  it('projects persisted task lifecycle and PR facts into workspace UI rows', () => {
    const row: SharedTaskRow = {
      ...task('child'),
      branchName: 'feat/child',
      parentTaskId: 'parent',
      prIsDraft: true,
      prNumber: 421,
      prState: 'open',
      prTitle: 'Stream workspaces',
      prUrl: 'https://github.com/example/repo/pull/421',
      source: 'worktree',
      worktreeError: 'setup failed',
      worktreePath: '/repo/.worktrees/child',
      worktreeStatus: 'errored',
    }

    expect(workspaceViewsFromRows([row], [project('/repo')])).toEqual([
      expect.objectContaining({ id: 'root-project-one' }),
      expect.objectContaining({
        branchName: 'feat/child',
        errorMessage: 'setup failed',
        id: 'child',
        origin: 'external',
        parentTaskId: 'parent',
        prIsDraft: true,
        prNumber: 421,
        prState: 'OPEN',
        status: 'errored',
        worktreePath: '/repo/.worktrees/child',
      }),
    ])
  })

  it('shows a worktree-owning task whose status column predates the worktree_status migration', () => {
    // Rows adopted before migration 0004 carry a live worktree path with a
    // NULL worktree_status. They are workspaces all the same — the sidebar
    // must agree with the board and the server's workspace records.
    const row: SharedTaskRow = {
      ...task('legacy'),
      branchName: 'hubspot-paste-import',
      source: 'worktree',
      worktreePath: '/repo/.worktrees/hubspot-paste-import',
      worktreeStatus: null,
    }

    expect(workspaceViewsFromRows([row], [project('/repo')])).toEqual([
      expect.objectContaining({ id: 'root-project-one' }),
      expect.objectContaining({
        branchName: 'hubspot-paste-import',
        id: 'legacy',
        origin: 'external',
        status: 'running',
        worktreePath: '/repo/.worktrees/hubspot-paste-import',
      }),
    ])
  })

  it('hides tasks without worktrees and tasks whose project is unregistered', () => {
    const noWorktree = task('todo')
    const unknownProject = {
      ...task('unknown'),
      rootPath: '/unknown',
      worktreePath: '/unknown/worktree',
      worktreeStatus: 'ready' as const,
    }

    expect(
      workspaceViewsFromRows([noWorktree, unknownProject], [project('/repo')])
    ).toEqual([expect.objectContaining({ id: 'root-project-one' })])
  })

  it('always synthesizes the root workspace ahead of task-backed workspaces', () => {
    // The main checkout never has a task row — the reconciler skips isMain
    // worktrees — yet the sidebar must always show it, pinned to the top.
    const row: SharedTaskRow = {
      ...task('feature'),
      branchName: 'feat/one',
      source: 'worktree',
      worktreePath: '/repo/.worktrees/one',
      worktreeStatus: 'ready',
    }

    const views = workspaceViewsFromRows([row], [project('/repo')])

    expect(views[0]).toEqual(
      expect.objectContaining({
        branchName: 'root',
        id: 'root-project-one',
        parentTaskId: null,
        projectId: 'project-one',
        status: 'running',
        worktreePath: '/repo',
      })
    )
    expect(views).toHaveLength(2)
  })

  it('names the root workspace after its checked-out branch', () => {
    const rootProject = { ...project('/repo'), branchName: 'dev' }

    expect(workspaceViewsFromRows([], [rootProject])[0]?.branchName).toBe('dev')
  })
})

describe('optimistic overlay ownership', () => {
  it('does not let confirmation A clear a newer overlay B', () => {
    const overlays = new Map([
      [
        'task-1',
        {
          expectedRevision: 1,
          operationId: 'move-b',
          patch: { sortOrder: 2, status: 'in_review' as const },
        },
      ],
    ])

    expect(settleTaskOverlays(overlays, ['move-a'])).toEqual(overlays)
    expect(settleTaskOverlays(overlays, ['move-b']).size).toBe(0)
  })

  it('does not advance the subscription cursor with a one-row RPC response', () => {
    const current: AuthoritativeSharedState = {
      ...empty,
      tasks: { cursor: 5, rows: [task('moved')] },
    }
    const confirmed = confirmAuthoritativeTask(current, {
      row: task('moved', 2),
    })
    const streamed = applySharedStateUpdate(confirmed, {
      tasks: {
        cursor: 10,
        deletedRowIds: [],
        rows: [task('other')],
        type: 'delta',
      },
    })

    expect(confirmed.tasks.cursor).toBe(5)
    expect(streamed.tasks.rows.map(({ id }) => id)).toEqual(['moved', 'other'])
  })
})

describe('settleWorkspaceDestroyOverlays', () => {
  const owning = (id: string): SharedTaskRow => ({
    ...task(id),
    worktreePath: `/repo/.worktrees/${id}`,
    worktreeStatus: 'ready',
  })

  it('keeps the overlay while the authoritative row still owns a worktree', () => {
    const overlays: ReadonlySet<string> = new Set(['destroying'])

    expect(
      settleWorkspaceDestroyOverlays(overlays, [owning('destroying')])
    ).toBe(overlays)
  })

  it('settles once the row drops its worktree, so a later re-provision is never hidden', () => {
    const overlays: ReadonlySet<string> = new Set(['destroying'])
    const cleared = { ...owning('destroying'), worktreePath: null }

    expect(settleWorkspaceDestroyOverlays(overlays, [cleared]).size).toBe(0)
  })

  it('settles when the authoritative row is deleted outright', () => {
    const overlays: ReadonlySet<string> = new Set(['destroying'])

    expect(settleWorkspaceDestroyOverlays(overlays, []).size).toBe(0)
  })

  it('settles each overlay independently', () => {
    const overlays: ReadonlySet<string> = new Set(['gone', 'still-owning'])

    expect(
      settleWorkspaceDestroyOverlays(overlays, [owning('still-owning')])
    ).toEqual(new Set(['still-owning']))
  })
})

describe('settleProjectRemoveOverlays', () => {
  it('keeps the overlay while the authoritative project row survives', () => {
    const overlays: ReadonlySet<string> = new Set(['project-one'])

    expect(settleProjectRemoveOverlays(overlays, [project('/repo')])).toBe(
      overlays
    )
  })

  it('settles once the authoritative project row is deleted', () => {
    const overlays: ReadonlySet<string> = new Set(['project-one'])

    expect(settleProjectRemoveOverlays(overlays, []).size).toBe(0)
  })
})
