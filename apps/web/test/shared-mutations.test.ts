import type {
  SharedLabelRow,
  SharedProjectRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pendingTaskRow } from '@/db/pending-task-row'
import {
  confirmWorkspaceCreation,
  createTask,
  deleteLabel,
  reorderProjects,
  updateTask,
} from '@/db/shared-mutations'
import {
  labelCollection,
  projectCollection,
  type SharedStateSource,
  sharedCollectionBundle,
  taskCollection,
} from '@/db/shared-state'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class Source implements SharedStateSource {
  publish: ((update: SharedStateUpdate) => void) | undefined

  start(publish: (update: SharedStateUpdate) => void): () => void {
    this.publish = publish
    return () => {
      this.publish = undefined
    }
  }

  emit(update: SharedStateUpdate) {
    this.publish?.(update)
  }
}

const task = (id: string, revision = 1): SharedTaskRow => ({
  ...pendingTaskRow({
    id,
    now: 1,
    rootPath: '/repo',
    status: 'todo',
    text: id,
  }),
  revision,
})

const project = (id: string, revision = 1): SharedProjectRow => ({
  branchName: 'main',
  canonicalGitCommonDir: `/repo/${id}/.git`,
  createdAt: 1,
  id,
  name: id,
  repoId: id,
  revision,
  rootPath: `/repo/${id}`,
  sortOrder: null,
  updatedAt: 1,
})

const label = (id: string): SharedLabelRow => ({
  color: 'blue',
  createdAt: 1,
  id,
  name: id,
  revision: 1,
  updatedAt: 1,
})

