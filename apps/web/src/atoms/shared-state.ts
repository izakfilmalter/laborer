import {
  ROOT_WORKSPACE_BRANCH_LABEL,
  rootWorkspaceId,
} from '@laborer/shared/root-workspace'
import type {
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { Duration, Effect, Schedule, Stream } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import { LaborerClient } from './laborer-client'
import {
  applyTaskEditOverlays,
  mergePendingTaskRows,
  type PendingTaskRows,
  settleTaskCreateOverlays,
  settleTaskEditOverlays,
  type TaskEditOverlay,
  type TaskEditOverlays,
} from './optimistic-task-writes'
import {
  applyProjectRankOverlays,
  projectRankOverlaysAtom,
  settleProjectRankOverlays,
  sortProjectsByRank,
} from './project-order'

export interface AuthoritativeTable<Row> {
  readonly cursor: number
  readonly rows: readonly Row[]
}

export interface AuthoritativeSharedState {
  readonly projects: AuthoritativeTable<SharedProjectRow>
  readonly settings: AuthoritativeTable<SharedSettingRow>
  readonly tasks: AuthoritativeTable<SharedTaskRow>
}

export interface TaskOptimisticOverlay {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly patch: Pick<SharedTaskRow, 'sortOrder' | 'status'>
}

export interface TaskMutationReceipt {
  readonly mutationIds: readonly string[]
  readonly sequence: number
}

const initialState: AuthoritativeSharedState = {
  projects: { cursor: 0, rows: [] },
  settings: { cursor: 0, rows: [] },
  tasks: { cursor: 0, rows: [] },
}

type AnyTableUpdate<Row> =
  | {
      readonly cursor: number
      readonly rows: readonly Row[]
      readonly type: 'snapshot'
    }
  | {
      readonly cursor: number
      readonly deletedRowIds: readonly string[]
      readonly mutationIds?: readonly string[] | undefined
      readonly rows: readonly Row[]
      readonly type: 'delta'
    }

const applyTableUpdate = <Row>(
  current: AuthoritativeTable<Row>,
  update: AnyTableUpdate<Row>,
  id: (row: Row) => string
): AuthoritativeTable<Row> => {
  if (update.type === 'snapshot') {
    // A new subscription owns a fresh server cursor. Its snapshot remains
    // authoritative even when the database was replaced or its ledger was
    // pruned below the cursor retained by this renderer.
    return { cursor: update.cursor, rows: update.rows }
  }
  if (update.cursor <= current.cursor) {
    return current
  }
  const rows = new Map(current.rows.map((row) => [id(row), row]))
  for (const deletedId of update.deletedRowIds) {
    rows.delete(deletedId)
  }
  for (const row of update.rows) {
    rows.set(id(row), row)
  }
  return { cursor: update.cursor, rows: [...rows.values()] }
}

export const applySharedStateUpdate = (
  current: AuthoritativeSharedState,
  update: SharedStateUpdate
): AuthoritativeSharedState => ({
  projects:
    update.projects === undefined
      ? current.projects
      : applyTableUpdate(current.projects, update.projects, ({ id }) => id),
  settings:
    update.settings === undefined
      ? current.settings
      : applyTableUpdate(current.settings, update.settings, ({ key }) => key),
  tasks:
    update.tasks === undefined
      ? current.tasks
      : applyTableUpdate(current.tasks, update.tasks, ({ id }) => id),
})

export const authoritativeSharedStateAtom =
  Atom.make<AuthoritativeSharedState>(initialState)

/** Drag intent is deliberately separate from the authoritative stream. */
export const taskOptimisticOverlaysAtom = Atom.make<
  ReadonlyMap<string, TaskOptimisticOverlay>
>(new Map())

/**
 * Cards the composer committed that the authoritative stream has not stored
 * yet, keyed by their renderer-minted ULID. The card renders from this row
 * instantly; the id is shared with the server, so the authoritative row
 * replaces it in place without re-keying the card.
 */
export const taskCreateOverlaysAtom = Atom.make<PendingTaskRows>(new Map())

/**
 * In-flight title/description saves, keyed by task id. The board and the
 * detail dialog read the edited values immediately; the overlay settles when
 * the authoritative row leaves the revision the draft was based on.
 */
export const taskEditOverlaysAtom = Atom.make<TaskEditOverlays>(new Map())

/**
 * Task IDs whose workspaces are being destroyed optimistically. The card
 * leaves the sidebar the moment destruction is confirmed in the dialog; the
 * server clears the row's worktree only after its background git cleanup
 * finishes, so without this overlay the card would linger for seconds.
 */
export const workspaceDestroyOverlaysAtom = Atom.make<ReadonlySet<string>>(
  new Set<string>()
)

/**
 * Project IDs being removed optimistically. The sidebar group disappears
 * immediately; the authoritative deletion delta settles the overlay.
 */
export const projectRemoveOverlaysAtom = Atom.make<ReadonlySet<string>>(
  new Set<string>()
)

const withMember = (
  current: ReadonlySet<string>,
  member: string
): ReadonlySet<string> => {
  if (current.has(member)) {
    return current
  }
  const next = new Set(current)
  next.add(member)
  return next
}

const withoutMember = (
  current: ReadonlySet<string>,
  member: string
): ReadonlySet<string> => {
  if (!current.has(member)) {
    return current
  }
  const next = new Set(current)
  next.delete(member)
  return next
}

export const installWorkspaceDestroyOverlayAtom = Atom.writable(
  (get) => get(workspaceDestroyOverlaysAtom),
  (context, taskId: string) => {
    context.set(
      workspaceDestroyOverlaysAtom,
      withMember(context.get(workspaceDestroyOverlaysAtom), taskId)
    )
  }
)

/** Restores the card after a rejected destroy (e.g. a dirty worktree). */
export const clearWorkspaceDestroyOverlayAtom = Atom.writable(
  (get) => get(workspaceDestroyOverlaysAtom),
  (context, taskId: string) => {
    context.set(
      workspaceDestroyOverlaysAtom,
      withoutMember(context.get(workspaceDestroyOverlaysAtom), taskId)
    )
  }
)

export const installProjectRemoveOverlayAtom = Atom.writable(
  (get) => get(projectRemoveOverlaysAtom),
  (context, projectId: string) => {
    context.set(
      projectRemoveOverlaysAtom,
      withMember(context.get(projectRemoveOverlaysAtom), projectId)
    )
  }
)

/** Restores the project group after a rejected removal. */
export const clearProjectRemoveOverlayAtom = Atom.writable(
  (get) => get(projectRemoveOverlaysAtom),
  (context, projectId: string) => {
    context.set(
      projectRemoveOverlaysAtom,
      withoutMember(context.get(projectRemoveOverlaysAtom), projectId)
    )
  }
)

/** The composer commits a card: it renders from this row until stored. */
export const installTaskCreateOverlayAtom = Atom.writable(
  (get) => get(taskCreateOverlaysAtom),
  (context, row: SharedTaskRow) => {
    const next = new Map(context.get(taskCreateOverlaysAtom))
    next.set(row.id, row)
    context.set(taskCreateOverlaysAtom, next)
  }
)

/** Withdraws a card whose create the server definitively rejected. */
export const clearTaskCreateOverlayAtom = Atom.writable(
  (get) => get(taskCreateOverlaysAtom),
  (context, taskId: string) => {
    const overlays = context.get(taskCreateOverlaysAtom)
    if (!overlays.has(taskId)) {
      return
    }
    const next = new Map(overlays)
    next.delete(taskId)
    context.set(taskCreateOverlaysAtom, next)
  }
)

/** Save commits an edit: the board shows it while the write is in flight. */
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

/** Reverts a rejected edit so the authoritative values show again. */
export const clearTaskEditOverlayAtom = Atom.writable(
  (get) => get(taskEditOverlaysAtom),
  (context, taskId: string) => {
    const overlays = context.get(taskEditOverlaysAtom)
    if (!overlays.has(taskId)) {
      return
    }
    const next = new Map(overlays)
    next.delete(taskId)
    context.set(taskEditOverlaysAtom, next)
  }
)

/**
 * A destroy overlay lives exactly as long as the authoritative row still owns
 * a worktree. Settling on the authoritative row — rather than on the RPC
 * response — means the card can never flash back between the response and the
 * subscription delta, and a stale overlay can never hide a task whose
 * worktree was later re-provisioned.
 */
export const settleWorkspaceDestroyOverlays = (
  overlays: ReadonlySet<string>,
  tasks: readonly SharedTaskRow[]
): ReadonlySet<string> => {
  if (overlays.size === 0) {
    return overlays
  }
  const rowsById = new Map(tasks.map((row) => [row.id, row]))
  const next = new Set<string>()
  for (const taskId of overlays) {
    const row = rowsById.get(taskId)
    if (row !== undefined && row.worktreePath !== null) {
      next.add(taskId)
    }
  }
  return next.size === overlays.size ? overlays : next
}

/** A remove overlay settles once the authoritative project row is gone. */
export const settleProjectRemoveOverlays = (
  overlays: ReadonlySet<string>,
  projects: readonly SharedProjectRow[]
): ReadonlySet<string> => {
  if (overlays.size === 0) {
    return overlays
  }
  const alive = new Set(projects.map(({ id }) => id))
  const next = new Set<string>()
  for (const projectId of overlays) {
    if (alive.has(projectId)) {
      next.add(projectId)
    }
  }
  return next.size === overlays.size ? overlays : next
}

/** A bounded notification edge used to release transport-ambiguous moves. */
export const taskMutationReceiptAtom = Atom.make<TaskMutationReceipt>({
  mutationIds: [],
  sequence: 0,
})

export const settleTaskOverlays = (
  current: ReadonlyMap<string, TaskOptimisticOverlay>,
  mutationIds: readonly string[]
): ReadonlyMap<string, TaskOptimisticOverlay> => {
  const settled = new Set(mutationIds)
  const overlays = new Map(current)
  for (const [taskId, overlay] of overlays) {
    if (settled.has(overlay.mutationId)) {
      overlays.delete(taskId)
    }
  }
  return overlays
}

export const installSharedStateUpdateAtom = Atom.writable(
  (get) => get(authoritativeSharedStateAtom),
  (context, update: SharedStateUpdate) => {
    const state = applySharedStateUpdate(
      context.get(authoritativeSharedStateAtom),
      update
    )
    context.set(authoritativeSharedStateAtom, state)
    const createOverlays = settleTaskCreateOverlays(
      context.get(taskCreateOverlaysAtom),
      state.tasks.rows
    )
    if (createOverlays !== context.get(taskCreateOverlaysAtom)) {
      context.set(taskCreateOverlaysAtom, createOverlays)
    }
    const editOverlays = settleTaskEditOverlays(
      context.get(taskEditOverlaysAtom),
      state.tasks.rows
    )
    if (editOverlays !== context.get(taskEditOverlaysAtom)) {
      context.set(taskEditOverlaysAtom, editOverlays)
    }
    const destroyOverlays = settleWorkspaceDestroyOverlays(
      context.get(workspaceDestroyOverlaysAtom),
      state.tasks.rows
    )
    if (destroyOverlays !== context.get(workspaceDestroyOverlaysAtom)) {
      context.set(workspaceDestroyOverlaysAtom, destroyOverlays)
    }
    const removeOverlays = settleProjectRemoveOverlays(
      context.get(projectRemoveOverlaysAtom),
      state.projects.rows
    )
    if (removeOverlays !== context.get(projectRemoveOverlaysAtom)) {
      context.set(projectRemoveOverlaysAtom, removeOverlays)
    }
    const rankOverlays = settleProjectRankOverlays(
      context.get(projectRankOverlaysAtom),
      state.projects.rows
    )
    if (rankOverlays !== context.get(projectRankOverlaysAtom)) {
      context.set(projectRankOverlaysAtom, rankOverlays)
    }
    const mutationIds =
      update.tasks?.type === 'delta' ? (update.tasks.mutationIds ?? []) : []
    if (mutationIds.length === 0) {
      return
    }
    const overlays = settleTaskOverlays(
      context.get(taskOptimisticOverlaysAtom),
      mutationIds
    )
    context.set(taskOptimisticOverlaysAtom, overlays)
    const receipt = context.get(taskMutationReceiptAtom)
    context.set(taskMutationReceiptAtom, {
      mutationIds,
      sequence: receipt.sequence + 1,
    })
  }
)

export const installTaskOptimisticOverlayAtom = Atom.writable(
  (get) => get(taskOptimisticOverlaysAtom),
  (
    context,
    input: { readonly taskId: string; readonly overlay: TaskOptimisticOverlay }
  ) => {
    const overlays = new Map(context.get(taskOptimisticOverlaysAtom))
    overlays.set(input.taskId, input.overlay)
    context.set(taskOptimisticOverlaysAtom, overlays)
  }
)

export const clearTaskOptimisticOverlayAtom = Atom.writable(
  (get) => get(taskOptimisticOverlaysAtom),
  (
    context,
    input: { readonly mutationId: string; readonly taskId: string }
  ) => {
    const overlays = context.get(taskOptimisticOverlaysAtom)
    if (overlays.get(input.taskId)?.mutationId !== input.mutationId) {
      return
    }
    const next = new Map(overlays)
    next.delete(input.taskId)
    context.set(taskOptimisticOverlaysAtom, next)
  }
)

export const confirmAuthoritativeTask = (
  state: AuthoritativeSharedState,
  input: { readonly row: SharedTaskRow }
): AuthoritativeSharedState => {
  const current = state.tasks.rows.find(({ id }) => id === input.row.id)
  if (current !== undefined && input.row.revision < current.revision) {
    return state
  }
  const rows = new Map(state.tasks.rows.map((row) => [row.id, row]))
  rows.set(input.row.id, input.row)
  return {
    ...state,
    tasks: {
      // An RPC response confirms one row, not every ledger entry through its
      // cursor. Only the subscription may advance the table cursor, otherwise
      // its next multi-row delta could be mistaken for a duplicate and lost.
      cursor: state.tasks.cursor,
      rows: [...rows.values()],
    },
  }
}

export const confirmTaskOptimisticMoveAtom = Atom.writable(
  (get) => get(authoritativeSharedStateAtom),
  (
    context,
    input: {
      readonly cursor: number
      readonly mutationId: string
      readonly row: SharedTaskRow
    }
  ) => {
    const state = context.get(authoritativeSharedStateAtom)
    context.set(
      authoritativeSharedStateAtom,
      confirmAuthoritativeTask(state, input)
    )
    const overlays = context.get(taskOptimisticOverlaysAtom)
    if (overlays.get(input.row.id)?.mutationId === input.mutationId) {
      const next = new Map(overlays)
      next.delete(input.row.id)
      context.set(taskOptimisticOverlaysAtom, next)
    }
  }
)

export const authoritativeTasksAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).tasks
)
export const authoritativeProjectsAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).projects
)
export const authoritativeSettingsAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).settings
)

