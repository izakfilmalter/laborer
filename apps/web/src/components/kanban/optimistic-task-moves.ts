import type { SharedTaskRow } from '@laborer/shared/rpc'
import type { TaskOptimisticOverlay } from '@/atoms/shared-state'

export type TaskMovePatch = Pick<SharedTaskRow, 'sortOrder' | 'status'>

export interface TaskMoveCommand extends TaskMovePatch {
  readonly expectedRevision: number
  readonly operationId: string
  readonly taskId: string
}

export interface TaskMoveConfirmation {
  readonly cursor: number
  readonly row: SharedTaskRow
}

interface PendingMove {
  readonly operationId: string
  readonly patch: TaskMovePatch
}

interface CardQueue {
  ambiguous: boolean
  inFlight: PendingMove | null
  queued: PendingMove | null
}

// One shared-state delta contains at most 1,000 ledger entries. Keep one full
// batch so a response rejection queued just after its receipt can still be
// recognized as an already-committed move.
const MAX_OBSERVED_OPERATION_IDS = 1024

export interface OptimisticTaskMoveDependencies {
  readonly clear: (taskId: string, operationId: string) => void
  readonly confirm: (
    confirmation: TaskMoveConfirmation,
    operationId: string
  ) => void
  readonly getAuthoritativeTask: (taskId: string) => SharedTaskRow | undefined
  readonly install: (taskId: string, overlay: TaskOptimisticOverlay) => void
  readonly isConflict: (error: unknown) => boolean
  /** True when the server replied and therefore definitely rejected the write. */
  readonly isDefinitiveFailure: (error: unknown) => boolean
  readonly operationId: () => string
  readonly send: (command: TaskMoveCommand) => Promise<TaskMoveConfirmation>
}

/**
 * One serialized command lane per card. Re-drags replace the queued command,
 * while every drag immediately owns the visible overlay.
 */
export class OptimisticTaskMoveQueue {
  readonly #cards = new Map<string, CardQueue>()
  readonly #observedOperationIds = new Set<string>()
  readonly #observedOperationOrder: string[] = []
  #dependencies: OptimisticTaskMoveDependencies

  constructor(dependencies: OptimisticTaskMoveDependencies) {
    this.#dependencies = dependencies
  }

  configure(dependencies: OptimisticTaskMoveDependencies): void {
    this.#dependencies = dependencies
  }

  move(taskId: string, patch: TaskMovePatch): void {
    const pending = { operationId: this.#dependencies.operationId(), patch }
    const revision = this.#dependencies.getAuthoritativeTask(taskId)?.revision
    if (revision === undefined) {
      return
    }
    const card = this.#cards.get(taskId) ?? {
      ambiguous: false,
      inFlight: null,
      queued: null,
    }
    this.#cards.set(taskId, card)
    this.#dependencies.install(taskId, {
      expectedRevision: revision,
      operationId: pending.operationId,
      patch,
    })
    if (card.inFlight === null) {
      this.#start(taskId, card, pending)
    } else {
      card.queued = pending
    }
  }

  observeOperationIds(operationIds: readonly string[]): void {
    if (operationIds.length === 0) {
      return
    }
    const observed = new Set(operationIds)
    for (const operationId of observed) {
      if (!this.#observedOperationIds.has(operationId)) {
        this.#observedOperationIds.add(operationId)
        this.#observedOperationOrder.push(operationId)
      }
    }
    while (this.#observedOperationOrder.length > MAX_OBSERVED_OPERATION_IDS) {
      const oldest = this.#observedOperationOrder.shift()
      if (oldest !== undefined) {
        this.#observedOperationIds.delete(oldest)
      }
    }
    for (const [taskId, card] of this.#cards) {
      if (
        card.ambiguous &&
        card.inFlight &&
        observed.has(card.inFlight.operationId)
      ) {
        card.inFlight = null
        card.ambiguous = false
        this.#startQueued(taskId, card)
      }
    }
  }

  #start(
    taskId: string,
    card: CardQueue,
    pending: PendingMove,
    confirmedRevision?: number
  ): void {
    const expectedRevision =
      confirmedRevision ??
      this.#dependencies.getAuthoritativeTask(taskId)?.revision
    if (expectedRevision === undefined) {
      this.#dependencies.clear(taskId, pending.operationId)
      return
    }
    card.inFlight = pending
    card.ambiguous = false
    this.#dependencies.install(taskId, {
      expectedRevision,
      operationId: pending.operationId,
      patch: pending.patch,
    })
    this.#dependencies
      .send({
        ...pending.patch,
        expectedRevision,
        operationId: pending.operationId,
        taskId,
      })
      .then((confirmation) => {
        this.#dependencies.confirm(confirmation, pending.operationId)
        if (card.inFlight?.operationId === pending.operationId) {
          card.inFlight = null
          const latestKnownRevision = Math.max(
            confirmation.row.revision,
            this.#dependencies.getAuthoritativeTask(taskId)?.revision ?? 0
          )
          this.#startQueued(taskId, card, latestKnownRevision)
        }
      })
      .catch((error: unknown) => {
        if (
          !(
            this.#dependencies.isConflict(error) ||
            this.#dependencies.isDefinitiveFailure(error)
          )
        ) {
          // The command may have committed. Its ledger token is authoritative.
          if (card.inFlight?.operationId === pending.operationId) {
            card.ambiguous = true
            if (this.#observedOperationIds.has(pending.operationId)) {
              card.inFlight = null
              card.ambiguous = false
              this.#startQueued(taskId, card)
            }
          }
          return
        }
        // CAS conflicts and other application-level rejections definitely did
        // not commit. Only transport failures retain the overlay for polling.
        this.#dependencies.clear(taskId, pending.operationId)
        if (card.inFlight?.operationId === pending.operationId) {
          card.inFlight = null
          card.ambiguous = false
          this.#startQueued(taskId, card)
        }
      })
  }

  #startQueued(
    taskId: string,
    card: CardQueue,
    confirmedRevision?: number
  ): void {
    const queued = card.queued
    card.queued = null
    if (queued === null) {
      this.#cards.delete(taskId)
      return
    }
    this.#start(taskId, card, queued, confirmedRevision)
  }
}

/**
 * The total ordering key for a column. Ranked cards sort by their explicit
 * rank; unranked cards (rows minted without a `sort_order`, e.g. by the
 * Slack-native app) derive a key from their creation time, so newer unranked
 * cards float to the top above every explicitly ranked card. Deriving the key
 * from the row's own immutable `createdAt` keeps it stable across renders and
 * clients, which lets a drop next to an unranked neighbor mint a persistent
 * rank relative to that neighbor instead of falling to the bottom of the
 * column.
 */
export const effectiveSortOrder = (
  task: Pick<SharedTaskRow, 'createdAt' | 'sortOrder'>
): number => task.sortOrder ?? -task.createdAt

/** Fractional rank for the final slot represented by an already-reordered list. */
export const fractionalOrderAt = (
  tasks: readonly Pick<SharedTaskRow, 'createdAt' | 'sortOrder'>[],
  index: number
): number => {
  const beforeTask = index > 0 ? tasks[index - 1] : undefined
  const afterTask = index + 1 < tasks.length ? tasks[index + 1] : undefined
  const before =
    beforeTask === undefined ? null : effectiveSortOrder(beforeTask)
  const after = afterTask === undefined ? null : effectiveSortOrder(afterTask)
  if (before !== null) {
    return after !== null ? before + (after - before) / 2 : before + 1
  }
  return after !== null ? after - 1 : 0
}
