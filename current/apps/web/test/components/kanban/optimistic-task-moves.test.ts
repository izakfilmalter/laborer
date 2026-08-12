import type { SharedTaskRow } from '@laborer/shared/rpc'
import { describe, expect, it, vi } from 'vitest'
import {
  effectiveSortOrder,
  fractionalOrderAt,
  OptimisticTaskMoveQueue,
  type TaskMoveCommand,
  type TaskMoveConfirmation,
} from '../../../src/components/kanban/optimistic-task-moves'

const task = (revision = 1): SharedTaskRow => ({
  actionName: null,
  baseBranch: null,
  baseSha: null,
  branchName: null,
  createdAt: 1,
  description: null,
  executionId: null,
  executionStatus: null,
  id: 'task-1',
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
  sortOrder: 0,
  source: 'manual',
  status: 'todo',
  title: 'Task',
  updatedAt: revision,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

const deferred = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const setup = () => {
  let authoritative = task()
  let nextId = 0
  const overlays = new Map<string, string>()
  const sends: Array<{
    command: TaskMoveCommand
    response: ReturnType<typeof deferred<TaskMoveConfirmation>>
  }> = []
  const clear = vi.fn((taskId: string, mutationId: string) => {
    if (overlays.get(taskId) === mutationId) {
      overlays.delete(taskId)
    }
  })
  const confirm = vi.fn(
    (confirmation: TaskMoveConfirmation, mutationId: string) => {
      if (overlays.get(confirmation.row.id) === mutationId) {
        overlays.delete(confirmation.row.id)
      }
    }
  )
  const queue = new OptimisticTaskMoveQueue({
    clear,
    confirm,
    getAuthoritativeTask: () => authoritative,
    install: (taskId, overlay) => overlays.set(taskId, overlay.mutationId),
    isConflict: (error) => error === 'conflict',
    isDefinitiveFailure: (error) => error === 'rejected',
    mutationId: () => `move-${++nextId}`,
    send: (command) => {
      const response = deferred<TaskMoveConfirmation>()
      sends.push({ command, response })
      return response.promise
    },
  })
  return {
    clear,
    confirm,
    overlays,
    queue,
    sends,
    setAuthoritative: (row: SharedTaskRow) => {
      authoritative = row
    },
  }
}

describe('OptimisticTaskMoveQueue', () => {
  it('silently removes an owned overlay on a stale revision', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.sends[0]?.response.reject('conflict')
    await vi.waitFor(() => expect(state.overlays.size).toBe(0))

    expect(state.clear).toHaveBeenCalledWith('task-1', 'move-1')
  })

  it('keeps an ambiguous overlay until its mutation appears in the ledger', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.sends[0]?.response.reject('transport')
    await Promise.resolve()

    expect(state.overlays.get('task-1')).toBe('move-1')
    state.setAuthoritative({ ...task(2), sortOrder: 2, status: 'in_review' })
    // The shared-state atom applies this authoritative row and clears its
    // matching overlay before notifying the command queue.
    state.overlays.delete('task-1')
    state.queue.observeMutationIds(['move-1'])
    expect(state.overlays.get('task-1')).toBeUndefined()
  })

  it('clears an overlay when the server definitively rejects the move', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.sends[0]?.response.reject('rejected')
    await vi.waitFor(() => expect(state.overlays.size).toBe(0))

    expect(state.clear).toHaveBeenCalledWith('task-1', 'move-1')
  })

  it('recognizes an early receipt from a full ledger batch', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.queue.observeMutationIds([
      'move-1',
      ...Array.from({ length: 999 }, (_, index) => `other-${String(index)}`),
    ])
    state.sends[0]?.response.reject('transport')
    await Promise.resolve()
    await Promise.resolve()

    state.queue.move('task-1', { sortOrder: 3, status: 'done' })
    expect(state.sends).toHaveLength(2)
  })

  it('coalesces re-drags and threads the latest authoritative revision', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 1, status: 'in_progress' })
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.queue.move('task-1', { sortOrder: 3, status: 'done' })

    expect(state.sends).toHaveLength(1)
    expect(state.overlays.get('task-1')).toBe('move-3')
    state.queue.observeMutationIds(['move-1'])
    expect(state.sends).toHaveLength(1)
    state.sends[0]?.response.resolve({ cursor: 1, row: task(2) })
    await Promise.resolve()

    expect(state.sends).toHaveLength(2)
    expect(state.sends[1]?.command).toMatchObject({
      expectedRevision: 2,
      mutationId: 'move-3',
      sortOrder: 3,
      status: 'done',
    })
    expect(state.overlays.get('task-1')).toBe('move-3')
  })

  it('never lets confirmation A clear overlay B', async () => {
    const state = setup()
    state.queue.move('task-1', { sortOrder: 1, status: 'in_progress' })
    state.queue.move('task-1', { sortOrder: 2, status: 'in_review' })
    state.sends[0]?.response.resolve({ cursor: 1, row: task(2) })
    await Promise.resolve()

    expect(state.confirm).toHaveBeenCalledWith(expect.anything(), 'move-1')
    expect(state.overlays.get('task-1')).toBe('move-2')
  })
})

