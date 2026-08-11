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
  projects.find((project) => project.rootPath === task.rootPath)

const toWorkspaceRecord = (
  task: LaborerTask,
  project: Project
): WorkspaceRecord | null => {
  if (task.worktreePath === null || task.branchName === null) {
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
    branchName: task.branchName,
    createdAt: new Date(task.createdAt).toISOString(),
    errorMessage: task.worktreeError,
    id: task.id,
    origin: task.source === 'worktree' ? 'external' : 'laborer',
    prNumber: task.prNumber,
    prState: task.prState?.toUpperCase() as WorkspaceRecord['prState'],
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

export const findWorkspaceRecord = (
  database: NativeLaborerDatabase,
  workspaceId: string
): WorkspaceRecord | null => {
  const task = database.findTask(workspaceId)
  if (task === null) {
    return null
  }
  const project = projectForTask(task, database.listProjects())
  return project === undefined ? null : toWorkspaceRecord(task, project)
}
