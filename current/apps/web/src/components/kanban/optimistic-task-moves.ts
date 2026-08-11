import type { SharedTaskRow } from '@laborer/shared/rpc'
import type { TaskOptimisticOverlay } from '@/atoms/shared-state'

export type TaskMovePatch = Pick<SharedTaskRow, 'sortOrder' | 'status'>

export interface TaskMoveCommand extends TaskMovePatch {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly taskId: string
}

export interface TaskMoveConfirmation {
  readonly cursor: number
  readonly row: SharedTaskRow
}

interface PendingMove {
  readonly mutationId: string
  readonly patch: TaskMovePatch
}

interface CardQueue {
  ambiguous: boolean
  inFlight: PendingMove | null
  queued: PendingMove | null
}

export interface OptimisticTaskMoveDependencies {
  readonly clear: (taskId: string, mutationId: string) => void
  readonly confirm: (
    confirmation: TaskMoveConfirmation,
    mutationId: string
  ) => void
  readonly getAuthoritativeTask: (taskId: string) => SharedTaskRow | undefined
  readonly install: (taskId: string, overlay: TaskOptimisticOverlay) => void
  readonly isConflict: (error: unknown) => boolean
  readonly mutationId: () => string
  readonly send: (command: TaskMoveCommand) => Promise<TaskMoveConfirmation>
}

/**
 * One serialized command lane per card. Re-drags replace the queued command,
 * while every drag immediately owns the visible overlay.
 */
export class OptimisticTaskMoveQueue {
  readonly #cards = new Map<string, CardQueue>()
  readonly #observedMutationIds = new Set<string>()
  readonly #observedMutationOrder: string[] = []
  #dependencies: OptimisticTaskMoveDependencies

  constructor(dependencies: OptimisticTaskMoveDependencies) {
    this.#dependencies = dependencies
  }

  configure(dependencies: OptimisticTaskMoveDependencies): void {
    this.#dependencies = dependencies
  }

  move(taskId: string, patch: TaskMovePatch): void {
    const pending = { mutationId: this.#dependencies.mutationId(), patch }
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
      mutationId: pending.mutationId,
      patch,
    })
    if (card.inFlight === null) {
      this.#start(taskId, card, pending)
    } else {
      card.queued = pending
    }
  }

  observeMutationIds(mutationIds: readonly string[]): void {
    if (mutationIds.length === 0) {
      return
    }
    const observed = new Set(mutationIds)
    for (const mutationId of observed) {
      if (!this.#observedMutationIds.has(mutationId)) {
        this.#observedMutationIds.add(mutationId)
        this.#observedMutationOrder.push(mutationId)
      }
    }
    while (this.#observedMutationOrder.length > 256) {
      const oldest = this.#observedMutationOrder.shift()
      if (oldest !== undefined) {
        this.#observedMutationIds.delete(oldest)
      }
    }
    for (const [taskId, card] of this.#cards) {
      if (
        card.ambiguous &&
        card.inFlight &&
        observed.has(card.inFlight.mutationId)
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
      this.#dependencies.clear(taskId, pending.mutationId)
      return
    }
    card.inFlight = pending
    card.ambiguous = false
    this.#dependencies.install(taskId, {
      expectedRevision,
      mutationId: pending.mutationId,
      patch: pending.patch,
    })
    this.#dependencies
      .send({
        ...pending.patch,
        expectedRevision,
        mutationId: pending.mutationId,
        taskId,
      })
      .then((confirmation) => {
        this.#dependencies.confirm(confirmation, pending.mutationId)
        if (card.inFlight?.mutationId === pending.mutationId) {
          card.inFlight = null
          const latestKnownRevision = Math.max(
            confirmation.row.revision,
            this.#dependencies.getAuthoritativeTask(taskId)?.revision ?? 0
          )
          this.#startQueued(taskId, card, latestKnownRevision)
        }
      })
      .catch((error: unknown) => {
        if (!this.#dependencies.isConflict(error)) {
          // The command may have committed. Its ledger token is authoritative.
          if (card.inFlight?.mutationId === pending.mutationId) {
            card.ambiguous = true
            if (this.#observedMutationIds.has(pending.mutationId)) {
              card.inFlight = null
              card.ambiguous = false
              this.#startQueued(taskId, card)
            }
          }
          return
        }
        this.#dependencies.clear(taskId, pending.mutationId)
        if (card.inFlight?.mutationId === pending.mutationId) {
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

/** Fractional rank for the final slot represented by an already-reordered list. */
export const fractionalOrderAt = (
  tasks: readonly Pick<SharedTaskRow, 'sortOrder'>[],
  index: number
): number => {
  const before = index > 0 ? tasks[index - 1]?.sortOrder : null
  const after = index + 1 < tasks.length ? tasks[index + 1]?.sortOrder : null
  if (before !== null && before !== undefined) {
    return after !== null && after !== undefined
      ? before + (after - before) / 2
      : before + 1
  }
  return after !== null && after !== undefined ? after - 1 : 0
}