export const taskRowsAtom = Atom.make((get) => {
  const overlays = get(taskOptimisticOverlaysAtom)
  const stored = mergePendingTaskRows(
    get(authoritativeTasksAtom).rows,
    get(taskCreateOverlaysAtom)
  )
  const moved = stored.map((row) => {
    const overlay = overlays.get(row.id)
    return overlay === undefined ? row : { ...row, ...overlay.patch }
  })
  return applyTaskEditOverlays(moved, get(taskEditOverlaysAtom))
})
/**
 * Every project surface reads this, so the manual order is applied once: the
 * ranks a drag is promising win over the stored ones, and the same comparator
 * the server uses turns both into the order on screen.
 */
export const projectRowsAtom = Atom.make((get) => {
  const removing = get(projectRemoveOverlaysAtom)
  const rows = get(authoritativeProjectsAtom).rows
  const visible =
    removing.size === 0 ? rows : rows.filter(({ id }) => !removing.has(id))
  return sortProjectsByRank(
    applyProjectRankOverlays(visible, get(projectRankOverlaysAtom))
  )
})
/** Legacy renderer shape while workspace surfaces still call the root repoPath. */
export const projectViewsAtom = Atom.make((get) =>
  get(projectRowsAtom).map((project) => ({
    ...project,
    repoPath: project.rootPath,
  }))
)

