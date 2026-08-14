import {
  projectIdFromRootWorkspaceId,
  ROOT_WORKSPACE_BRANCH_LABEL,
  rootWorkspaceId,
} from '@laborer/shared/root-workspace'
import type {
  LaborerTask,
  NativeLaborerDatabase,
  Project,
} from './native-laborer-database.js'

/**
 * Runtime view of a task that currently owns a local worktree. Workspace is
 * UI vocabulary; task rows are the durable source of these facts.
 */
export interface WorkspaceRecord {
  readonly aheadCount: number | null
  readonly baseBranch: string | null
  readonly baseSha: string | null
  readonly behindCount: number | null
  readonly branchName: string
  readonly createdAt: string
  readonly errorMessage: string | null
  readonly id: string
  readonly origin: 'laborer' | 'external'
  readonly prBaseBranch: string | null
  readonly prCheckStatus: 'pending' | 'success' | 'failure' | null
  readonly prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly prNumber: number | null
  readonly projectId: string
  readonly prState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  readonly status: 'creating' | 'running' | 'errored'
  readonly taskSource: string
  readonly worktreePath: string
  readonly worktreeSetupStep: null
}

const projectForTask = (
  task: LaborerTask,
  projects: readonly Project[]
): Project | undefined =>
  projects
    .filter(
      (project) =>
        project.rootPath === task.rootPath ||
        task.rootPath.startsWith(
          project.rootPath.endsWith('/')
            ? project.rootPath
            : `${project.rootPath}/`
        )
    )
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]

const WORKSPACE_PR_STATES = {
  closed: 'CLOSED',
  merged: 'MERGED',
  open: 'OPEN',
} as const satisfies Record<
  NonNullable<LaborerTask['prState']>,
  NonNullable<WorkspaceRecord['prState']>
>

const workspacePrState = (
  state: LaborerTask['prState']
): WorkspaceRecord['prState'] =>
  state === null ? null : WORKSPACE_PR_STATES[state]

const toWorkspaceRecord = (
  task: LaborerTask,
  project: Project
): WorkspaceRecord | null => {
  if (task.worktreePath === null) {
    return null
  }
  let status: WorkspaceRecord['status'] = 'running'
  if (task.worktreeStatus === 'errored') {
    status = 'errored'
  } else if (task.worktreeStatus === 'provisioning') {
    status = 'creating'
  }
  return {
    aheadCount: null,
    baseBranch: task.baseBranch,
    baseSha: task.baseSha,
    behindCount: null,
    // Detached worktrees have no branch. Keep their stable task title as the
    // display/runtime label, matching the renderer's task projection.
    branchName: task.branchName ?? task.title,
    createdAt: new Date(task.createdAt).toISOString(),
    errorMessage: task.worktreeError,
    id: task.id,
    origin: task.source === 'worktree' ? 'external' : 'laborer',
    prBaseBranch: task.prBaseBranch,
    prCheckStatus: task.prCheckStatus,
    prMergeStatus: task.prMergeStatus,
    prNumber: task.prNumber,
    prState: workspacePrState(task.prState),
    prTitle: task.prTitle,
    prUrl: task.prUrl,
    projectId: project.id,
    status,
    taskSource: task.id,
    worktreePath: task.worktreePath,
    worktreeSetupStep: null,
  }
}

export const listWorkspaceRecords = (
  database: NativeLaborerDatabase
): readonly WorkspaceRecord[] => {
  const projects = database.listProjects()
  return database.listTasks().flatMap((task) => {
    const project = projectForTask(task, projects)
    if (project === undefined) {
      return []
    }
    const workspace = toWorkspaceRecord(task, project)
    return workspace === null ? [] : [workspace]
  })
}

/**
 * The project's main checkout as a synthetic workspace record. It never has
 * a task row — the reconciler skips `isMain` worktrees — so id-based
 * resolution (terminal spawn, file tree, editor, git actions) synthesizes it
 * from the project row. It is deliberately absent from
 * {@link listWorkspaceRecords} so polling services (PR watcher, branch
 * tracker, reconciler) never treat the main checkout as tracked work.
 */
const rootWorkspaceRecord = (project: Project): WorkspaceRecord => ({
  aheadCount: null,
  baseBranch: null,
  baseSha: null,
  behindCount: null,
  branchName: project.branchName ?? ROOT_WORKSPACE_BRANCH_LABEL,
  createdAt: new Date(project.createdAt).toISOString(),
  errorMessage: null,
  id: rootWorkspaceId(project.id),
  origin: 'external',
  prBaseBranch: null,
  prCheckStatus: null,
  prMergeStatus: null,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  projectId: project.id,
  status: 'running',
  taskSource: rootWorkspaceId(project.id),
  worktreePath: project.rootPath,
  worktreeSetupStep: null,
})

export const findWorkspaceRecord = (
  database: NativeLaborerDatabase,
  workspaceId: string
): WorkspaceRecord | null => {
  const rootProjectId = projectIdFromRootWorkspaceId(workspaceId)
  if (rootProjectId !== null) {
    const project = database
      .listProjects()
      .find(({ id }) => id === rootProjectId)
    return project === undefined ? null : rootWorkspaceRecord(project)
  }
  const task = database.findTask(workspaceId)
  if (task === null) {
    return null
  }
  const project = projectForTask(task, database.listProjects())
  return project === undefined ? null : toWorkspaceRecord(task, project)
}
