import {
  ROOT_WORKSPACE_BRANCH_LABEL,
  rootWorkspaceId,
} from '@laborer/shared/root-workspace'
import type {
  PullRequestCheckRun,
  SharedLabelRow,
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { createCollection, type SyncConfig } from '@tanstack/db'

type TableName = 'labels' | 'projects' | 'settings' | 'tasks'
type TableUpdate<Row> = NonNullable<SharedStateUpdate[TableName]> & {
  readonly rows: readonly Row[]
}
type SyncControls<Row extends object> = Parameters<
  SyncConfig<Row, string>['sync']
>[0]

interface RegisteredTable {
  readonly apply: (update: TableUpdate<never>) => void
}

/**
 * Collection-local stream ordering. Snapshots replace membership even when a
 * reconnect starts from a lower cursor; deltas can only move forward.
 */
class SharedStateCoordinator {
  private readonly tables = new Map<TableName, RegisteredTable>()
  private readonly cursors: Record<TableName, number> = {
    labels: 0,
    projects: 0,
    settings: 0,
    tasks: 0,
  }

  register<Row extends object>(
    name: TableName,
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
      controls.markReady()
    }

    this.tables.set(name, { apply: apply as RegisteredTable['apply'] })
    return () => {
      this.tables.delete(name)
    }
  }

  apply(update: SharedStateUpdate): void {
    // Cross-collection publication is intentionally ordinary and deterministic.
    this.applyTable('labels', update.labels)
    this.applyTable('projects', update.projects)
    this.applyTable('settings', update.settings)
    this.applyTable('tasks', update.tasks)
  }

  private applyTable<Row>(
    name: TableName,
    update: TableUpdate<Row> | undefined
  ): void {
    if (update !== undefined) {
      this.tables.get(name)?.apply(update as TableUpdate<never>)
    }
  }
}

export const sharedStateCoordinator = new SharedStateCoordinator()

const sharedOptions = <Row extends object>(
  id: string,
  name: TableName,
  getKey: (row: Row) => string
) => ({
  gcTime: 0,
  getKey,
  id,
  startSync: false,
  sync: {
    rowUpdateMode: 'full' as const,
    sync: (controls: SyncControls<Row>) =>
      sharedStateCoordinator.register(name, controls),
  },
})

export const labelCollection = createCollection(
  sharedOptions<SharedLabelRow>(
    'laborer.shared.labels.v1',
    'labels',
    ({ id }) => id
  )
)
export const projectCollection = createCollection(
  sharedOptions<SharedProjectRow>(
    'laborer.shared.projects.v1',
    'projects',
    ({ id }) => id
  )
)
export const settingCollection = createCollection(
  sharedOptions<SharedSettingRow>(
    'laborer.shared.settings.v1',
    'settings',
    ({ key }) => key
  )
)
export const taskCollection = createCollection(
  sharedOptions<SharedTaskRow>(
    'laborer.shared.tasks.v1',
    'tasks',
    ({ id }) => id
  )
)

let preloadPromise: Promise<unknown> | undefined

/** Start all collection registrations before the shared RPC source is pulled. */
export const preloadSharedStateCollections = (): Promise<unknown> => {
  preloadPromise ??= Promise.all([
    labelCollection.preload(),
    projectCollection.preload(),
    settingCollection.preload(),
    taskCollection.preload(),
  ])
  return preloadPromise
}

export interface ProjectView extends SharedProjectRow {
  readonly repoPath: string
}

export const projectViewsFromRows = (
  projects: readonly SharedProjectRow[]
): readonly ProjectView[] =>
  [...projects]
    .sort((left, right) => {
      if (left.sortOrder !== null && right.sortOrder !== null) {
        return left.sortOrder - right.sortOrder
      }
      if (left.sortOrder !== null) {
        return -1
      }
      if (right.sortOrder !== null) {
        return 1
      }
      return left.createdAt - right.createdAt
    })
    .map((project) => ({ ...project, repoPath: project.rootPath }))

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
  readonly prChecks: readonly PullRequestCheckRun[] | null
  readonly prIsDraft: boolean
  readonly prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly prNumber: number | null
  readonly projectId: string
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  readonly status: string
  readonly taskNumber: number | null
  readonly taskSource: string
  readonly worktreePath: string
  readonly worktreeSetupStep: string | null
}

export const projectForRoot = (
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

const workspaceStatus = (
  status: SharedTaskRow['worktreeStatus']
): WorkspaceView['status'] => {
  if (status === 'provisioning') {
    return 'creating'
  }
  return status === 'errored' ? 'errored' : 'running'
}

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
  prChecks: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  projectId: project.id,
  prState: null,
  prTitle: null,
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
      prChecks: task.prChecks,
      prIsDraft: task.prIsDraft,
      prMergeStatus: task.prMergeStatus,
      prNumber: task.prNumber,
      projectId: project.id,
      prState: task.prState?.toUpperCase() ?? null,
      prTitle: task.prTitle,
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