export interface WorkspaceView {
  readonly aheadCount: number | null
  readonly baseBranch: string | null
  readonly baseSha: string | null
  readonly behindCount: number | null
  readonly branchName: string
  readonly createdAt: string
  readonly errorMessage: string | null
  readonly id: string
  readonly origin: 'laborer' | 'external'
  readonly parentTaskId: string | null
  readonly prBaseBranch: string | null
  readonly prCheckStatus: 'pending' | 'success' | 'failure' | null
  readonly prIsDraft: boolean
  readonly prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly prNumber: number | null
  readonly projectId: string
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  readonly status: string
  readonly taskSource: string
  readonly worktreePath: string
  readonly worktreeSetupStep: string | null
}

const projectForRoot = (
  rootPath: string,
  projects: readonly SharedProjectRow[]
): SharedProjectRow | undefined =>
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

/**
 * A task that owns a worktree path is running unless its lifecycle column
 * says otherwise. Rows written before the `worktree_status` column existed
 * carry NULL with a live path, so NULL means running — the same reading as
 * the server's workspace records.
 */
const workspaceStatus = (
  status: SharedTaskRow['worktreeStatus']
): WorkspaceView['status'] => {
  if (status === 'provisioning') {
    return 'creating'
  }
  return status === 'errored' ? 'errored' : 'running'
}

