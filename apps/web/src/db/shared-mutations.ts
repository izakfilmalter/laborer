import { labelColorForName } from '@laborer/shared/labels'
import type {
  LabelColor,
  SharedLabelRow,
  SharedProjectRow,
  SharedSettingRow,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import {
  createOptimisticAction,
  createPacedMutations,
  getActiveTransaction,
  queueStrategy,
  type Transaction,
} from '@tanstack/db'
import { pendingTaskRow } from './pending-task-row'
import {
  labelCollection,
  projectCollection,
  settingCollection,
  sharedCollectionBundle,
  taskCollection,
} from './shared-state'

type Send<Payload, Result> = (payload: Payload) => Promise<Result>

interface Deferred<Result> {
  readonly promise: Promise<Result>
  reject(error: unknown): void
  resolve(result: Result): void
}

const deferred = <Result>(): Deferred<Result> => {
  let resolve!: (result: Result) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Result>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

const isRpcError = (error: unknown): boolean => {
  if (!(typeof error === 'object' && error !== null)) {
    return false
  }
  if ('_tag' in error && error._tag === 'RpcError') {
    return true
  }
  if ('error' in error) {
    return isRpcError(error.error)
  }
  return false
}

/** Only a typed server rejection is safe to roll back. */
export const isDefinitiveSharedMutationFailure = (error: unknown): boolean =>
  isRpcError(error)

interface Persistence<Result> {
  readonly affected: readonly ('labels' | 'projects' | 'settings' | 'tasks')[]
  readonly operationId: string
  readonly outcome: Deferred<Result>
  readonly send: () => Promise<Result>
}

const persist = async <Result>(input: Persistence<Result>): Promise<void> => {
  // Register before dispatch so a very fast stream publication is retained.
  const receipt = sharedCollectionBundle.registerOperationReceipt(
    input.operationId,
    input.affected
  )
  try {
    let result: Result
    try {
      result = await input.send()
    } catch (error) {
      if (isDefinitiveSharedMutationFailure(error)) {
        input.outcome.reject(error)
        throw error
      }
      // The daemon may have committed before the transport was interrupted.
      // Keep optimism alive until a delta or replacement snapshot decides it.
      await receipt.published
      // Reconciliation is authoritative, so ending the caller's pending UI is
      // now safe. This does not fail the TanStack transaction or roll it back.
      input.outcome.reject(error)
      return
    }
    input.outcome.resolve(result)
    await receipt.published
  } finally {
    receipt.cancel()
  }
}

const start = <Result>(
  transaction: Transaction,
  outcome: Deferred<Result>
): Promise<Result> => {
  // The caller observes the operation result; TanStack owns rollback through
  // isPersisted. Consume that rejection here to avoid a second unhandled path.
  transaction.isPersisted.promise.catch(() => undefined)
  return outcome.promise
}

const authoritativeTask = (id: string) =>
  taskCollection._state.syncedData.get(id)
const authoritativeProject = (id: string) =>
  projectCollection._state.syncedData.get(id)
const authoritativeLabel = (id: string) =>
  labelCollection._state.syncedData.get(id)
const authoritativeSetting = (key: string) =>
  settingCollection._state.syncedData.get(key)

interface PacedIntent<Result = unknown> extends Persistence<Result> {
  readonly optimistic: () => void
}

type PacedManager = ReturnType<typeof createPacedMutations<PacedIntent>>
interface PacedManagerEntry {
  readonly manager: PacedManager
  pending: number
}
const pacedManagers = new Map<string, PacedManagerEntry>()
const pacedIntents = new Map<string, PacedIntent>()

/** One module-stable FIFO manager per entity key, shared across mutation kinds. */
const managerFor = (entityKey: string): PacedManagerEntry => {
  const existing = pacedManagers.get(entityKey)
  if (existing !== undefined) {
    return existing
  }
  const manager = createPacedMutations<PacedIntent>({
    mutationFn: async ({ transaction }) => {
      const intent = pacedIntents.get(transaction.id)
      if (intent === undefined) {
        throw new Error(
          `Missing paced intent for transaction ${transaction.id}`
        )
      }
      try {
        await persist(intent)
      } finally {
        pacedIntents.delete(transaction.id)
      }
    },
    onMutate: (intent) => {
      const transaction = getActiveTransaction()
      if (transaction === undefined) {
        throw new Error('Paced shared mutation has no active transaction')
      }
      intent.optimistic()
      pacedIntents.set(transaction.id, intent)
    },
    strategy: queueStrategy({
      addItemsTo: 'back',
      getItemsFrom: 'front',
      wait: 0,
    }),
  })
  const entry = { manager, pending: 0 }
  pacedManagers.set(entityKey, entry)
  return entry
}

const runPaced = <Result>(entityKey: string, intent: PacedIntent<Result>) => {
  const entry = managerFor(entityKey)
  entry.pending += 1
  let transaction: Transaction
  try {
    transaction = entry.manager(intent)
  } catch (error) {
    entry.pending -= 1
    if (entry.pending === 0 && pacedManagers.get(entityKey) === entry) {
      pacedManagers.delete(entityKey)
    }
    throw error
  }

  const release = () => {
    pacedIntents.delete(transaction.id)
    entry.pending -= 1
    if (entry.pending === 0 && pacedManagers.get(entityKey) === entry) {
      pacedManagers.delete(entityKey)
    }
  }
  transaction.isPersisted.promise.then(release, release)
  return start(transaction, intent.outcome)
}

export interface CreateTaskInput<Result> {
  readonly now: number
  readonly operationId: string
  readonly payload: {
    readonly id: string
    readonly projectId: string
    readonly status: Exclude<SharedTaskRow['status'], 'cancelled'>
    readonly text: string
  }
  readonly rootPath: string
  readonly send: Send<
    CreateTaskInput<Result>['payload'] & { readonly operationId: string },
    Result
  >
}

const createTaskOptimistically = createOptimisticAction<
  CreateTaskInput<unknown> & { readonly outcome: Deferred<unknown> }
>({
  mutationFn: (input) =>
    persist({
      affected: ['tasks'],
      operationId: input.operationId,
      outcome: input.outcome,
      send: () =>
        input.send({ ...input.payload, operationId: input.operationId }),
    }),
  onMutate: (input) => {
    taskCollection.insert(
      pendingTaskRow({
        id: input.payload.id,
        now: input.now,
        rootPath: input.rootPath,
        status: input.payload.status,
        text: input.payload.text,
      })
    )
  },
})

export const createTask = <Result>(input: CreateTaskInput<Result>) => {
  const outcome = deferred<Result>()
  const transaction = createTaskOptimistically({
    ...input,
    outcome: outcome as Deferred<unknown>,
  })
  return start(transaction, outcome)
}

export interface MoveTaskInput<Result> {
  readonly operationId: string
  readonly send: Send<
    {
      readonly expectedRevision: number
      readonly operationId: string
      readonly sortOrder: number | null
      readonly status: SharedTaskRow['status']
      readonly taskId: string
    },
    Result
  >
  readonly sortOrder: number | null
  readonly status: SharedTaskRow['status']
  readonly taskId: string
}

export const moveTask = <Result>(input: MoveTaskInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`task:${input.taskId}`, {
    affected: ['tasks'],
    operationId: input.operationId,
    optimistic: () => {
      taskCollection.update(input.taskId, (draft) => {
        draft.sortOrder = input.sortOrder
        draft.status = input.status
      })
    },
    outcome,
    send: () => {
      const row = authoritativeTask(input.taskId)
      if (row === undefined) {
        throw new RpcError({
          code: 'NOT_FOUND',
          message: 'Task no longer exists',
        })
      }
      return input.send({
        expectedRevision: row.revision,
        operationId: input.operationId,
        sortOrder: input.sortOrder,
        status: input.status,
        taskId: input.taskId,
      })
    },
  })
}

export interface UpdateTaskInput<Result> {
  readonly description: string | null
  readonly expectedRevision?: number
  readonly operationId: string
  readonly send: Send<
    {
      readonly description: string | null
      readonly expectedRevision: number
      readonly operationId: string
      readonly taskId: string
      readonly title: string
    },
    Result
  >
  readonly taskId: string
  readonly title: string
}

export const updateTask = <Result>(input: UpdateTaskInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`task:${input.taskId}`, {
    affected: ['tasks'],
    operationId: input.operationId,
    optimistic: () => {
      taskCollection.update(input.taskId, (draft) => {
        draft.description = input.description
        draft.title = input.title
      })
    },
    outcome,
    send: () => {
      const row = authoritativeTask(input.taskId)
      if (row === undefined) {
        throw new RpcError({
          code: 'NOT_FOUND',
          message: 'Task no longer exists',
        })
      }
      return input.send({
        description: input.description,
        expectedRevision: input.expectedRevision ?? row.revision,
        operationId: input.operationId,
        taskId: input.taskId,
        title: input.title,
      })
    },
  })
}

