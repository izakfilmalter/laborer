import type {
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { Effect, Stream } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import { LaborerClient } from './laborer-client'

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
    context.set(
      authoritativeSharedStateAtom,
      applySharedStateUpdate(context.get(authoritativeSharedStateAtom), update)
    )
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
  return get(authoritativeTasksAtom).rows.map((row) => {
    const overlay = overlays.get(row.id)
    return overlay === undefined ? row : { ...row, ...overlay.patch }
  })
})
export const projectRowsAtom = Atom.make(
  (get) => get(authoritativeProjectsAtom).rows
)
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
  readonly prIsDraft: boolean
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
 * UI workspaces are streamed tasks that currently own a worktree. Tasks with
 * unknown project roots remain durable but stay hidden until that project is
 * registered again.
 */
export const workspaceViewsFromRows = (
  tasks: readonly SharedTaskRow[],
  projects: readonly SharedProjectRow[]
): readonly WorkspaceView[] => {
  const views: WorkspaceView[] = []

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
      prIsDraft: task.prIsDraft,
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

export const workspaceViewsAtom = Atom.make((get) =>
  workspaceViewsFromRows(get(taskRowsAtom), get(projectRowsAtom))
)
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

export const makeSharedStateEventsAtom = () =>
  LaborerClient.runtime.pull(
    LaborerClient.pipe(
      Effect.map((client) =>
        // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
        client('state.subscribe', undefined as void)
      ),
      Stream.unwrap
    ),
    { disableAccumulation: true }
  )
