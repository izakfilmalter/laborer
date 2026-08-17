/**
 * Temporary optimistic writers retained until issue #561 moves shared-record
 * intents to TanStack DB transactions. Shared rows are never read from here.
 */
import type { SharedStateUpdate, SharedTaskRow } from '@laborer/shared/rpc'
import { Effect, Stream } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import { LaborerClient } from './laborer-client'
import type {
  PendingTaskRows,
  TaskEditOverlay,
  TaskEditOverlays,
  TaskLabelOverlay,
  TaskLabelOverlays,
} from './optimistic-task-writes'

export interface TaskOptimisticOverlay {
  readonly expectedRevision: number
  readonly operationId: string
  readonly patch: Pick<SharedTaskRow, 'sortOrder' | 'status'>
}

export interface TaskMutationReceipt {
  readonly operationIds: readonly string[]
  readonly sequence: number
}

const taskOptimisticOverlaysAtom = Atom.make<
  ReadonlyMap<string, TaskOptimisticOverlay>
>(new Map())
const taskCreateOverlaysAtom = Atom.make<PendingTaskRows>(new Map())
const taskEditOverlaysAtom = Atom.make<TaskEditOverlays>(new Map())
const taskLabelOverlaysAtom = Atom.make<TaskLabelOverlays>(new Map())
const workspaceDestroyOverlaysAtom = Atom.make<ReadonlySet<string>>(
  new Set<string>()
)
const projectRemoveOverlaysAtom = Atom.make<ReadonlySet<string>>(
  new Set<string>()
)

const addSetMember = (current: ReadonlySet<string>, value: string) => {
  const next = new Set(current)
  next.add(value)
  return next
}

const removeSetMember = (current: ReadonlySet<string>, value: string) => {
  const next = new Set(current)
  next.delete(value)
  return next
}

export const installWorkspaceDestroyOverlayAtom = Atom.writable(
  (get) => get(workspaceDestroyOverlaysAtom),
  (context, taskId: string) =>
    context.set(
      workspaceDestroyOverlaysAtom,
      addSetMember(context.get(workspaceDestroyOverlaysAtom), taskId)
    )
)

export const clearWorkspaceDestroyOverlayAtom = Atom.writable(
  (get) => get(workspaceDestroyOverlaysAtom),
  (context, taskId: string) =>
    context.set(
      workspaceDestroyOverlaysAtom,
      removeSetMember(context.get(workspaceDestroyOverlaysAtom), taskId)
    )
)

export const installProjectRemoveOverlayAtom = Atom.writable(
  (get) => get(projectRemoveOverlaysAtom),
  (context, projectId: string) =>
    context.set(
      projectRemoveOverlaysAtom,
      addSetMember(context.get(projectRemoveOverlaysAtom), projectId)
    )
)

export const clearProjectRemoveOverlayAtom = Atom.writable(
  (get) => get(projectRemoveOverlaysAtom),
  (context, projectId: string) =>
    context.set(
      projectRemoveOverlaysAtom,
      removeSetMember(context.get(projectRemoveOverlaysAtom), projectId)
    )
)

export const installTaskCreateOverlayAtom = Atom.writable(
  (get) => get(taskCreateOverlaysAtom),
  (context, row: SharedTaskRow) => {
    const next = new Map(context.get(taskCreateOverlaysAtom))
    next.set(row.id, row)
    context.set(taskCreateOverlaysAtom, next)
  }
)

export const clearTaskCreateOverlayAtom = Atom.writable(
  (get) => get(taskCreateOverlaysAtom),
  (context, taskId: string) => {
    const next = new Map(context.get(taskCreateOverlaysAtom))
    next.delete(taskId)
    context.set(taskCreateOverlaysAtom, next)
  }
)

export const installTaskEditOverlayAtom = Atom.writable(
  (get) => get(taskEditOverlaysAtom),
  (
    context,
    input: { readonly overlay: TaskEditOverlay; readonly taskId: string }
  ) => {
    const next = new Map(context.get(taskEditOverlaysAtom))
    next.set(input.taskId, input.overlay)
    context.set(taskEditOverlaysAtom, next)
  }
)