describe('fractionalOrderAt', () => {
  it('ranks between neighbors and beyond either edge', () => {
    expect(
      fractionalOrderAt(
        [
          { createdAt: 1, sortOrder: 10 },
          { createdAt: 1, sortOrder: 20 },
        ],
        0
      )
    ).toBe(19)
    expect(
      fractionalOrderAt(
        [
          { createdAt: 1, sortOrder: 10 },
          { createdAt: 1, sortOrder: 15 },
          { createdAt: 1, sortOrder: 20 },
        ],
        1
      )
    ).toBe(15)
    expect(fractionalOrderAt([{ createdAt: 1, sortOrder: 10 }], 0)).toBe(0)
  })

  // Regression: prod columns are full of unranked rows minted by the
  // Slack-native app (sort_order NULL). A drag among them used to return a
  // rank near zero, which the board comparator then sorted below the entire
  // unranked band — every re-order snapped the card to the bottom.
  it('keeps a card dropped between unranked neighbors at its drop slot', () => {
    const unranked = (id: string, createdAt: number) => ({
      createdAt,
      id,
      sortOrder: null,
    })
    // Board display order: newest unranked first.
    const column = [
      unranked('newest', 4000),
      unranked('middle', 3000),
      unranked('oldest', 2000),
    ]

    // Drag "oldest" between "newest" and "middle" (drop index 1).
    const reordered = [column[0]!, column[2]!, column[1]!]
    const minted = fractionalOrderAt(reordered, 1)
    const moved = { ...reordered[1]!, sortOrder: minted }

    const resorted = [column[0]!, column[1]!, moved].sort(
      (a, b) =>
        effectiveSortOrder(a) - effectiveSortOrder(b) ||
        b.createdAt - a.createdAt
    )
    expect(resorted.map(({ id }) => id)).toEqual(['newest', 'oldest', 'middle'])
  })

  it('keeps a card dropped above all unranked cards at the top', () => {
    const column = [
      { createdAt: 4000, id: 'newest', sortOrder: null },
      { createdAt: 3000, id: 'ranked', sortOrder: 0 },
    ]
    // Drag "ranked" to the top (drop index 0).
    const reordered = [column[1]!, column[0]!]
    const minted = fractionalOrderAt(reordered, 0)
    const moved = { ...column[1]!, sortOrder: minted }

    const resorted = [column[0]!, moved].sort(
      (a, b) =>
        effectiveSortOrder(a) - effectiveSortOrder(b) ||
        b.createdAt - a.createdAt
    )
    expect(resorted.map(({ id }) => id)).toEqual(['ranked', 'newest'])
  })
})