/**
 * The project's main checkout as a workspace view. It has no task row — the
 * reconciler deliberately never adopts the main worktree — so it is
 * synthesized from the project row with the shared root-workspace id. The
 * server's `findWorkspaceRecord` mirrors this synthesis, which is what lets
 * terminals, the file tree, and git actions resolve the synthetic id.
 */
const rootWorkspaceView = (project: SharedProjectRow): WorkspaceView => ({
  aheadCount: null,
  baseBranch: null,
  baseSha: null,
  behindCount: null,
  branchName: project.branchName ?? ROOT_WORKSPACE_BRANCH_LABEL,
  createdAt: String(project.createdAt),
  errorMessage: null,
  id: rootWorkspaceId(project.id),
  origin: 'external',
  parentTaskId: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  projectId: project.id,
  prState: null,
  prTitle: null,
  prUrl: null,
  status: 'running',
  taskSource: rootWorkspaceId(project.id),
  worktreePath: project.rootPath,
  worktreeSetupStep: null,
})

/**
 * UI workspaces are streamed tasks that currently own a worktree, plus one
 * synthetic root workspace per registered project (the main checkout, which
 * never has a task row). Roots come first so each project's sidebar tree
 * keeps its root workspace at the top. Tasks with unknown project roots
 * remain durable but stay hidden until that project is registered again.
 */
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
    if (!project) {
      continue
    }
    views.push({
      aheadCount: null,
      baseBranch: task.baseBranch,
      baseSha: task.baseSha,
      behindCount: null,
      branchName: task.branchName ?? task.title,
      createdAt: String(task.createdAt),
      errorMessage: task.worktreeError,
      id: task.id,
      origin: task.source === 'worktree' ? 'external' : 'laborer',
      parentTaskId: task.parentTaskId,
      prBaseBranch: task.prBaseBranch,
      prCheckStatus: task.prCheckStatus,
      prIsDraft: task.prIsDraft,
      prMergeStatus: task.prMergeStatus,
      prNumber: task.prNumber,
      projectId: project.id,
      prState: task.prState?.toUpperCase() ?? null,
      prTitle: task.prTitle,
      prUrl: task.prUrl,
      status: workspaceStatus(task.worktreeStatus),
      taskSource: task.id,
      worktreePath: task.worktreePath,
      worktreeSetupStep: null,
    })
  }

  return views
}

