import {
  ROOT_WORKSPACE_BRANCH_LABEL,
  rootWorkspaceId,
} from '@laborer/shared/root-workspace'
import type {
  PullRequestCheckRun,
  PullRequestReviewDecision,
  ReviewCommentThread,
  SharedLabelRow,
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import {
  ReviewCommentThread as ReviewCommentThreadSchema,
  SharedLabelRow as SharedLabelRowSchema,
  SharedProjectRow as SharedProjectRowSchema,
  SharedSettingRow as SharedSettingRowSchema,
  SharedTaskRow as SharedTaskRowSchema,
} from '@laborer/shared/rpc'
import { createCollection, type SyncConfig } from '@tanstack/db'
import { Schema } from 'effect'

export type SharedCollectionName =
  | 'labels'
  | 'projects'
  | 'reviewComments'
  | 'settings'
  | 'tasks'
type TableUpdate<Row> = NonNullable<SharedStateUpdate[SharedCollectionName]> & {
  readonly rows: readonly Row[]
}
type SyncControls<Row extends object> = Parameters<
  SyncConfig<Row, string>['sync']
>[0]

interface RegisteredTable {
  readonly apply: (update: TableUpdate<never>) => void
}

export interface SharedStateSource {
  /** The source is already decoded at the Effect RPC boundary. */
  readonly start: (publish: (update: SharedStateUpdate) => void) => () => void
}

export interface OperationReceipt {
  readonly cancel: () => void
  readonly published: Promise<void>
}

const TABLE_ORDER: readonly SharedCollectionName[] = [
  'labels',
  'projects',
  'reviewComments',
  'settings',
  'tasks',
]

/**
 * Collections a daemon is allowed to never mention.
 *
 * Every field of `SharedStateUpdate` is optional so a delta can carry only
 * what moved, but for these the *initial snapshot* may be absent too: a
 * daemon older than the review-comment slice publishes a snapshot with no
 * `reviewComments` field at all, forever.
 *
 * Readiness is otherwise snapshot-owned, and that is right for a collection
 * the server always sends — "loading" means "the client has not been told
 * yet". For a collection the server may never send, the same rule turns a
 * missing feature into a permanently loading one: every live query reading
 * it would stay pending and never resolve, and the diff pane would sit on a
 * spinner against a daemon that simply does not have comments.
 *
 * So an optional collection is ready the moment its controls are registered,
 * carrying the only membership the client can honestly claim — the empty set.
 * A snapshot that does arrive still replaces that membership through the
 * ordinary path, so a supporting daemon loses nothing.
 */
const OPTIONAL_TABLES: ReadonlySet<SharedCollectionName> = new Set([
  'reviewComments',
])

const MAX_RETAINED_OPERATION_IDS = 2048

class OperationReceipts {
  private readonly observed = new Map<SharedCollectionName, Set<string>>(
    TABLE_ORDER.map((name) => [name, new Set()])
  )
  private readonly observedOrder = new Map<SharedCollectionName, string[]>(
    TABLE_ORDER.map((name) => [name, []])
  )
  private readonly pending = new Map<
    string,
    Set<{
      readonly collections: ReadonlySet<SharedCollectionName>
      readonly observed: Set<SharedCollectionName>
      readonly resolve: () => void
    }>
  >()

  register(
    operationId: string,
    collections: readonly SharedCollectionName[]
  ): OperationReceipt {
    const expected = new Set(collections)
    let resolvePromise: () => void = () => undefined
    const published = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })
    const waiter = {
      collections: expected,
      observed: new Set(
        collections.filter((collection) =>
          this.observed.get(collection)?.has(operationId)
        )
      ),
      resolve: resolvePromise,
    }

    if (this.hasObservedEvery(operationId, expected)) {
      resolvePromise()
    } else {
      const waiters = this.pending.get(operationId) ?? new Set()
      waiters.add(waiter)
      this.pending.set(operationId, waiters)
    }

    return {
      cancel: () => {
        const waiters = this.pending.get(operationId)
        waiters?.delete(waiter)
        if (waiters?.size === 0) {
          this.pending.delete(operationId)
        }
      },
      published,
    }
  }

  observe(collection: SharedCollectionName, operationIds: readonly string[]) {
    const observed = this.observed.get(collection)
    const order = this.observedOrder.get(collection)
    if (!(observed && order)) {
      throw new Error(`Unknown shared collection ${collection}`)
    }
    for (const operationId of operationIds) {
      if (!observed.has(operationId)) {
        observed.add(operationId)
        order.push(operationId)
      }
      for (const waiter of this.pending.get(operationId) ?? []) {
        waiter.observed.add(collection)
        if (
          [...waiter.collections].every((expected) =>
            waiter.observed.has(expected)
          )
        ) {
          waiter.resolve()
          this.pending.get(operationId)?.delete(waiter)
        }
      }
      if (this.pending.get(operationId)?.size === 0) {
        this.pending.delete(operationId)
      }
    }

    while (order.length > MAX_RETAINED_OPERATION_IDS) {
      const oldest = order.shift()
      if (oldest !== undefined) {
        observed.delete(oldest)
      }
    }
  }

  /**
   * A replacement snapshot is authoritative even though it has no operation
   * ids. It therefore reconciles every ambiguous operation waiting on this
   * collection, whether the attempted write is present in the snapshot or not.
   */
  reconcile(collection: SharedCollectionName) {
    for (const [operationId, waiters] of this.pending) {
      for (const waiter of waiters) {
        if (!waiter.collections.has(collection)) {
          continue
        }
        waiter.observed.add(collection)
        if (
          [...waiter.collections].every((expected) =>
            waiter.observed.has(expected)
          )
        ) {
          waiter.resolve()
          waiters.delete(waiter)
        }
      }
      if (waiters.size === 0) {
        this.pending.delete(operationId)
      }
    }
  }

  private hasObservedEvery(
    operationId: string,
    collections: ReadonlySet<SharedCollectionName>
  ): boolean {
    for (const collection of collections) {
      if (!this.observed.get(collection)?.has(operationId)) {
        return false
      }
    }
    return true
  }
}