describe('shared optimistic mutations', () => {
  const source = new Source()
  let release: () => void

  beforeAll(() => {
    release = sharedCollectionBundle.activate(source)
    source.emit({
      labels: { cursor: 1, rows: [], type: 'snapshot' },
      projects: { cursor: 1, rows: [], type: 'snapshot' },
      settings: { cursor: 1, rows: [], type: 'snapshot' },
      tasks: { cursor: 1, rows: [], type: 'snapshot' },
    })
  })

  afterAll(async () => {
    release()
    await tick()
  })

  it('inserts immediately and persists through RPC success until publication', async () => {
    let resolveRpc!: (value: { id: string }) => void
    const rpc = new Promise<{ id: string }>((resolve) => {
      resolveRpc = resolve
    })
    const result = createTask({
      now: 2,
      operationId: 'create-task',
      payload: {
        id: 'created',
        projectId: 'project',
        status: 'todo',
        text: 'Created',
      },
      rootPath: '/repo',
      send: () => rpc,
    })

    expect(taskCollection.get('created')?.title).toBe('Created')
    resolveRpc({ id: 'created' })
    await expect(result).resolves.toEqual({ id: 'created' })
    expect(taskCollection.get('created')?.title).toBe('Created')

    source.emit({
      tasks: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: ['create-task'],
        rows: [{ ...task('created', 1), title: 'Created' }],
        type: 'delta',
      },
    })
    await tick()
    expect(taskCollection.get('created')?.title).toBe('Created')
  })

  it('serializes same-row edits and reads the latest authoritative revision', async () => {
    source.emit({
      tasks: {
        cursor: 3,
        deletedRowIds: [],
        operationIds: [],
        rows: [task('fifo', 1)],
        type: 'delta',
      },
    })
    const revisions: number[] = []
    let resolveFirst!: () => void
    const firstRpc = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const first = updateTask({
      description: null,
      operationId: 'fifo-1',
      send: (payload) => {
        revisions.push(payload.expectedRevision)
        return firstRpc
      },
      taskId: 'fifo',
      title: 'first',
    })
    const second = updateTask({
      description: null,
      operationId: 'fifo-2',
      send: (payload) => {
        revisions.push(payload.expectedRevision)
        return Promise.resolve()
      },
      taskId: 'fifo',
      title: 'second',
    })

    expect(taskCollection.get('fifo')?.title).toBe('second')
    await tick()
    expect(revisions).toEqual([1])
    resolveFirst()
    await first
    source.emit({
      tasks: {
        cursor: 4,
        deletedRowIds: [],
        operationIds: ['fifo-1'],
        rows: [{ ...task('fifo', 2), title: 'first' }],
        type: 'delta',
      },
    })
    await tick()
    expect(revisions).toEqual([1, 2])
    await second
    source.emit({
      tasks: {
        cursor: 5,
        deletedRowIds: [],
        operationIds: ['fifo-2'],
        rows: [{ ...task('fifo', 3), title: 'second' }],
        type: 'delta',
      },
    })
  })

  it('rolls back a definitive rejection with TanStack cascading later state', async () => {
    source.emit({
      tasks: {
        cursor: 6,
        deletedRowIds: [],
        operationIds: [],
        rows: [task('cascade', 1)],
        type: 'delta',
      },
    })
    const first = updateTask({
      description: null,
      operationId: 'reject-first',
      send: () =>
        Promise.reject(
          Object.assign(new Error('conflict'), { code: 'CAS_CONFLICT' })
        ),
      taskId: 'cascade',
      title: 'first',
    })
    const second = updateTask({
      description: null,
      operationId: 'reject-second',
      send: () => Promise.resolve(undefined),
      taskId: 'cascade',
      title: 'second',
    })
    second.catch(() => undefined)

    await expect(first).rejects.toMatchObject({ code: 'CAS_CONFLICT' })
    await tick()
    expect(taskCollection.get('cascade')?.title).toBe('cascade')
  })

  it('retains ambiguous optimism until a replacement snapshot reconciles it', async () => {
    source.emit({
      tasks: {
        cursor: 7,
        deletedRowIds: [],
        operationIds: [],
        rows: [task('ambiguous', 1)],
        type: 'delta',
      },
    })
    const result = updateTask({
      description: null,
      operationId: 'ambiguous-update',
      send: () => Promise.reject(new Error('socket closed')),
      taskId: 'ambiguous',
      title: 'possibly saved',
    })
    await tick()
    expect(taskCollection.get('ambiguous')?.title).toBe('possibly saved')

    source.emit({
      tasks: {
        cursor: 1,
        rows: [task('ambiguous', 1)],
        type: 'snapshot',
      },
    })
    await expect(result).rejects.toThrow('socket closed')
    await tick()
    expect(taskCollection.get('ambiguous')?.title).toBe('ambiguous')
  })

  it('commits project reorder and label deletion as atomic optimistic transactions', async () => {
    source.emit({
      labels: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: [],
        rows: [label('label')],
        type: 'delta',
      },
      projects: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: [],
        rows: [project('a'), project('b')],
        type: 'delta',
      },
      tasks: {
        cursor: 2,
        deletedRowIds: [],
        operationIds: [],
        rows: [{ ...task('labelled'), labelIds: ['label'] }],
        type: 'delta',
      },
    })

    const reorder = reorderProjects({
      assignments: [
        { projectId: 'a', sortOrder: 2 },
        { projectId: 'b', sortOrder: 1 },
      ],
      operationId: 'reorder',
      send: ({ assignments }) => {
        expect(
          assignments.map(({ expectedRevision }) => expectedRevision)
        ).toEqual([1, 1])
        return Promise.resolve()
      },
    })
    expect(projectCollection.get('a')?.sortOrder).toBe(2)
    expect(projectCollection.get('b')?.sortOrder).toBe(1)
    await reorder
    source.emit({
      projects: {
        cursor: 3,
        deletedRowIds: [],
        operationIds: ['reorder'],
        rows: [
          { ...project('a', 2), sortOrder: 2 },
          { ...project('b', 2), sortOrder: 1 },
        ],
        type: 'delta',
      },
    })

    const deletion = deleteLabel({
      labelId: 'label',
      operationId: 'delete-label',
      send: () => Promise.resolve(undefined),
    })
    expect(labelCollection.has('label')).toBe(false)
    expect(taskCollection.get('labelled')?.labelIds).toEqual([])
    await deletion
    source.emit({
      labels: {
        cursor: 3,
        deletedRowIds: ['label'],
        operationIds: ['delete-label'],
        rows: [],
        type: 'delta',
      },
      tasks: {
        cursor: 3,
        deletedRowIds: [],
        operationIds: ['delete-label'],
        rows: [{ ...task('labelled', 2), labelIds: [] }],
        type: 'delta',
      },
    })
  })

  it('keeps workspace creation pending until correlated Task publication', async () => {
    let settled = false
    const creation = confirmWorkspaceCreation({
      operationId: 'workspace-create',
      send: () => Promise.resolve({ id: 'workspace' }),
    }).then((value) => {
      settled = true
      return value
    })
    await tick()
    expect(settled).toBe(false)
    source.emit({
      tasks: {
        cursor: 4,
        deletedRowIds: [],
        operationIds: ['workspace-create'],
        rows: [task('workspace')],
        type: 'delta',
      },
    })
    await expect(creation).resolves.toEqual({ id: 'workspace' })
  })
})
