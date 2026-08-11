import type { SharedTaskRow } from '@laborer/shared/rpc'
import { describe, expect, it, vi } from 'vitest'
import {
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
    expect(fractionalOrderAt([{ sortOrder: 10 }, { sortOrder: 20 }], 0)).toBe(
      19
    )
    expect(
      fractionalOrderAt(
        [{ sortOrder: 10 }, { sortOrder: 15 }, { sortOrder: 20 }],
        1
      )
    ).toBe(15)
    expect(fractionalOrderAt([{ sortOrder: 10 }], 0)).toBe(0)
  })
})