export interface SetTaskLabelsInput<Result> {
  readonly labelIds: readonly string[]
  readonly operationId: string
  readonly send: Send<
    {
      readonly expectedRevision: number
      readonly labelIds: readonly string[]
      readonly operationId: string
      readonly taskId: string
    },
    Result
  >
  readonly taskId: string
}

export const setTaskLabels = <Result>(input: SetTaskLabelsInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`task:${input.taskId}`, {
    affected: ['tasks'],
    operationId: input.operationId,
    optimistic: () => {
      taskCollection.update(input.taskId, (draft) => {
        draft.labelIds = [...input.labelIds]
      })
    },
    outcome,
    send: () => {
      const row = authoritativeTask(input.taskId)
      if (row === undefined) {
        throw new RpcError({
          code: 'NOT_FOUND',
          message: 'Task no longer exists',
        })
      }
      return input.send({
        expectedRevision: row.revision,
        labelIds: input.labelIds,
        operationId: input.operationId,
        taskId: input.taskId,
      })
    },
  })
}

export interface DestroyWorkspaceInput<Result> {
  readonly force?: boolean
  readonly operationId: string
  readonly send: Send<
    {
      readonly force?: boolean
      readonly operationId: string
      readonly workspaceId: string
    },
    Result
  >
  readonly workspaceId: string
}