/**
 * Collection-local stream ordering. Snapshots replace membership even when a
 * reconnect starts from a lower cursor; deltas can only move forward.
 */
class SharedStateCoordinator {
  private readonly receipts: OperationReceipts
  private readonly tables = new Map<SharedCollectionName, RegisteredTable>()
  private readonly cursors: Record<SharedCollectionName, number> = {
    labels: 0,
    projects: 0,
    reviewComments: 0,
    settings: 0,
    tasks: 0,
  }

  constructor(receipts: OperationReceipts) {
    this.receipts = receipts
  }

  register<Row extends object>(
    name: SharedCollectionName,
    controls: SyncControls<Row>
  ): () => void {
    const apply = (update: TableUpdate<Row>) => {
      if (update.type === 'delta' && update.cursor <= this.cursors[name]) {
        return
      }

      controls.begin()
      if (update.type === 'snapshot') {
        controls.truncate()
        for (const row of update.rows) {
          controls.write({ type: 'insert', value: row })
        }
      } else {
        for (const key of update.deletedRowIds) {
          controls.write({ key, type: 'delete' })
        }
        for (const row of update.rows) {
          controls.write({ type: 'update', value: row })
        }
      }
      controls.commit()
      this.cursors[name] = update.cursor
      if (update.type === 'snapshot') {
        controls.markReady()
        this.receipts.reconcile(name)
      } else {
        this.receipts.observe(name, update.operationIds ?? [])
      }
    }

    const registration = { apply: apply as RegisteredTable['apply'] }
    if (this.tables.has(name)) {
      throw new Error(`Shared collection ${name} registered more than once`)
    }
    this.tables.set(name, registration)
    if (OPTIONAL_TABLES.has(name)) {
      controls.markReady()
    }
    return () => {
      if (this.tables.get(name) === registration) {
        this.tables.delete(name)
      }
    }
  }

  get isComplete(): boolean {
    return TABLE_ORDER.every((name) => this.tables.has(name))
  }

  apply(update: SharedStateUpdate): void {
    // Cross-collection publication is intentionally ordinary and deterministic.
    this.applyTable('labels', update.labels)
    this.applyTable('projects', update.projects)
    this.applyTable('reviewComments', update.reviewComments)
    this.applyTable('settings', update.settings)
    this.applyTable('tasks', update.tasks)
  }

  private applyTable<Row>(
    name: SharedCollectionName,
    update: TableUpdate<Row> | undefined
  ): void {
    if (update !== undefined) {
      this.tables.get(name)?.apply(update as TableUpdate<never>)
    }
  }
}

const makeSharedOptions = <Row extends object>(
  coordinator: SharedStateCoordinator,
  id: string,
  name: SharedCollectionName,
  getKey: (row: Row) => string,
  schema: Schema.Codec<Row, Row>
) => ({
  gcTime: 0,
  getKey,
  id,
  schema: Schema.toStandardSchemaV1(schema),
  startSync: false,
  sync: {
    rowUpdateMode: 'full' as const,
    sync: (controls: SyncControls<Row>) => coordinator.register(name, controls),
  },
})