export const clearTaskEditOverlayAtom = Atom.writable(
  (get) => get(taskEditOverlaysAtom),
  (context, taskId: string) => {
    const next = new Map(context.get(taskEditOverlaysAtom))
    next.delete(taskId)
    context.set(taskEditOverlaysAtom, next)
  }
)

export const installTaskLabelOverlayAtom = Atom.writable(
  (get) => get(taskLabelOverlaysAtom),
  (
    context,
    input: { readonly overlay: TaskLabelOverlay; readonly taskId: string }
  ) => {
    const next = new Map(context.get(taskLabelOverlaysAtom))
    next.set(input.taskId, input.overlay)
    context.set(taskLabelOverlaysAtom, next)
  }
)

export const clearTaskLabelOverlayAtom = Atom.writable(
  (get) => get(taskLabelOverlaysAtom),
  (context, taskId: string) => {
    const next = new Map(context.get(taskLabelOverlaysAtom))
    next.delete(taskId)
    context.set(taskLabelOverlaysAtom, next)
  }
)

export const taskMutationReceiptAtom = Atom.make<TaskMutationReceipt>({
  operationIds: [],
  sequence: 0,
})

export const installTaskOptimisticOverlayAtom = Atom.writable(
  (get) => get(taskOptimisticOverlaysAtom),
  (
    context,
    input: { readonly overlay: TaskOptimisticOverlay; readonly taskId: string }
  ) => {
    const next = new Map(context.get(taskOptimisticOverlaysAtom))
    next.set(input.taskId, input.overlay)
    context.set(taskOptimisticOverlaysAtom, next)
  }
)

export const clearTaskOptimisticOverlayAtom = Atom.writable(
  (get) => get(taskOptimisticOverlaysAtom),
  (
    context,
    input: { readonly operationId: string; readonly taskId: string }
  ) => {
    const overlays = context.get(taskOptimisticOverlaysAtom)
    if (overlays.get(input.taskId)?.operationId !== input.operationId) {
      return
    }
    const next = new Map(overlays)
    next.delete(input.taskId)
    context.set(taskOptimisticOverlaysAtom, next)
  }
)

export const confirmTaskOptimisticMoveAtom = Atom.writable(
  (get) => get(taskOptimisticOverlaysAtom),
  (
    context,
    input: {
      readonly operationId: string
      readonly row: SharedTaskRow
    }
  ) => {
    const overlays = context.get(taskOptimisticOverlaysAtom)
    if (overlays.get(input.row.id)?.operationId !== input.operationId) {
      return
    }
    const next = new Map(overlays)
    next.delete(input.row.id)
    context.set(taskOptimisticOverlaysAtom, next)
  }
)

/** Feed only intent correlation; TanStack collections own authoritative rows. */
export const observeSharedStateUpdateAtom = Atom.writable(
  (get) => get(taskMutationReceiptAtom),
  (context, update: SharedStateUpdate) => {
    const operationIds =
      update.tasks?.type === 'delta' ? (update.tasks.operationIds ?? []) : []
    if (operationIds.length === 0) {
      return
    }
    const settled = new Set(operationIds)
    const overlays = new Map(context.get(taskOptimisticOverlaysAtom))
    for (const [taskId, overlay] of overlays) {
      if (settled.has(overlay.operationId)) {
        overlays.delete(taskId)
      }
    }
    context.set(taskOptimisticOverlaysAtom, overlays)
    const receipt = context.get(taskMutationReceiptAtom)
    context.set(taskMutationReceiptAtom, {
      operationIds,
      sequence: receipt.sequence + 1,
    })
  }
)

export const makeSharedStateEventsAtom = () =>
  LaborerClient.runtime.pull(
    LaborerClient.pipe(
      Effect.map((client) =>
        // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
        client('state.subscribe', undefined as void)
      ),
      Stream.unwrap,
      Stream.tapError((error) =>
        Effect.logDebug(
          'Shared-state transport closed; awaiting next generation',
          error
        )
      )
    ),
    { disableAccumulation: true }
  )