export const destroyWorkspace = <Result>(
  input: DestroyWorkspaceInput<Result>
) => {
  const outcome = deferred<Result>()
  return runPaced(`task:${input.workspaceId}`, {
    affected: ['tasks'],
    operationId: input.operationId,
    optimistic: () => taskCollection.delete(input.workspaceId),
    outcome,
    send: () =>
      input.send({
        ...(input.force === undefined ? {} : { force: input.force }),
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      }),
  })
}

export interface CreateProjectInput<Result> {
  readonly id: string
  readonly operationId: string
  readonly repoPath: string
  readonly send: Send<
    {
      readonly id: string
      readonly operationId: string
      readonly repoPath: string
    },
    Result
  >
}

const createProjectOptimistically = createOptimisticAction<
  CreateProjectInput<unknown> & { readonly outcome: Deferred<unknown> }
>({
  mutationFn: (input) =>
    persist({
      affected: ['projects'],
      operationId: input.operationId,
      outcome: input.outcome,
      send: () =>
        input.send({
          id: input.id,
          operationId: input.operationId,
          repoPath: input.repoPath,
        }),
    }),
  onMutate: (input) => {
    const now = Date.now()
    const name =
      input.repoPath.split('/').filter(Boolean).at(-1) ?? input.repoPath
    projectCollection.insert({
      branchName: null,
      canonicalGitCommonDir: input.repoPath,
      createdAt: now,
      id: input.id,
      name,
      repoId: input.id,
      revision: 1,
      rootPath: input.repoPath,
      sortOrder: null,
      updatedAt: now,
    })
  },
})