export const createSharedCollectionBundle = (idSuffix = 'v1') => {
  const receipts = new OperationReceipts()
  const coordinator = new SharedStateCoordinator(receipts)
  const labelCollection = createCollection(
    makeSharedOptions<SharedLabelRow>(
      coordinator,
      `laborer.shared.labels.${idSuffix}`,
      'labels',
      ({ id }) => id,
      SharedLabelRowSchema
    )
  )
  const projectCollection = createCollection(
    makeSharedOptions<SharedProjectRow>(
      coordinator,
      `laborer.shared.projects.${idSuffix}`,
      'projects',
      ({ id }) => id,
      SharedProjectRowSchema
    )
  )
  // Threads travel whole — a row carries its reply chain — so an agent reply
  // written over MCP arrives here as an updated thread rather than as a row of
  // a separate replies table.
  const reviewCommentCollection = createCollection(
    makeSharedOptions<ReviewCommentThread>(
      coordinator,
      `laborer.shared.reviewComments.${idSuffix}`,
      'reviewComments',
      ({ id }) => id,
      ReviewCommentThreadSchema
    )
  )
  const settingCollection = createCollection(
    makeSharedOptions<SharedSettingRow>(
      coordinator,
      `laborer.shared.settings.${idSuffix}`,
      'settings',
      ({ key }) => key,
      SharedSettingRowSchema
    )
  )
  const taskCollection = createCollection(
    makeSharedOptions<SharedTaskRow>(
      coordinator,
      `laborer.shared.tasks.${idSuffix}`,
      'tasks',
      ({ id }) => id,
      SharedTaskRowSchema
    )
  )
  const collections = {
    labels: labelCollection,
    projects: projectCollection,
    reviewComments: reviewCommentCollection,
    settings: settingCollection,
    tasks: taskCollection,
  } as const

  let references = 0
  let sourceCleanup: (() => void) | undefined
  let cleanupGeneration = 0

  const stop = async () => {
    // Collection cleanup removes each sync-control registration synchronously.
    // Release the single Effect source only after the final registration is gone.
    const collectionCleanups: Promise<void>[] = []
    for (const name of TABLE_ORDER) {
      collectionCleanups.push(collections[name].cleanup())
    }
    sourceCleanup?.()
    sourceCleanup = undefined
    await Promise.all(collectionCleanups)
  }

  return {
    collections,
    activate(source: SharedStateSource): () => void {
      references += 1
      cleanupGeneration += 1
      if (sourceCleanup === undefined) {
        // Registration is synchronous. Opening the source before this complete
        // set exists would allow an initial snapshot to be lost.
        for (const name of TABLE_ORDER) {
          collections[name].startSyncImmediate()
        }
        if (!coordinator.isComplete) {
          throw new Error('Shared collection bundle registration is incomplete')
        }
        try {
          sourceCleanup = source.start((update) => coordinator.apply(update))
        } catch (error) {
          references -= 1
          stop().catch((cleanupError) => {
            queueMicrotask(() => {
              throw cleanupError
            })
          })
          throw error
        }
      }

      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        references -= 1
        const generation = ++cleanupGeneration
        // React StrictMode replays effects synchronously. Deferring final cleanup
        // keeps one source alive across that replay and lets direct live-query
        // consumers release their subscriptions before the base collections.
        setTimeout(() => {
          if (references === 0 && cleanupGeneration === generation) {
            stop().catch((error) => {
              queueMicrotask(() => {
                throw error
              })
            })
          }
        }, 0)
      }
    },
    registerOperationReceipt(
      operationId: string,
      affectedCollections: readonly SharedCollectionName[]
    ): OperationReceipt {
      return receipts.register(operationId, affectedCollections)
    },
  }
}

export const sharedCollectionBundle = createSharedCollectionBundle()
export const {
  labels: labelCollection,
  projects: projectCollection,
  reviewComments: reviewCommentCollection,
  settings: settingCollection,
  tasks: taskCollection,
} = sharedCollectionBundle.collections

/** Apply Laborer's durable project presentation order without changing rows. */
export const orderedProjectsFromRows = (
  projects: readonly SharedProjectRow[]
): readonly SharedProjectRow[] =>
  [...projects].sort((left, right) => {
    const leftRank = left.sortOrder ?? left.createdAt
    const rightRank = right.sortOrder ?? right.createdAt
    return leftRank - rightRank || left.id.localeCompare(right.id)
  })

/** Labels are app-wide and presented alphabetically wherever they are listed. */
export const orderedLabelsFromRows = (
  labels: readonly SharedLabelRow[]
): readonly SharedLabelRow[] =>
  [...labels].sort((left, right) => left.name.localeCompare(right.name))

