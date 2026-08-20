import {
  projectIdFromRootWorkspaceId,
  ROOT_WORKSPACE_BRANCH_LABEL,
  rootWorkspaceId,
} from '@laborer/shared/root-workspace'
import type {
  LaborerTask,
  NativeLaborerDatabase,
  Project,
  PullRequestCheckRun,
} from './native-laborer-database.js'

/**
 * Runtime view of a task that currently owns a local worktree. Workspace is
 * UI vocabulary; task rows are the durable source of these facts.
 */
export interface WorkspaceRecord {
  readonly baseBranch: string | null
  readonly baseSha: string | null
  readonly branchName: string
  readonly createdAt: string
  readonly errorMessage: string | null
  readonly id: string
  readonly origin: 'laborer' | 'external'
  /** How many reviewers' latest review is an approval. Null when never read. */
  readonly prApprovals: number | null
  readonly prBaseBranch: string | null
  readonly prCheckStatus: 'pending' | 'success' | 'failure' | null
  readonly prChecks: readonly PullRequestCheckRun[] | null
  readonly prMergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly prNumber: number | null
  readonly projectId: string
  /** GitHub's rolled-up review verdict. Null when nobody's review is asked. */
  readonly prReviewDecision:
    | 'approved'
    | 'changesRequested'
    | 'reviewRequired'
    | null
  readonly prState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  readonly prTitle: string | null
  readonly prUnresolvedThreads: number | null
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
    baseBranch: task.baseBranch,
    baseSha: task.baseSha,
    // Detached worktrees have no branch. Keep their stable task title as the
    // display/runtime label, matching the renderer's task projection.
    branchName: task.branchName ?? task.title,
    createdAt: new Date(task.createdAt).toISOString(),
    errorMessage: task.worktreeError,
    id: task.id,
    origin: task.source === 'worktree' ? 'external' : 'laborer',
    prBaseBranch: task.prBaseBranch,
    prCheckStatus: task.prCheckStatus,
    prChecks: task.prChecks,
    prMergeStatus: task.prMergeStatus,
    prNumber: task.prNumber,
    prApprovals: task.prApprovals,
    prReviewDecision: task.prReviewDecision,
    prState: workspacePrState(task.prState),
    prTitle: task.prTitle,
    prUnresolvedThreads: task.prUnresolvedThreads,
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
  baseBranch: null,
  baseSha: null,
  branchName: project.branchName ?? ROOT_WORKSPACE_BRANCH_LABEL,
  createdAt: new Date(project.createdAt).toISOString(),
  errorMessage: null,
  id: rootWorkspaceId(project.id),
  origin: 'external',
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prMergeStatus: null,
  prNumber: null,
  prApprovals: null,
  prReviewDecision: null,
  prState: null,
  prTitle: null,
  prUnresolvedThreads: null,
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