export const createProject = <Result>(input: CreateProjectInput<Result>) => {
  const outcome = deferred<Result>()
  return start(
    createProjectOptimistically({
      ...input,
      outcome: outcome as Deferred<unknown>,
    }),
    outcome
  )
}

export interface RemoveProjectInput<Result> {
  readonly operationId: string
  readonly projectId: string
  readonly send: Send<
    { readonly operationId: string; readonly projectId: string },
    Result
  >
}

export const removeProject = <Result>(input: RemoveProjectInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`project:${input.projectId}`, {
    affected: ['projects'],
    operationId: input.operationId,
    optimistic: () => projectCollection.delete(input.projectId),
    outcome,
    send: () =>
      input.send({
        operationId: input.operationId,
        projectId: input.projectId,
      }),
  })
}

export interface ReorderProjectsInput<Result> {
  readonly assignments: readonly {
    readonly projectId: string
    readonly sortOrder: number
  }[]
  readonly operationId: string
  readonly send: Send<
    {
      readonly assignments: readonly {
        readonly expectedRevision: number
        readonly projectId: string
        readonly sortOrder: number
      }[]
      readonly operationId: string
    },
    Result
  >
}

export const reorderProjects = <Result>(
  input: ReorderProjectsInput<Result>
) => {
  const outcome = deferred<Result>()
  const key = input.assignments[0]?.projectId ?? input.operationId
  return runPaced(`project:${key}`, {
    affected: ['projects'],
    operationId: input.operationId,
    optimistic: () => {
      for (const assignment of input.assignments) {
        projectCollection.update(assignment.projectId, (draft) => {
          draft.sortOrder = assignment.sortOrder
        })
      }
    },
    outcome,
    send: () =>
      input.send({
        assignments: input.assignments.map((assignment) => {
          const row = authoritativeProject(assignment.projectId)
          if (row === undefined) {
            throw new RpcError({
              code: 'NOT_FOUND',
              message: 'Project no longer exists',
            })
          }
          return { ...assignment, expectedRevision: row.revision }
        }),
        operationId: input.operationId,
      }),
  })
}

export interface CreateLabelInput<Result> {
  readonly color?: LabelColor
  readonly id: string
  readonly name: string
  readonly operationId: string
  readonly send: Send<
    {
      readonly color?: LabelColor
      readonly id: string
      readonly name: string
      readonly operationId: string
    },
    Result
  >
}

const createLabelOptimistically = createOptimisticAction<
  CreateLabelInput<unknown> & { readonly outcome: Deferred<unknown> }
>({
  mutationFn: (input) =>
    persist({
      affected: ['labels'],
      operationId: input.operationId,
      outcome: input.outcome,
      send: () =>
        input.send({
          ...(input.color === undefined ? {} : { color: input.color }),
          id: input.id,
          name: input.name,
          operationId: input.operationId,
        }),
    }),
  onMutate: (input) => {
    const now = Date.now()
    labelCollection.insert({
      color: input.color ?? labelColorForName(input.name),
      createdAt: now,
      id: input.id,
      name: input.name,
      revision: 1,
      updatedAt: now,
    })
  },
})

export const createLabel = <Result>(input: CreateLabelInput<Result>) => {
  const outcome = deferred<Result>()
  return start(
    createLabelOptimistically({
      ...input,
      outcome: outcome as Deferred<unknown>,
    }),
    outcome
  )
}

export interface UpdateLabelInput<Result> {
  readonly color?: LabelColor
  readonly labelId: string
  readonly name?: string
  readonly operationId: string
  readonly send: Send<
    {
      readonly color?: LabelColor
      readonly expectedRevision: number
      readonly labelId: string
      readonly name?: string
      readonly operationId: string
    },
    Result
  >
}