export const workspaceViewsAtom = Atom.make((get) => {
  const destroying = get(workspaceDestroyOverlaysAtom)
  const views = workspaceViewsFromRows(get(taskRowsAtom), get(projectRowsAtom))
  return destroying.size === 0
    ? views
    : views.filter(({ id }) => !destroying.has(id))
})
export const settingRowsAtom = Atom.make(
  (get) => get(authoritativeSettingsAtom).rows
)
export const tasksByIdAtom = Atom.make(
  (get) => new Map(get(taskRowsAtom).map((task) => [task.id, task]))
)
export const projectsByIdAtom = Atom.make(
  (get) => new Map(get(projectRowsAtom).map((project) => [project.id, project]))
)
export const settingsByKeyAtom = Atom.make(
  (get) =>
    new Map(get(settingRowsAtom).map((setting) => [setting.key, setting]))
)

export const SHARED_STATE_RESUBSCRIBE_INITIAL_DELAY_MS = 500
export const SHARED_STATE_RESUBSCRIBE_MAX_DELAY_MS = 10_000
export const SHARED_STATE_RESUBSCRIBE_RESET_AFTER_MS = 60_000

/**
 * The app owns ONE shared-state subscription for its whole lifetime. When the
 * MessagePort closes — for example, when the utility process restarts — the in-flight
 * `state.subscribe` stream fails, and without a retry the renderer would keep
 * presenting its last projection forever while mutations kept landing in the
 * shared database (the "created tasks never appear on the board" failure).
 *
 * This schedule must
 * never terminate. Each retry opens a fresh subscription whose snapshot is
 * authoritative, so no delta lost during the outage is ever needed. The
 * custom Effect 4 schedule caps its exponential delay and periodically
 * rewinds the backoff.
 */
export const sharedStateResubscribeSchedule = Schedule.fromStepWithMetadata(
  Effect.sync(() => {
    let sequenceStartedAt: number | undefined
    let attempt = 0

    return (metadata: Schedule.InputMetadata<unknown>) => {
      if (
        sequenceStartedAt === undefined ||
        metadata.now - sequenceStartedAt >=
          SHARED_STATE_RESUBSCRIBE_RESET_AFTER_MS
      ) {
        sequenceStartedAt = metadata.now
        attempt = 0
      }
      const delay = Math.min(
        SHARED_STATE_RESUBSCRIBE_INITIAL_DELAY_MS * 2 ** attempt,
        SHARED_STATE_RESUBSCRIBE_MAX_DELAY_MS
      )
      attempt += 1
      return Effect.succeed([delay, Duration.millis(delay)] as [
        number,
        Duration.Duration,
      ])
    }
  })
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
        Effect.sync(() => {
          console.warn(
            '[shared-state] subscription failed — resubscribing for a fresh snapshot',
            error
          )
        })
      ),
      Stream.retry(sharedStateResubscribeSchedule)
    ),
    { disableAccumulation: true }
  )
