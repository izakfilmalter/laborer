import type {
  ReviewCommentThread,
  SharedLabelRow,
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { useLiveQuery } from '@tanstack/react-db'
import { act, render, waitFor } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import {
  createSharedCollectionBundle,
  type SharedCollectionName,
  type SharedStateSource,
} from '../src/db/shared-state'

/**
 * Collections the daemon always publishes, and whose readiness is therefore
 * owned by a snapshot. `reviewComments` is deliberately not here — see
 * `OPTIONAL_TABLES` in `shared-state.ts`.
 */
const REQUIRED_COLLECTIONS: readonly SharedCollectionName[] = [
  'labels',
  'projects',
  'settings',
  'tasks',
]

const label = (id: string, revision = 1): SharedLabelRow => ({
  color: 'blue',
  createdAt: 1,
  id,
  name: id,
  revision,
  updatedAt: revision,
})

const project = (id: string, revision = 1): SharedProjectRow => ({
  branchName: null,
  canonicalGitCommonDir: `/repos/${id}/.git`,
  createdAt: 1,
  id,
  name: id,
  repoId: `repo-${id}`,
  revision,
  rootPath: `/repos/${id}`,
  sortOrder: null,
  updatedAt: revision,
})

const setting = (key: string, revision = 1): SharedSettingRow => ({
  createdAt: 1,
  key,
  revision,
  updatedAt: revision,
  value: `value-${revision}`,
})

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
  prChecks: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  revision,
  rootPath: '/repos/one',
  setupCompletedAt: null,
  slackPermalink: null,
  sortOrder: null,
  source: 'manual',
  status: 'todo',
  taskNumber: 1,
  title: id,
  updatedAt: revision,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

const reviewComment = (id: string, revision = 1): ReviewCommentThread => ({
  createdAt: 1,
  endLine: 2,
  filePath: 'src/a.ts',
  id,
  replies: [
    {
      author: 'human',
      body: 'look here',
      createdAt: 1,
      id: `${id}-reply`,
      threadId: id,
    },
  ],
  revision,
  side: 'additions',
  startLine: 1,
  status: 'open',
  updatedAt: revision,
  workspaceId: 'workspace-one',
})

/** A daemon without the review-comment slice omits `reviewComments` entirely. */
const snapshots = (cursor = 1): SharedStateUpdate => ({
  labels: { cursor, rows: [], type: 'snapshot' },
  projects: { cursor, rows: [], type: 'snapshot' },
  settings: { cursor, rows: [], type: 'snapshot' },
  tasks: { cursor, rows: [], type: 'snapshot' },
})

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

class ControlledSource implements SharedStateSource {
  active = 0
  maxActive = 0
  starts = 0
  stops = 0
  publish: ((update: SharedStateUpdate) => void) | undefined
  onStart: (() => void) | undefined
  onStop: (() => void) | undefined

  start = (publish: (update: SharedStateUpdate) => void) => {
    this.starts += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.publish = publish
    this.onStart?.()
    return () => {
      this.onStop?.()
      this.stops += 1
      this.active -= 1
      this.publish = undefined
    }
  }

  emit(update: SharedStateUpdate) {
    this.publish?.(update)
  }
}

describe('shared collection bundle synchronization', () => {
  it('registers all controls before one source and keeps readiness snapshot-owned', async () => {
    const bundle = createSharedCollectionBundle('registration-test')
    const source = new ControlledSource()
    source.onStart = () => {
      expect(
        REQUIRED_COLLECTIONS.every(
          (name) => bundle.collections[name].status === 'loading'
        )
      ).toBe(true)
    }

    const release = bundle.activate(source)

    expect(source.starts).toBe(1)
    expect(source.maxActive).toBe(1)
    expect(bundle.collections.labels.isReady()).toBe(false)

    source.emit({
      labels: {
        cursor: 1,
        deletedRowIds: [],
        rows: [label('delta-before-snapshot')],
        type: 'delta',
      },
    })
    expect(bundle.collections.labels.isReady()).toBe(false)

    source.emit(snapshots())
    expect(
      REQUIRED_COLLECTIONS.every((name) => bundle.collections[name].isReady())
    ).toBe(true)

    release()
    await tick()
    expect(source.active).toBe(0)
  })

  // `SharedStateUpdate.reviewComments` is optional on the wire, so a daemon
  // without the review-comment slice publishes snapshots that never mention
  // it. Gating readiness on a field the server may omit would leave every
  // reader of that collection pending forever, which costs far more than the
  // comments themselves.
  it('opens optional collections ready so an omitted field cannot stall a reader', async () => {
    const bundle = createSharedCollectionBundle('optional-collection-test')
    const source = new ControlledSource()
    const release = bundle.activate(source)

    expect(bundle.collections.reviewComments.isReady()).toBe(true)
    expect(bundle.collections.reviewComments.size).toBe(0)

    // A snapshot that never carries the field leaves it ready and empty
    // rather than reverting it to loading.
    source.emit(snapshots())
    expect(bundle.collections.reviewComments.isReady()).toBe(true)
    expect(bundle.collections.reviewComments.size).toBe(0)

    // A daemon that does publish them still replaces membership normally.
    source.emit({
      reviewComments: {
        cursor: 2,
        rows: [reviewComment('thread-one')],
        type: 'snapshot',
      },
    })
    expect(bundle.collections.reviewComments.has('thread-one')).toBe(true)

    release()
    await tick()
  })

  it('keeps cursors independent and replaces membership on reconnect snapshots', async () => {
    const bundle = createSharedCollectionBundle('cursor-test')
    const source = new ControlledSource()
    const release = bundle.activate(source)
    source.emit({
      labels: { cursor: 10, rows: [label('old-label')], type: 'snapshot' },
      projects: {
        cursor: 2,
        rows: [project('old-project')],
        type: 'snapshot',
      },
      settings: { cursor: 1, rows: [], type: 'snapshot' },
      tasks: { cursor: 1, rows: [], type: 'snapshot' },
    })

    source.emit({
      labels: {
        cursor: 10,
        deletedRowIds: ['old-label'],
        rows: [label('stale-label')],
        type: 'delta',
      },
      projects: {
        cursor: 3,
        deletedRowIds: [],
        rows: [project('new-project')],
        type: 'delta',
      },
    })
    expect(bundle.collections.labels.has('old-label')).toBe(true)
    expect(bundle.collections.labels.has('stale-label')).toBe(false)
    expect(bundle.collections.projects.has('new-project')).toBe(true)

    // A transport reconnect does not clear already-ready membership while its
    // replacement snapshot is still in flight.
    expect(bundle.collections.labels.has('old-label')).toBe(true)
    source.emit({
      labels: { cursor: 1, rows: [label('replacement')], type: 'snapshot' },
    })
    expect(bundle.collections.labels.has('old-label')).toBe(false)
    expect(bundle.collections.labels.has('replacement')).toBe(true)

    source.emit({
      labels: { cursor: 20, rows: [label('higher')], type: 'snapshot' },
    })
    expect(bundle.collections.labels.has('replacement')).toBe(false)
    expect(bundle.collections.labels.has('higher')).toBe(true)

    release()
    await tick()
  })

  it('fans out in canonical order while a consumer observes only one collection', async () => {
    const bundle = createSharedCollectionBundle('fanout-test')
    const source = new ControlledSource()
    const release = bundle.activate(source)
    source.emit(snapshots())
    const order: string[] = []
    const subscriptions = Object.entries(bundle.collections).map(
      ([name, collection]) =>
        collection.subscribeChanges(() => {
          order.push(name)
        })
    )

    source.emit({
      labels: {
        cursor: 2,
        deletedRowIds: [],
        rows: [label('label')],
        type: 'delta',
      },
      projects: {
        cursor: 2,
        deletedRowIds: [],
        rows: [project('project')],
        type: 'delta',
      },
      settings: {
        cursor: 2,
        deletedRowIds: [],
        rows: [setting('setting')],
        type: 'delta',
      },
      tasks: {
        cursor: 2,
        deletedRowIds: [],
        rows: [task('task')],
        type: 'delta',
      },
    })

    expect(order).toEqual(['labels', 'projects', 'settings', 'tasks'])
    expect(bundle.collections.tasks.has('task')).toBe(true)
    for (const subscription of subscriptions) {
      subscription.unsubscribe()
    }
    release()
    await tick()
  })

  it('retains early operation ids and waits for every affected collection', async () => {
    const bundle = createSharedCollectionBundle('receipt-test')
    const source = new ControlledSource()
    const release = bundle.activate(source)
    source.emit(snapshots())
    source.emit({
      tasks: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: ['already-observed'],
        rows: [task('one')],
        type: 'delta',
      },
    })

    await expect(
      bundle.registerOperationReceipt('already-observed', ['tasks']).published
    ).resolves.toBeUndefined()

    const grouped = bundle.registerOperationReceipt('grouped', [
      'labels',
      'tasks',
    ])
    let published = false
    grouped.published.then(() => {
      published = true
    })
    source.emit({
      labels: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: ['grouped'],
        rows: [label('grouped')],
        type: 'delta',
      },
    })
    await tick()
    expect(published).toBe(false)
    source.emit({
      tasks: {
        cursor: 3,
        deletedRowIds: [],
        operationIds: ['grouped'],
        rows: [task('grouped')],
        type: 'delta',
      },
    })
    await expect(grouped.published).resolves.toBeUndefined()

    const ambiguous = bundle.registerOperationReceipt('ambiguous', ['tasks'])
    source.emit({
      tasks: {
        cursor: 1,
        rows: [],
        type: 'snapshot',
      },
    })
    await expect(ambiguous.published).resolves.toBeUndefined()

    release()
    await tick()
  })

  it('groups cleanup and retains one source across StrictMode effect replay', async () => {
    const bundle = createSharedCollectionBundle('strict-mode-test')
    const source = new ControlledSource()
    let routedLabelChanges = 0
    source.onStart = () => source.emit(snapshots())
    const changes = bundle.collections.labels.subscribeChanges(() => {
      routedLabelChanges += 1
    })

    function Consumer() {
      const labels = useLiveQuery(bundle.collections.labels)
      useEffect(() => bundle.activate(source), [])
      return <output>{labels.data.map(({ id }) => id).join(',')}</output>
    }

    const view = render(
      <StrictMode>
        <Consumer />
      </StrictMode>
    )
    expect(source.starts).toBe(1)
    expect(source.maxActive).toBe(1)
    const changesBeforeLiveUpdate = routedLabelChanges

    act(() => {
      source.emit({
        labels: {
          cursor: 2,
          deletedRowIds: [],
          rows: [label('live')],
          type: 'delta',
        },
        projects: {
          cursor: 2,
          deletedRowIds: [],
          rows: [project('unobserved-project')],
          type: 'delta',
        },
        settings: {
          cursor: 2,
          deletedRowIds: [],
          rows: [setting('unobserved-setting')],
          type: 'delta',
        },
        tasks: {
          cursor: 2,
          deletedRowIds: [],
          rows: [task('unobserved-task')],
          type: 'delta',
        },
      })
    })
    await waitFor(() => expect(view.getByText('live')).toBeTruthy())
    expect(routedLabelChanges - changesBeforeLiveUpdate).toBe(1)
    expect(bundle.collections.projects.has('unobserved-project')).toBe(true)
    expect(bundle.collections.settings.has('unobserved-setting')).toBe(true)
    expect(bundle.collections.tasks.has('unobserved-task')).toBe(true)

    changes.unsubscribe()
    source.onStop = () => {
      expect(
        Object.values(bundle.collections).every(
          (collection) => collection.status === 'cleaned-up'
        )
      ).toBe(true)
    }
    view.unmount()
    await tick()
    expect(source.stops).toBe(1)
    expect(source.active).toBe(0)
  })
})