export const updateLabel = <Result>(input: UpdateLabelInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`label:${input.labelId}`, {
    affected: ['labels'],
    operationId: input.operationId,
    optimistic: () => {
      labelCollection.update(input.labelId, (draft) => {
        if (input.color !== undefined) {
          draft.color = input.color
        }
        if (input.name !== undefined) {
          draft.name = input.name
        }
      })
    },
    outcome,
    send: () => {
      const row = authoritativeLabel(input.labelId)
      if (row === undefined) {
        throw new RpcError({
          code: 'NOT_FOUND',
          message: 'Label no longer exists',
        })
      }
      return input.send({
        ...(input.color === undefined ? {} : { color: input.color }),
        expectedRevision: row.revision,
        labelId: input.labelId,
        ...(input.name === undefined ? {} : { name: input.name }),
        operationId: input.operationId,
      })
    },
  })
}

export interface DeleteLabelInput<Result> {
  readonly labelId: string
  readonly operationId: string
  readonly send: Send<
    {
      readonly expectedRevision: number
      readonly labelId: string
      readonly operationId: string
    },
    Result
  >
}

export const deleteLabel = <Result>(input: DeleteLabelInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`label:${input.labelId}`, {
    affected: ['labels', 'tasks'],
    operationId: input.operationId,
    optimistic: () => {
      labelCollection.delete(input.labelId)
      for (const task of taskCollection.values()) {
        if (!task.labelIds.includes(input.labelId)) {
          continue
        }
        taskCollection.update(task.id, (draft) => {
          draft.labelIds = draft.labelIds.filter((id) => id !== input.labelId)
        })
      }
    },
    outcome,
    send: () => {
      const row = authoritativeLabel(input.labelId)
      if (row === undefined) {
        throw new RpcError({
          code: 'NOT_FOUND',
          message: 'Label no longer exists',
        })
      }
      return input.send({
        expectedRevision: row.revision,
        labelId: input.labelId,
        operationId: input.operationId,
      })
    },
  })
}

export interface SetSettingInput<Result> {
  readonly key: string
  readonly operationId: string
  readonly send: Send<
    {
      readonly expectedRevision: number
      readonly key: string
      readonly operationId: string
      readonly value: string
    },
    Result
  >
  readonly value: string
}

export const setSetting = <Result>(input: SetSettingInput<Result>) => {
  const outcome = deferred<Result>()
  return runPaced(`setting:${input.key}`, {
    affected: ['settings'],
    operationId: input.operationId,
    optimistic: () => {
      const stored = settingCollection.get(input.key)
      if (stored === undefined) {
        const now = Date.now()
        settingCollection.insert({
          createdAt: now,
          key: input.key,
          revision: 1,
          updatedAt: now,
          value: input.value,
        })
      } else {
        settingCollection.update(input.key, (draft) => {
          draft.value = input.value
        })
      }
    },
    outcome,
    send: () =>
      input.send({
        expectedRevision: authoritativeSetting(input.key)?.revision ?? 0,
        key: input.key,
        operationId: input.operationId,
        value: input.value,
      }),
  })
}

/** Workspace creation stays transient but observes the same confirmation rule. */
export const confirmWorkspaceCreation = async <Result>(input: {
  readonly operationId: string
  readonly send: () => Promise<Result>
}): Promise<Result> => {
  const receipt = sharedCollectionBundle.registerOperationReceipt(
    input.operationId,
    ['tasks']
  )
  try {
    let result: Result
    try {
      result = await input.send()
    } catch (error) {
      if (isDefinitiveSharedMutationFailure(error)) {
        throw error
      }
      await receipt.published
      // Reconciliation has now made the pending card truthful, but a lost RPC
      // response cannot supply the created Workspace identity to this caller.
      throw error
    }
    await receipt.published
    return result
  } finally {
    receipt.cancel()
  }
}

// Keep canonical row types visible at this boundary for callers and tests.
export type SharedMutationRows =
  | SharedLabelRow
  | SharedProjectRow
  | SharedSettingRow
  | SharedTaskRow