/** Resolve stored label order, omitting relations not published yet. */
export const labelsForIds = (
  labelIds: readonly string[],
  labels: readonly SharedLabelRow[]
): readonly SharedLabelRow[] => {
  const byId = new Map(labels.map((label) => [label.id, label]))
  return labelIds.flatMap((id) => {
    const label = byId.get(id)
    return label === undefined ? [] : [label]
  })
}

/** Count app-wide task usage for each currently referenced Label. */
export const taskCountsByLabel = (
  tasks: readonly SharedTaskRow[]
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const labelId of task.labelIds) {
      counts.set(labelId, (counts.get(labelId) ?? 0) + 1)
    }
  }
  return counts
}

export interface WorkspaceView {
  readonly baseBranch: string | null
  readonly baseSha: string | null
  readonly branchName: string
  readonly createdAt: string
  readonly errorMessage: string | null
  readonly id: string
  readonly origin: 'laborer' | 'external'
  readonly parentTaskId: string | null
  /** How many reviewers' latest review is an approval. Null when never read. */
  readonly prApprovals: number | null
  readonly prBaseBranch: string | null
  readonly prCheckStatus: 'pending' | 'success' | 'failure' | null
  readonly prChecks: readonly PullRequestCheckRun[] | null
  readonly prIsDraft: boolean
  readonly prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly prNumber: number | null
  readonly projectId: string
  /** GitHub's rolled-up review verdict. Null when nobody's review is asked. */
  readonly prReviewDecision: PullRequestReviewDecision | null
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUnresolvedThreads: number | null
  readonly prUrl: string | null
  readonly status: string
  readonly taskNumber: number | null
  readonly taskSource: string
  readonly worktreePath: string
  readonly worktreeSetupStep: string | null
}

export const projectForRoot = <Project extends { readonly rootPath: string }>(
  rootPath: string,
  projects: readonly Project[]
): Project | undefined =>
  projects
    .filter(
      (project) =>
        project.rootPath === rootPath ||
        rootPath.startsWith(
          project.rootPath.endsWith('/')
            ? project.rootPath
            : `${project.rootPath}/`
        )
    )
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]

const workspaceStatus = (
  status: SharedTaskRow['worktreeStatus']
): WorkspaceView['status'] => {
  if (status === 'provisioning') {
    return 'creating'
  }
  return status === 'errored' ? 'errored' : 'running'
}

const rootWorkspaceView = (project: SharedProjectRow): WorkspaceView => ({
  baseBranch: null,
  baseSha: null,
  branchName: project.branchName ?? ROOT_WORKSPACE_BRANCH_LABEL,
  createdAt: String(project.createdAt),
  errorMessage: null,
  id: rootWorkspaceId(project.id),
  origin: 'external',
  parentTaskId: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  prApprovals: null,
  prReviewDecision: null,
  projectId: project.id,
  prState: null,
  prTitle: null,
  prUnresolvedThreads: null,
  prUrl: null,
  status: 'running',
  taskNumber: null,
  taskSource: rootWorkspaceId(project.id),
  worktreePath: project.rootPath,
  worktreeSetupStep: null,
})

export const workspaceViewsFromRows = (
  tasks: readonly SharedTaskRow[],
  projects: readonly SharedProjectRow[]
): readonly WorkspaceView[] => {
  const views: WorkspaceView[] = projects.map(rootWorkspaceView)
  for (const task of tasks) {
    if (task.worktreePath === null) {
      continue
    }
    const project = projectForRoot(task.rootPath, projects)
    if (project === undefined) {
      continue
    }
    views.push({
      baseBranch: task.baseBranch,
      baseSha: task.baseSha,
      branchName: task.branchName ?? task.title,
      createdAt: String(task.createdAt),
      errorMessage: task.worktreeError,
      id: task.id,
      origin: task.source === 'worktree' ? 'external' : 'laborer',
      parentTaskId: task.parentTaskId,
      prBaseBranch: task.prBaseBranch,
      prCheckStatus: task.prCheckStatus,
      prChecks: task.prChecks,
      prIsDraft: task.prIsDraft,
      prMergeStatus: task.prMergeStatus,
      prNumber: task.prNumber,
      prApprovals: task.prApprovals,
      prReviewDecision: task.prReviewDecision,
      projectId: project.id,
      prState: task.prState?.toUpperCase() ?? null,
      prTitle: task.prTitle,
      prUnresolvedThreads: task.prUnresolvedThreads,
      prUrl: task.prUrl,
      status: workspaceStatus(task.worktreeStatus),
      taskNumber: task.taskNumber,
      taskSource: task.id,
      worktreePath: task.worktreePath,
      worktreeSetupStep: null,
    })
  }
  return views
}
