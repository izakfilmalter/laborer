import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LABEL_COLORS, labelColorForName } from '@laborer/shared/labels'
import type { LabelColor } from '@laborer/shared/rpc'
import { parseLabelIds, serializeLabelIds } from '@laborer/task-db'
import { DatabaseSync } from '@laborer/task-db/database-sync'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { notifyLaborerDatabaseWrite } from './laborer-database-wakeup.js'
import {
  decodeReviewCommentReplyRow,
  decodeReviewCommentThreadRow,
  MAX_REVIEW_COMMENT_REPLIES,
  type NewReviewCommentReply,
  type NewReviewCommentThread,
  type ReviewCommentAuthor,
  ReviewCommentAuthorMismatchError,
  ReviewCommentInvalidError,
  ReviewCommentNotFoundError,
  type ReviewCommentReply,
  type ReviewCommentStatus,
  type ReviewCommentThread,
  reviewCommentBody,
  validateNewReviewCommentThread,
} from './review-comments.js'

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'
export type TaskSource =
  | 'execution'
  | 'manual'
  | 'slack_url'
  | 'agent'
  | 'worktree'
export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs-attention'
export type WorktreeStatus = 'provisioning' | 'ready' | 'errored'
export type PullRequestState = 'open' | 'closed' | 'merged'
export type PullRequestMergeStatus = 'clean' | 'conflicting' | 'unknown'
export type PullRequestCheckStatus = 'pending' | 'success' | 'failure'
export type PullRequestReviewDecision =
  | 'approved'
  | 'changesRequested'
  | 'reviewRequired'
export type PullRequestCheckRunBucket =
  | 'success'
  | 'failure'
  | 'pending'
  | 'skipped'
  | 'cancelled'

export const PULL_REQUEST_CHECK_RUN_BUCKETS = [
  'success',
  'failure',
  'pending',
  'skipped',
  'cancelled',
] as const satisfies readonly PullRequestCheckRunBucket[]

/**
 * One check behind a pull request's rolled-up check status, as GitHub reports
 * it. Kept denormalized on the task row so the UI can explain a red rollup
 * without a second round trip to `gh`.
 */
export interface PullRequestCheckRun {
  readonly bucket: PullRequestCheckRunBucket
  /** Wall-clock run time, when GitHub reported both ends of it. */
  readonly durationMs: number | null
  /** Workflow or app the check belongs to, used to group the list. */
  readonly group: string | null
  readonly name: string
  readonly url: string | null
}

/** Row-size bound. A PR with more checks than this shows the first ones. */
export const MAX_PULL_REQUEST_CHECK_RUNS = 60

export interface LaborerTask {
  readonly actionName: string | null
  readonly baseBranch: string | null
  readonly baseSha: string | null
  readonly branchName: string | null
  readonly createdAt: number
  readonly description: string | null
  readonly executionId: string | null
  readonly executionStatus: ExecutionStatus | null
  readonly id: string
  /** Ids of the labels applied to this task, in application order. */
  readonly labelIds: readonly string[]
  readonly parentTaskId: string | null
  /**
   * How many reviewers' standing opinion is an approval. Null when never
   * read.
   */
  readonly prApprovals: number | null
  /** GitHub login of whoever opened the pull request. Null when unattributed. */
  readonly prAuthorLogin: string | null
  readonly prBaseBranch: string | null
  readonly prCheckStatus: PullRequestCheckStatus | null
  readonly prChecks: readonly PullRequestCheckRun[] | null
  readonly prIsDraft: boolean
  readonly prMergeStatus: PullRequestMergeStatus | null
  readonly prNumber: number | null
  /** GitHub's rolled-up review verdict. Null when nobody's review is asked. */
  readonly prReviewDecision: PullRequestReviewDecision | null
  readonly prState: PullRequestState | null
  readonly prTitle: string | null
  /**
   * Review threads still awaiting resolution. Null means never read — a
   * closed pull request or a branch without one — which reads differently
   * from zero, where every thread has been settled.
   */
  readonly prUnresolvedThreads: number | null
  readonly prUrl: string | null
  readonly revision: number
  readonly rootPath: string
  readonly setupCompletedAt: number | null
  readonly slackPermalink: string | null
  readonly sortOrder: number | null
  readonly source: TaskSource
  readonly status: TaskStatus
  readonly taskNumber: number
  readonly title: string
  readonly updatedAt: number
  readonly worktreeError: string | null
  readonly worktreePath: string | null
  readonly worktreeStatus: WorktreeStatus | null
}

export interface NewLaborerTask {
  readonly actionName?: string | null
  readonly baseBranch?: string | null
  readonly baseSha?: string | null
  readonly branchName?: string | null
  readonly createdAt?: number
  readonly description?: string | null
  readonly executionId?: string | null
  readonly executionStatus?: ExecutionStatus | null
  readonly id: string
  /** Labels to apply as the row is inserted; every id must already exist. */
  readonly labelIds?: readonly string[]
  readonly parentTaskId?: string | null
  readonly prApprovals?: number | null
  readonly prAuthorLogin?: string | null
  readonly prBaseBranch?: string | null
  readonly prCheckStatus?: PullRequestCheckStatus | null
  readonly prChecks?: readonly PullRequestCheckRun[] | null
  readonly prIsDraft?: boolean
  readonly prMergeStatus?: PullRequestMergeStatus | null
  readonly prNumber?: number | null
  readonly prReviewDecision?: PullRequestReviewDecision | null
  readonly prState?: PullRequestState | null
  readonly prTitle?: string | null
  readonly prUnresolvedThreads?: number | null
  readonly prUrl?: string | null
  readonly rootPath: string
  readonly setupCompletedAt?: number | null
  readonly slackPermalink?: string | null
  readonly sortOrder?: number | null
  readonly source: TaskSource
  readonly status: TaskStatus
  readonly title: string
  readonly worktreeError?: string | null
  readonly worktreePath?: string | null
  readonly worktreeStatus?: WorktreeStatus | null
}

export type LaborerTaskPatch = Partial<
  Pick<
    LaborerTask,
    | 'actionName'
    | 'baseBranch'
    | 'baseSha'
    | 'branchName'
    | 'description'
    | 'executionId'
    | 'executionStatus'
    | 'parentTaskId'
    | 'prAuthorLogin'
    | 'prBaseBranch'
    | 'prCheckStatus'
    | 'prChecks'
    | 'prIsDraft'
    | 'prMergeStatus'
    | 'prNumber'
    | 'prApprovals'
    | 'prReviewDecision'
    | 'prState'
    | 'prTitle'
    | 'prUnresolvedThreads'
    | 'prUrl'
    | 'rootPath'
    | 'setupCompletedAt'
    | 'slackPermalink'
    | 'sortOrder'
    | 'status'
    | 'title'
    | 'worktreeError'
    | 'worktreePath'
    | 'worktreeStatus'
  >
>

export interface Project {
  readonly branchName: string | null
  readonly canonicalGitCommonDir: string
  /**
   * Accent token from the shared project palette. Null for rows written
   * before accents existed; readers derive one from the name.
   */
  readonly color: string | null
  readonly createdAt: number
  /** The repository's favicon inlined as a `data:` URL, when one was found. */
  readonly iconDataUrl: string | null
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly revision: number
  readonly rootPath: string
  /** Manual rank. Null means unranked; ordering then falls back to createdAt. */
  readonly sortOrder: number | null
  readonly updatedAt: number
}

export interface NewProject {
  readonly branchName?: string | null
  readonly canonicalGitCommonDir: string
  readonly color?: string | null
  readonly createdAt?: number
  readonly iconDataUrl?: string | null
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly rootPath: string
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'branchName'
    | 'canonicalGitCommonDir'
    | 'color'
    | 'iconDataUrl'
    | 'name'
    | 'repoId'
    | 'rootPath'
    | 'sortOrder'
  >
>

export interface AppSetting {
  readonly createdAt: number
  readonly key: string
  readonly revision: number
  readonly updatedAt: number
  readonly value: string
}

/** A label, shared app-wide across every project. */
export interface Label {
  readonly color: LabelColor
  readonly createdAt: number
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly updatedAt: number
}

export interface NewLabel {
  readonly color?: LabelColor
  readonly createdAt?: number
  /** Client-minted id. Re-sending a stored id is an idempotent no-op. */
  readonly id?: string
  readonly name: string
}

export interface LabelPatch {
  readonly color?: LabelColor
  readonly name?: string
}

export interface MutationResult<Row> {
  readonly cursor: number
  readonly row: Row
}

export interface ProjectReorderAssignment {
  readonly expectedRevision: number
  readonly projectId: string
  readonly sortOrder: number | null
}

export interface ProjectReorderResult {
  readonly cursor: number
  readonly rows: readonly Project[]
}

export interface TaskChange {
  readonly changedAt: number
  readonly operationId: string | null
  readonly sequence: number
  readonly taskId: string
}

export interface StateChange {
  readonly changedAt: number
  readonly operationId: string | null
  readonly rowId: string
  readonly sequence: number
  readonly tableName: StateChangeTable
}

export type StateChangeTable =
  | 'projects'
  | 'app_settings'
  | 'labels'
  | 'review_comment_threads'

const STATE_CHANGE_TABLES = [
  'projects',
  'app_settings',
  'labels',
  'review_comment_threads',
] as const satisfies readonly StateChangeTable[]

export interface LaborerDatabaseSnapshot {
  readonly labels: readonly Label[]
  readonly projects: readonly Project[]
  /** Every review conversation, each carrying its whole reply chain. */
  readonly reviewComments: readonly ReviewCommentThread[]
  readonly settings: readonly AppSetting[]
  readonly stateCursor: number
  readonly taskCursor: number
  readonly tasks: readonly LaborerTask[]
}

export interface NativeTableUpdate<Row> {
  readonly cursor: number
  readonly deletedRowIds: readonly string[]
  readonly operationIds: readonly string[]
  readonly rows: readonly Row[]
  readonly type: 'delta'
}

export interface NativeStateUpdates {
  readonly labels: NativeTableUpdate<Label>
  readonly projects: NativeTableUpdate<Project>
  readonly reviewComments: NativeTableUpdate<ReviewCommentThread>
  readonly settings: NativeTableUpdate<AppSetting>
}

export class LaborerDatabaseCursorGapError extends Error {
  readonly _tag = 'LaborerDatabaseCursorGapError'
  readonly cursor: number
  readonly ledger: string
  constructor(ledger: string, cursor: number) {
    super(`Laborer database ${ledger} cannot continue after cursor ${cursor}`)
    this.cursor = cursor
    this.ledger = ledger
  }
}

export class LaborerDatabaseSchemaTooNewError extends Error {
  readonly _tag = 'LaborerDatabaseSchemaTooNewError'
  readonly migration: string
  constructor(migration: string) {
    super(`Laborer database schema is newer than this binary: ${migration}`)
    this.migration = migration
  }
}

export class LaborerDatabaseBusyError extends Error {
  readonly _tag = 'LaborerDatabaseBusyError'
  override readonly cause: unknown
  readonly attempts: number
  constructor(attempts: number, cause: unknown) {
    super(`Laborer database remained busy after ${attempts} attempts`)
    this.attempts = attempts
    this.cause = cause
  }
}

export type LaborerDatabaseTable =
  | 'tasks'
  | 'projects'
  | 'app_settings'
  | 'labels'
  | 'review_comment_threads'
  | 'review_comment_replies'

/** A label name already taken, case-insensitively, app-wide. */
export class LaborerDatabaseLabelNameConflictError extends Error {
  readonly _tag = 'LaborerDatabaseLabelNameConflictError'
  readonly existing: Label | null
  readonly labelName: string
  constructor(labelName: string, existing: Label | null) {
    super(`A label named ${labelName} already exists`)
    this.labelName = labelName
    this.existing = existing
  }
}

/** A task tried to carry label ids that do not exist. */
export class LaborerDatabaseUnknownLabelError extends Error {
  readonly _tag = 'LaborerDatabaseUnknownLabelError'
  readonly labelIds: readonly string[]
  readonly taskId: string
  constructor(taskId: string, labelIds: readonly string[]) {
    super(`Unknown labels for task ${taskId}: ${labelIds.join(', ')}`)
    this.taskId = taskId
    this.labelIds = labelIds
  }
}

export class LaborerDatabaseStaleRevisionError<Row> extends Error {
  readonly _tag = 'LaborerDatabaseStaleRevisionError'
  readonly current: Row | null
  /** `null` when the caller asked for last-write-wins and the row was gone. */
  readonly expectedRevision: number | null
  readonly rowId: string
  readonly table: LaborerDatabaseTable
  constructor(
    table: LaborerDatabaseTable,
    rowId: string,
    expectedRevision: number | null,
    current: Row | null
  ) {
    super(
      expectedRevision === null
        ? `${table} row ${rowId} does not exist`
        : `${table} row ${rowId} no longer has revision ${expectedRevision}`
    )
    this.table = table
    this.rowId = rowId
    this.expectedRevision = expectedRevision
    this.current = current
  }
}

export interface LaborerDatabaseOptions {
  readonly attempts?: number
  readonly baseDelayMs?: number
  readonly busyTimeoutMs?: number
  readonly random?: () => number
}

type SqliteRow = Record<string, unknown>

const TASK_COLUMNS = `id, root_path, title, status, source, execution_id,
  action_name, execution_status, slack_permalink, worktree_path, branch_name,
  description, created_at, updated_at, revision, worktree_status,
  worktree_error, setup_completed_at, parent_task_id, base_sha, base_branch,
  pr_number, pr_url, pr_title, pr_state, pr_is_draft, sort_order,
  pr_author_login, pr_base_branch, pr_merge_status, pr_check_status, pr_checks,
  pr_unresolved_threads, pr_review_decision, pr_approvals, task_number,
  label_ids`
const PROJECT_COLUMNS = `id, name, root_path, repo_id, canonical_git_common_dir,
  created_at, updated_at, revision, sort_order, branch_name, color,
  icon_data_url`
const SETTING_COLUMNS = 'key, value, created_at, updated_at, revision'
const LABEL_COLUMNS = `id, name, color, created_at, updated_at,
  revision`
const REVIEW_COMMENT_THREAD_COLUMNS = `id, workspace_id, file_path, side,
  start_line, end_line, status, created_at, updated_at, revision`
const REVIEW_COMMENT_REPLY_COLUMNS = 'id, thread_id, author, body, created_at'
/** Row-size bound. A task carrying more labels than this is a client defect. */
export const MAX_TASK_LABELS = 32
export const MAX_LABEL_NAME_LENGTH = 60
const MAX_LEDGER_READ = 1000
const MAX_TABLE_ROWS = 10_000
const pathContains = (parent: string, child: string): boolean =>
  parent === child ||
  child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
const BUSY_MESSAGE = /SQLITE_BUSY|SQLITE_BUSY_SNAPSHOT|database is locked/i

const TASK_PATCH_FIELDS = [
  'actionName',
  'baseBranch',
  'baseSha',
  'branchName',
  'description',
  'executionId',
  'executionStatus',
  'parentTaskId',
  'prAuthorLogin',
  'prBaseBranch',
  'prCheckStatus',
  'prChecks',
  'prIsDraft',
  'prMergeStatus',
  'prNumber',
  'prApprovals',
  'prReviewDecision',
  'prState',
  'prTitle',
  'prUnresolvedThreads',
  'prUrl',
  'rootPath',
  'setupCompletedAt',
  'slackPermalink',
  'sortOrder',
  'status',
  'title',
  'worktreeError',
  'worktreePath',
  'worktreeStatus',
] as const satisfies readonly (keyof LaborerTaskPatch)[]
const PROJECT_PATCH_FIELDS = [
  'branchName',
  'canonicalGitCommonDir',
  'color',
  'iconDataUrl',
  'name',
  'repoId',
  'rootPath',
  'sortOrder',
] as const satisfies readonly (keyof ProjectPatch)[]

const TASK_PATCH_COLUMNS: Record<keyof LaborerTaskPatch, string> = {
  actionName: 'action_name',
  baseBranch: 'base_branch',
  baseSha: 'base_sha',
  branchName: 'branch_name',
  description: 'description',
  executionId: 'execution_id',
  executionStatus: 'execution_status',
  parentTaskId: 'parent_task_id',
  prAuthorLogin: 'pr_author_login',
  prBaseBranch: 'pr_base_branch',
  prCheckStatus: 'pr_check_status',
  prChecks: 'pr_checks',
  prIsDraft: 'pr_is_draft',
  prMergeStatus: 'pr_merge_status',
  prNumber: 'pr_number',
  prApprovals: 'pr_approvals',
  prReviewDecision: 'pr_review_decision',
  prState: 'pr_state',
  prTitle: 'pr_title',
  prUnresolvedThreads: 'pr_unresolved_threads',
  prUrl: 'pr_url',
  rootPath: 'root_path',
  setupCompletedAt: 'setup_completed_at',
  slackPermalink: 'slack_permalink',
  sortOrder: 'sort_order',
  status: 'status',
  title: 'title',
  worktreeError: 'worktree_error',
  worktreePath: 'worktree_path',
  worktreeStatus: 'worktree_status',
}
const PROJECT_PATCH_COLUMNS: Record<keyof ProjectPatch, string> = {
  branchName: 'branch_name',
  canonicalGitCommonDir: 'canonical_git_common_dir',
  color: 'color',
  iconDataUrl: 'icon_data_url',
  name: 'name',
  repoId: 'repo_id',
  rootPath: 'root_path',
  sortOrder: 'sort_order',
}

const invalidColumn = (column: string): never => {
  throw new Error(`Laborer database contains an invalid ${column}`)
}
const sqliteRow = (value: unknown): SqliteRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SqliteRow)
    : invalidColumn('row')
const string = (value: unknown, column: string): string =>
  typeof value === 'string' ? value : invalidColumn(column)
const nullableString = (value: unknown, column: string): string | null =>
  value === null ? null : string(value, column)
const integer = (value: unknown, column: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : invalidColumn(column)
const revision = (value: unknown, column: string): number => {
  const parsed = integer(value, column)
  return parsed >= 1 ? parsed : invalidColumn(column)
}
const nullableInteger = (value: unknown, column: string): number | null =>
  value === null ? null : integer(value, column)
/** A count, which a negative value is not: "-1 approvals" is a corrupt row
 * to reject, not a number to render. */
const nullableCount = (value: unknown, column: string): number | null => {
  const parsed = nullableInteger(value, column)
  if (parsed !== null && parsed < 0) {
    return invalidColumn(column)
  }
  return parsed
}
const nullableNumber = (value: unknown, column: string): number | null => {
  if (value === null) {
    return null
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalidColumn(column)
}
const nextTaskSortOrder = (
  database: DatabaseSync,
  status: TaskStatus
): number =>
  nullableNumber(
    sqliteRow(
      database
        .prepare(
          `SELECT COALESCE(MIN(sort_order), 0) - 1 AS sort_order
           FROM tasks WHERE status = ?`
        )
        .get(status)
    ).sort_order,
    'tasks.sort_order'
  ) ?? 0
const taskSortOrder = (
  database: DatabaseSync,
  input: Pick<NewLaborerTask, 'sortOrder' | 'status'>
): number | null =>
  input.sortOrder === undefined
    ? nextTaskSortOrder(database, input.status)
    : input.sortOrder
const enumValue = <A extends string>(
  value: unknown,
  values: readonly A[],
  column: string
): A =>
  typeof value === 'string' && values.includes(value as A)
    ? (value as A)
    : invalidColumn(column)
/**
 * Check runs are a cache of what GitHub said, not a fact the app depends on,
 * so a row written by a newer build — or corrupted by hand — reads as "no
 * detail" rather than failing the whole snapshot the task row travels in.
 */
const checkRuns = (value: unknown): readonly PullRequestCheckRun[] | null => {
  if (typeof value !== 'string') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) {
    return null
  }
  const runs: PullRequestCheckRun[] = []
  for (const entry of parsed.slice(0, MAX_PULL_REQUEST_CHECK_RUNS)) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const run = entry as Record<string, unknown>
    const bucket = PULL_REQUEST_CHECK_RUNS_BY_BUCKET.get(String(run.bucket))
    if (bucket === undefined || typeof run.name !== 'string') {
      continue
    }
    runs.push({
      bucket,
      durationMs:
        typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)
          ? run.durationMs
          : null,
      group: typeof run.group === 'string' ? run.group : null,
      name: run.name,
      url: typeof run.url === 'string' ? run.url : null,
    })
  }
  return runs.length === 0 ? null : runs
}
const PULL_REQUEST_CHECK_RUNS_BY_BUCKET = new Map<
  string,
  PullRequestCheckRunBucket
>(PULL_REQUEST_CHECK_RUN_BUCKETS.map((bucket) => [bucket, bucket]))

const serializeCheckRuns = (
  runs: readonly PullRequestCheckRun[] | null | undefined
): string | null =>
  runs == null || runs.length === 0
    ? null
    : JSON.stringify(runs.slice(0, MAX_PULL_REQUEST_CHECK_RUNS))

/** SQLite only stores scalars, so structured patch fields serialize here. */
const taskPatchValue = (
  field: keyof LaborerTaskPatch,
  value: LaborerTaskPatch[keyof LaborerTaskPatch]
): string | number | null => {
  if (field === 'prIsDraft') {
    return value ? 1 : 0
  }
  if (field === 'prChecks') {
    return serializeCheckRuns(value as readonly PullRequestCheckRun[] | null)
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return typeof value === 'object' ? null : (value ?? null)
}

const nullableEnum = <A extends string>(
  value: unknown,
  values: readonly A[],
  column: string
): A | null => (value === null ? null : enumValue(value, values, column))

const boundedRows = (
  rows: readonly unknown[],
  table: LaborerDatabaseTable
): readonly unknown[] => {
  if (rows.length > MAX_TABLE_ROWS) {
    throw new Error(
      `Laborer database ${table} read exceeds the ${MAX_TABLE_ROWS} row limit`
    )
  }
  return rows
}

const rowToTask = (value: unknown): LaborerTask => {
  const row = sqliteRow(value)
  return {
    actionName: nullableString(row.action_name, 'tasks.action_name'),
    baseBranch: nullableString(row.base_branch, 'tasks.base_branch'),
    baseSha: nullableString(row.base_sha, 'tasks.base_sha'),
    branchName: nullableString(row.branch_name, 'tasks.branch_name'),
    createdAt: integer(row.created_at, 'tasks.created_at'),
    description: nullableString(row.description, 'tasks.description'),
    executionId: nullableString(row.execution_id, 'tasks.execution_id'),
    executionStatus: nullableEnum(
      row.execution_status,
      [
        'queued',
        'running',
        'cancelling',
        'completed',
        'failed',
        'cancelled',
        'needs-attention',
      ],
      'tasks.execution_status'
    ),
    id: string(row.id, 'tasks.id'),
    labelIds: parseLabelIds(row.label_ids),
    parentTaskId: nullableString(row.parent_task_id, 'tasks.parent_task_id'),
    prAuthorLogin: nullableString(row.pr_author_login, 'tasks.pr_author_login'),
    prBaseBranch: nullableString(row.pr_base_branch, 'tasks.pr_base_branch'),
    prCheckStatus: nullableEnum(
      row.pr_check_status,
      ['pending', 'success', 'failure'],
      'tasks.pr_check_status'
    ),
    prChecks: checkRuns(row.pr_checks),
    prIsDraft: (() => {
      const value = integer(row.pr_is_draft, 'tasks.pr_is_draft')
      if (value !== 0 && value !== 1) {
        return invalidColumn('tasks.pr_is_draft')
      }
      return value === 1
    })(),
    prMergeStatus: nullableEnum(
      row.pr_merge_status,
      ['clean', 'conflicting', 'unknown'],
      'tasks.pr_merge_status'
    ),
    prNumber: nullableInteger(row.pr_number, 'tasks.pr_number'),
    prApprovals: nullableCount(row.pr_approvals, 'tasks.pr_approvals'),
    prReviewDecision: nullableEnum(
      row.pr_review_decision,
      ['approved', 'changesRequested', 'reviewRequired'],
      'tasks.pr_review_decision'
    ),
    prState: nullableEnum(
      row.pr_state,
      ['open', 'closed', 'merged'],
      'tasks.pr_state'
    ),
    prTitle: nullableString(row.pr_title, 'tasks.pr_title'),
    prUnresolvedThreads: nullableInteger(
      row.pr_unresolved_threads,
      'tasks.pr_unresolved_threads'
    ),
    prUrl: nullableString(row.pr_url, 'tasks.pr_url'),
    revision: revision(row.revision, 'tasks.revision'),
    rootPath: string(row.root_path, 'tasks.root_path'),
    setupCompletedAt: nullableInteger(
      row.setup_completed_at,
      'tasks.setup_completed_at'
    ),
    slackPermalink: nullableString(
      row.slack_permalink,
      'tasks.slack_permalink'
    ),
    sortOrder: nullableNumber(row.sort_order, 'tasks.sort_order'),
    source: enumValue(
      row.source,
      ['execution', 'manual', 'slack_url', 'agent', 'worktree'],
      'tasks.source'
    ),
    status: enumValue(
      row.status,
      ['todo', 'in_progress', 'in_review', 'done', 'cancelled'],
      'tasks.status'
    ),
    taskNumber: integer(row.task_number, 'tasks.task_number'),
    title: string(row.title, 'tasks.title'),
    updatedAt: integer(row.updated_at, 'tasks.updated_at'),
    worktreeError: nullableString(row.worktree_error, 'tasks.worktree_error'),
    worktreePath: nullableString(row.worktree_path, 'tasks.worktree_path'),
    worktreeStatus: nullableEnum(
      row.worktree_status,
      ['provisioning', 'ready', 'errored'],
      'tasks.worktree_status'
    ),
  }
}

const rowToProject = (value: unknown): Project => {
  const row = sqliteRow(value)
  return {
    branchName: nullableString(row.branch_name, 'projects.branch_name'),
    canonicalGitCommonDir: string(
      row.canonical_git_common_dir,
      'projects.canonical_git_common_dir'
    ),
    color: nullableString(row.color, 'projects.color'),
    createdAt: integer(row.created_at, 'projects.created_at'),
    iconDataUrl: nullableString(row.icon_data_url, 'projects.icon_data_url'),
    id: string(row.id, 'projects.id'),
    name: string(row.name, 'projects.name'),
    repoId: string(row.repo_id, 'projects.repo_id'),
    revision: revision(row.revision, 'projects.revision'),
    rootPath: string(row.root_path, 'projects.root_path'),
    sortOrder: nullableNumber(row.sort_order, 'projects.sort_order'),
    updatedAt: integer(row.updated_at, 'projects.updated_at'),
  }
}

const rowToLabel = (value: unknown): Label => {
  const row = sqliteRow(value)
  return {
    color: enumValue(row.color, LABEL_COLORS, 'labels.color'),
    createdAt: integer(row.created_at, 'labels.created_at'),
    id: string(row.id, 'labels.id'),
    name: string(row.name, 'labels.name'),
    revision: revision(row.revision, 'labels.revision'),
    updatedAt: integer(row.updated_at, 'labels.updated_at'),
  }
}

const labelName = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('A label name must not be blank')
  }
  if (trimmed.length > MAX_LABEL_NAME_LENGTH) {
    throw new Error(
      `A label name must be ${MAX_LABEL_NAME_LENGTH} characters or fewer`
    )
  }
  return trimmed
}

const rowToSetting = (value: unknown): AppSetting => {
  const row = sqliteRow(value)
  return {
    createdAt: integer(row.created_at, 'app_settings.created_at'),
    key: string(row.key, 'app_settings.key'),
    revision: revision(row.revision, 'app_settings.revision'),
    updatedAt: integer(row.updated_at, 'app_settings.updated_at'),
    value: string(row.value, 'app_settings.value'),
  }
}

const validateCursorRead = (sequence: number, limit: number): void => {
  if (!(Number.isSafeInteger(sequence) && sequence >= 0)) {
    throw new Error('A change cursor must be a nonnegative integer')
  }
  if (
    !(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LEDGER_READ)
  ) {
    throw new Error(`A change limit must be between 1 and ${MAX_LEDGER_READ}`)
  }
}

const isBusy = (cause: unknown): boolean =>
  cause instanceof Error &&
  (BUSY_MESSAGE.test(cause.message) ||
    ('code' in cause && BUSY_MESSAGE.test(String(cause.code))))

const sleep = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** Synchronous, framework-neutral owner of one shared laborer.sqlite handle. */
export class NativeLaborerDatabase {
  readonly #database: DatabaseSync
  readonly #path: string
  readonly #retry: Required<Omit<LaborerDatabaseOptions, 'busyTimeoutMs'>>
  #closed = false

  private constructor(
    database: DatabaseSync,
    path: string,
    options: LaborerDatabaseOptions
  ) {
    const attempts = options.attempts ?? 5
    const baseDelayMs = options.baseDelayMs ?? 10
    if (!(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 10)) {
      throw new Error('Database retry attempts must be between 1 and 10')
    }
    if (
      !(Number.isFinite(baseDelayMs) && baseDelayMs >= 0 && baseDelayMs <= 1000)
    ) {
      throw new Error('Database retry base delay must be between 0 and 1000ms')
    }
    this.#database = database
    this.#path = path
    this.#retry = {
      attempts,
      baseDelayMs,
      random: options.random ?? Math.random,
    }
  }

  /** Opens a handle without initialization, for scoped adapters to register cleanup first. */
  static connect(
    path: string,
    options: LaborerDatabaseOptions = {}
  ): NativeLaborerDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    try {
      return new NativeLaborerDatabase(database, path, options)
    } catch (cause) {
      database.close()
      throw cause
    }
  }

  static open(
    path: string,
    options: LaborerDatabaseOptions = {}
  ): NativeLaborerDatabase {
    const database = NativeLaborerDatabase.connect(path, options)
    try {
      database.initialize(options.busyTimeoutMs)
      return database
    } catch (cause) {
      database.close()
      throw cause
    }
  }

  initialize(busyTimeoutMs = 5000): void {
    if (!(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0)) {
      throw new Error('Database busy timeout must be a nonnegative integer')
    }
    this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    this.#withBusyRetry(() => this.#database.exec('PRAGMA journal_mode = WAL'))
    this.#database.exec('PRAGMA synchronous = NORMAL')
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#migrate()
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#database.close()
    }
  }

  migrationNames(): readonly string[] {
    return this.#database
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY id')
      .all()
      .map((row) => string(sqliteRow(row).name, 'migration name'))
  }

  findTask(id: string): LaborerTask | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id)
    return row === undefined || row === null ? null : rowToTask(row)
  }

  findTaskByWorktreePath(worktreePath: string): LaborerTask | null {
    // Retried tasks reuse a worktree path, so cancelled history can share a
    // path with the live task. Prefer the most recently updated row.
    const row = this.#database
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE worktree_path = ?
         ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`
      )
      .get(worktreePath)
    return row === undefined || row === null ? null : rowToTask(row)
  }

  listTasks(): readonly LaborerTask[] {
    const rows = this.#database
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, id LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'tasks').map(rowToTask)
  }

  /**
   * Inserts a task. `labelIds` are validated and stored inside the same
   * IMMEDIATE transaction as the row itself, so an unknown id leaves no task
   * behind and a created task is never briefly visible without its labels.
   */
  insertTask(
    input: NewLaborerTask,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    const createdAt = input.createdAt ?? changedAt
    const labelIds = [...new Set(input.labelIds ?? [])]
    if (labelIds.length > MAX_TASK_LABELS) {
      throw new Error(`A task carries at most ${MAX_TASK_LABELS} labels`)
    }
    const prAuthorLogin = input.prAuthorLogin ?? null
    const prBaseBranch = input.prBaseBranch ?? null
    const prMergeStatus = input.prMergeStatus ?? null
    const prCheckStatus = input.prCheckStatus ?? null
    const prReviewDecision = input.prReviewDecision ?? null
    const prApprovals = input.prApprovals ?? null
    return this.#writeTransaction(() => {
      this.#requireKnownLabels(input.id, labelIds)
      const sortOrder = taskSortOrder(this.#database, input)
      this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision, worktree_status,
          worktree_error, setup_completed_at, parent_task_id, base_sha,
          base_branch, pr_number, pr_url, pr_title, pr_state, pr_is_draft,
          sort_order, pr_author_login, pr_base_branch, pr_merge_status, pr_check_status,
          pr_checks, pr_unresolved_threads, pr_review_decision, pr_approvals,
          label_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.rootPath,
          input.title,
          input.status,
          input.source,
          input.executionId ?? null,
          input.actionName ?? null,
          input.executionStatus ?? null,
          input.slackPermalink ?? null,
          input.worktreePath ?? null,
          input.branchName ?? null,
          input.description ?? null,
          createdAt,
          changedAt,
          input.worktreeStatus ?? null,
          input.worktreeError ?? null,
          input.setupCompletedAt ?? null,
          input.parentTaskId ?? null,
          input.baseSha ?? null,
          input.baseBranch ?? null,
          input.prNumber ?? null,
          input.prUrl ?? null,
          input.prTitle ?? null,
          input.prState ?? null,
          input.prIsDraft ? 1 : 0,
          sortOrder,
          prAuthorLogin,
          prBaseBranch,
          prMergeStatus,
          prCheckStatus,
          serializeCheckRuns(input.prChecks),
          input.prUnresolvedThreads ?? null,
          prReviewDecision,
          prApprovals,
          serializeLabelIds(labelIds)
        )
      const cursor = this.#appendTaskChange(input.id, changedAt, operationId)
      return { row: this.#requireTask(input.id), cursor }
    })
  }

  /** Atomically adopt an unclaimed git worktree as an in-progress task. */
  adoptWorktreeTask(
    input: {
      readonly baseBranch?: string | null
      readonly baseSha?: string | null
      readonly branchName: string | null
      readonly id: string
      readonly parentTaskId?: string | null
      readonly rootPath: string
      readonly title: string
      readonly worktreePath: string
      readonly worktreePathAliases: readonly string[]
    },
    changedAt = Date.now()
  ): LaborerTask | null {
    const aliases = [
      ...new Set([input.worktreePath, ...input.worktreePathAliases]),
    ]
    return this.#writeTransaction(() => {
      const pathClaim = this.#database
        .prepare(
          `SELECT 1 FROM tasks
           WHERE worktree_path IN (${aliases.map(() => '?').join(', ')})
           LIMIT 1`
        )
        .get(...aliases)
      if (pathClaim !== undefined) {
        return null
      }

      if (input.branchName !== null) {
        const branchClaimed = this.#database
          .prepare(
            `SELECT root_path FROM tasks
             WHERE branch_name = ? LIMIT ?`
          )
          .all(input.branchName, MAX_TABLE_ROWS)
          .some((row) => {
            const rootPath = string(sqliteRow(row).root_path, 'root_path')
            return (
              pathContains(rootPath, input.rootPath) ||
              pathContains(input.rootPath, rootPath)
            )
          })
        if (branchClaimed) {
          return null
        }
      }

      this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision, parent_task_id,
          base_sha, base_branch, worktree_status
        ) VALUES (?, ?, ?, 'in_progress', 'worktree', NULL, NULL, NULL, NULL,
          ?, ?, NULL, ?, ?, 1, ?, ?, ?, 'ready')`)
        .run(
          input.id,
          input.rootPath,
          input.title,
          input.worktreePath,
          input.branchName,
          changedAt,
          changedAt,
          input.parentTaskId ?? null,
          input.baseSha ?? null,
          input.baseBranch ?? null
        )
      this.#appendTaskChange(input.id, changedAt, null)
      return this.#requireTask(input.id)
    })
  }

  updateTask(
    id: string,
    expectedRevision: number,
    patch: LaborerTaskPatch,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    const entries = TASK_PATCH_FIELDS.filter((field) =>
      Object.hasOwn(patch, field)
    ).map((field) => [field, patch[field]] as const)
    if (entries.length === 0) {
      throw new Error('A task update requires at least one field')
    }
    return this.#writeTransaction(() => {
      const result = this.#database
        .prepare(`UPDATE tasks SET ${entries
          .map(([field]) => `${TASK_PATCH_COLUMNS[field]} = ?`)
          .join(', ')}, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(
          ...entries.map(([field, value]) => taskPatchValue(field, value)),
          changedAt,
          id,
          expectedRevision
        )
      if (result.changes === 0) {
        throw new LaborerDatabaseStaleRevisionError(
          'tasks',
          id,
          expectedRevision,
          this.findTask(id)
        )
      }
      const cursor = this.#appendTaskChange(id, changedAt, operationId)
      return { row: this.#requireTask(id), cursor }
    })
  }

  deleteTask(
    id: string,
    expectedRevision: number,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    return this.#writeTransaction(() => {
      const row = this.findTask(id)
      const result = this.#database
        .prepare('DELETE FROM tasks WHERE id = ? AND revision = ?')
        .run(id, expectedRevision)
      if (result.changes === 0 || row === null) {
        throw new LaborerDatabaseStaleRevisionError(
          'tasks',
          id,
          expectedRevision,
          this.findTask(id)
        )
      }
      const cursor = this.#appendTaskChange(id, changedAt, operationId)
      return { row, cursor }
    })
  }

  taskChangesAfter(
    sequence: number,
    limit = MAX_LEDGER_READ
  ): readonly TaskChange[] {
    validateCursorRead(sequence, limit)
    return this.#database
      .prepare(`SELECT sequence, task_id, changed_at, operation_id
        FROM task_changes WHERE sequence > ? ORDER BY sequence LIMIT ?`)
      .all(sequence, limit)
      .map((value) => {
        const row = sqliteRow(value)
        return {
          changedAt: integer(row.changed_at, 'task_changes.changed_at'),
          operationId: nullableString(
            row.operation_id,
            'task_changes.operation_id'
          ),
          sequence: integer(row.sequence, 'task_changes.sequence'),
          taskId: string(row.task_id, 'task_changes.task_id'),
        }
      })
  }

  findProject(id: string): Project | null {
    const row = this.#database
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .get(id)
    return row === undefined || row === null ? null : rowToProject(row)
  }

  findProjectByRepoId(repoId: string): Project | null {
    const row = this.#database
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE repo_id = ?`)
      .get(repoId)
    return row === undefined || row === null ? null : rowToProject(row)
  }

  /** Current authoritative project previously published for an operation. */
  findProjectByOperationId(operationId: string): Project | null {
    const row = this.#database
      .prepare(`SELECT ${PROJECT_COLUMNS.split(', ')
        .map((column) => `p.${column.trim()}`)
        .join(', ')} FROM state_changes c
        JOIN projects p ON p.id = c.row_id
        WHERE c.table_name = 'projects' AND c.operation_id = ?
        ORDER BY c.sequence DESC LIMIT 1`)
      .get(operationId)
    return row === undefined || row === null ? null : rowToProject(row)
  }

  listProjects(): readonly Project[] {
    const rows = this.#database
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects
          ORDER BY COALESCE(sort_order, created_at), id LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'projects').map(rowToProject)
  }

  insertProject(
    input: NewProject,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Project> {
    const createdAt = input.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      const replay =
        operationId === null ? null : this.findProjectByOperationId(operationId)
      if (replay !== null) {
        return { cursor: this.#stateCursor(), row: replay }
      }
      this.#database
        .prepare(`INSERT INTO projects (
          id, name, root_path, repo_id, canonical_git_common_dir,
          created_at, updated_at, revision, branch_name, color, icon_data_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(
          input.id,
          input.name,
          input.rootPath,
          input.repoId,
          input.canonicalGitCommonDir,
          createdAt,
          changedAt,
          input.branchName ?? null,
          input.color ?? null,
          input.iconDataUrl ?? null
        )
      const cursor = this.#appendStateChange(
        'projects',
        input.id,
        changedAt,
        operationId
      )
      return { row: this.#requireProject(input.id), cursor }
    })
  }

  updateProject(
    id: string,
    expectedRevision: number,
    patch: ProjectPatch,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Project> {
    const entries = PROJECT_PATCH_FIELDS.filter((field) =>
      Object.hasOwn(patch, field)
    ).map((field) => [field, patch[field]] as const)
    if (entries.length === 0) {
      throw new Error('A project update requires at least one field')
    }
    return this.#writeTransaction(() => {
      const result = this.#database
        .prepare(`UPDATE projects SET ${entries
          .map(([field]) => `${PROJECT_PATCH_COLUMNS[field]} = ?`)
          .join(', ')}, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(
          ...entries.map(([, value]) => value ?? null),
          changedAt,
          id,
          expectedRevision
        )
      if (result.changes === 0) {
        throw new LaborerDatabaseStaleRevisionError(
          'projects',
          id,
          expectedRevision,
          this.findProject(id)
        )
      }
      const cursor = this.#appendStateChange(
        'projects',
        id,
        changedAt,
        operationId
      )
      return { row: this.#requireProject(id), cursor }
    })
  }

  /**
   * Narrow manual-order write for project drags. Rank is the only field the
   * UI writes, so this delegates to the CAS update rather than widening the
   * surface a reorder can touch.
   */
  moveProject(
    id: string,
    expectedRevision: number,
    sortOrder: number | null,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Project> {
    return this.updateProject(
      id,
      expectedRevision,
      { sortOrder },
      operationId,
      changedAt
    )
  }

  /** Validate and apply every rank assignment at one SQLite linearization point. */
  reorderProjects(
    assignments: readonly ProjectReorderAssignment[],
    operationId: string,
    changedAt = Date.now()
  ): ProjectReorderResult {
    if (assignments.length === 0) {
      throw new Error('A project reorder requires at least one assignment')
    }
    const ids = new Set(assignments.map(({ projectId }) => projectId))
    if (ids.size !== assignments.length) {
      throw new Error('A project reorder cannot assign one project twice')
    }
    return this.#writeTransaction(() => {
      for (const assignment of assignments) {
        const current = this.findProject(assignment.projectId)
        if (
          current === null ||
          current.revision !== assignment.expectedRevision
        ) {
          throw new LaborerDatabaseStaleRevisionError(
            'projects',
            assignment.projectId,
            assignment.expectedRevision,
            current
          )
        }
      }
      const update = this.#database.prepare(`UPDATE projects
        SET sort_order = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`)
      let cursor = this.#stateCursor()
      for (const assignment of assignments) {
        const result = update.run(
          assignment.sortOrder,
          changedAt,
          assignment.projectId,
          assignment.expectedRevision
        )
        if (result.changes !== 1) {
          throw new LaborerDatabaseStaleRevisionError(
            'projects',
            assignment.projectId,
            assignment.expectedRevision,
            this.findProject(assignment.projectId)
          )
        }
        cursor = this.#appendStateChange(
          'projects',
          assignment.projectId,
          changedAt,
          operationId
        )
      }
      return {
        cursor,
        rows: assignments.map(({ projectId }) =>
          this.#requireProject(projectId)
        ),
      }
    })
  }

  deleteProject(
    id: string,
    expectedRevision: number,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Project> {
    return this.#writeTransaction(() => {
      const row = this.findProject(id)
      const result = this.#database
        .prepare('DELETE FROM projects WHERE id = ? AND revision = ?')
        .run(id, expectedRevision)
      if (result.changes === 0 || row === null) {
        throw new LaborerDatabaseStaleRevisionError(
          'projects',
          id,
          expectedRevision,
          this.findProject(id)
        )
      }
      const cursor = this.#appendStateChange(
        'projects',
        id,
        changedAt,
        operationId
      )
      return { row, cursor }
    })
  }

  findSetting(key: string): AppSetting | null {
    const row = this.#database
      .prepare(`SELECT ${SETTING_COLUMNS} FROM app_settings WHERE key = ?`)
      .get(key)
    return row === undefined || row === null ? null : rowToSetting(row)
  }

  listSettings(): readonly AppSetting[] {
    const rows = this.#database
      .prepare(
        `SELECT ${SETTING_COLUMNS} FROM app_settings ORDER BY key LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'app_settings').map(rowToSetting)
  }

  findLabel(id: string): Label | null {
    const row = this.#database
      .prepare(`SELECT ${LABEL_COLUMNS} FROM labels WHERE id = ?`)
      .get(id)
    return row === undefined ? null : rowToLabel(row)
  }

  /** Names collide case-insensitively across the whole app. */
  findLabelByName(name: string): Label | null {
    const row = this.#database
      .prepare(
        `SELECT ${LABEL_COLUMNS} FROM labels WHERE lower(name) = lower(?)`
      )
      .get(name)
    return row === undefined ? null : rowToLabel(row)
  }

  listLabels(): readonly Label[] {
    const rows = this.#database
      .prepare(`SELECT ${LABEL_COLUMNS} FROM labels ORDER BY name LIMIT ?`)
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'labels').map(rowToLabel)
  }

  /**
   * Creates a label. A stored id is an idempotent retry that returns the row
   * as it stands, so a renderer that mints ids can replay a dropped response.
   * An omitted color is derived from the name, deterministically and shared
   * with the renderer.
   */
  createLabel(
    input: NewLabel,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Label> {
    const id = input.id ?? createTaskUlid()
    const name = labelName(input.name)
    const color = input.color ?? labelColorForName(name)
    const createdAt = input.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      const existing = this.findLabel(id)
      if (existing !== null) {
        return { cursor: this.#stateCursor(), row: existing }
      }
      const conflict = this.findLabelByName(name)
      if (conflict !== null) {
        throw new LaborerDatabaseLabelNameConflictError(name, conflict)
      }
      this.#database
        .prepare(`INSERT INTO labels (
          id, name, color, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, 1)`)
        .run(id, name, color, createdAt, changedAt)
      const cursor = this.#appendStateChange(
        'labels',
        id,
        changedAt,
        operationId
      )
      return { cursor, row: this.#requireLabel(id) }
    })
  }

  /** `null` expected revision skips the CAS guard (last-write-wins). */
  updateLabel(
    id: string,
    expectedRevision: number | null,
    patch: LabelPatch,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Label> {
    if (patch.name === undefined && patch.color === undefined) {
      throw new Error('A label update requires a name and/or a color')
    }
    const name = patch.name === undefined ? undefined : labelName(patch.name)
    return this.#writeTransaction(() => {
      const current = this.findLabel(id)
      if (
        current === null ||
        (expectedRevision !== null && current.revision !== expectedRevision)
      ) {
        throw new LaborerDatabaseStaleRevisionError(
          'labels',
          id,
          expectedRevision,
          current
        )
      }
      if (name !== undefined) {
        const conflict = this.findLabelByName(name)
        if (conflict !== null && conflict.id !== id) {
          throw new LaborerDatabaseLabelNameConflictError(name, conflict)
        }
      }
      const result = this.#database
        .prepare(`UPDATE labels
          SET name = ?, color = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?${expectedRevision === null ? '' : ' AND revision = ?'}`)
        .run(
          name ?? current.name,
          patch.color ?? current.color,
          changedAt,
          id,
          ...(expectedRevision === null ? [] : [expectedRevision])
        )
      if (result.changes === 0) {
        throw new LaborerDatabaseStaleRevisionError(
          'labels',
          id,
          expectedRevision,
          this.findLabel(id)
        )
      }
      const cursor = this.#appendStateChange(
        'labels',
        id,
        changedAt,
        operationId
      )
      return { cursor, row: this.#requireLabel(id) }
    })
  }

  /**
   * Hard-deletes a label and strips its id from every task carrying it in the
   * same transaction, so a task's stored ids never name a label that is gone.
   * Touched tasks land on the task ledger, so subscribers re-render them.
   */
  deleteLabel(
    id: string,
    expectedRevision: number | null,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Label> {
    return this.#writeTransaction(() => {
      const row = this.findLabel(id)
      const result =
        expectedRevision === null
          ? this.#database.prepare('DELETE FROM labels WHERE id = ?').run(id)
          : this.#database
              .prepare('DELETE FROM labels WHERE id = ? AND revision = ?')
              .run(id, expectedRevision)
      if (result.changes === 0 || row === null) {
        throw new LaborerDatabaseStaleRevisionError(
          'labels',
          id,
          expectedRevision,
          this.findLabel(id)
        )
      }
      this.#stripLabelFromTasks(id, changedAt, operationId)
      const cursor = this.#appendStateChange(
        'labels',
        id,
        changedAt,
        operationId
      )
      return { cursor, row }
    })
  }

  /**
   * Replaces a task's whole label set. Ids are deduped in the order given and
   * must name labels that exist, so the stored array is always a valid,
   * ordered reference list. Labels are app-wide, so any label applies to a
   * task in any project.
   *
   * A numeric `expectedRevision` guards the write with revision CAS; `null`
   * means the caller accepts last-write-wins.
   */
  setTaskLabels(
    taskId: string,
    expectedRevision: number | null,
    labelIds: readonly string[],
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    const requested = [...new Set(labelIds)]
    if (requested.length > MAX_TASK_LABELS) {
      throw new Error(`A task carries at most ${MAX_TASK_LABELS} labels`)
    }
    return this.#writeTransaction(() =>
      this.#writeTaskLabels(
        taskId,
        expectedRevision,
        requested,
        operationId,
        changedAt
      )
    )
  }

  /**
   * Appends label ids a task does not already carry, keeping the ids it has in
   * their existing order. Reading the current set and writing the union happen
   * inside one IMMEDIATE transaction, so the operation commutes with any
   * concurrent add or remove instead of clobbering it — no revision needed.
   * Adding ids the task already carries is a no-op that still returns the row.
   */
  addTaskLabels(
    taskId: string,
    labelIds: readonly string[],
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    return this.#writeTransaction(() => {
      const current = this.#requireTaskForLabels(taskId)
      const additions = [...new Set(labelIds)].filter(
        (id) => !current.labelIds.includes(id)
      )
      if (additions.length === 0) {
        // Nothing changed, so the ledger stays quiet and the revision holds.
        this.#requireKnownLabels(taskId, [...new Set(labelIds)])
        return { cursor: this.#taskCursor(), row: current }
      }
      return this.#writeTaskLabels(
        taskId,
        null,
        [...current.labelIds, ...additions],
        operationId,
        changedAt
      )
    })
  }

  /**
   * Drops label ids from a task, leaving the rest in their existing order.
   * Like {@link addTaskLabels} this reads and writes inside one IMMEDIATE
   * transaction and needs no revision, so it commutes with concurrent label
   * edits. Removing ids the task does not carry is a no-op.
   */
  removeTaskLabels(
    taskId: string,
    labelIds: readonly string[],
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    return this.#writeTransaction(() => {
      const current = this.#requireTaskForLabels(taskId)
      const removals = new Set(labelIds)
      const remaining = current.labelIds.filter((id) => !removals.has(id))
      if (remaining.length === current.labelIds.length) {
        return { cursor: this.#taskCursor(), row: current }
      }
      return this.#writeTaskLabels(
        taskId,
        null,
        remaining,
        operationId,
        changedAt
      )
    })
  }

  /**
   * Fails unless every requested label id names an existing label. Callers
   * run inside the write transaction that stores the ids, so a label cannot
   * disappear between the check and the write.
   */
  #requireKnownLabels(taskId: string, labelIds: readonly string[]): void {
    const unknown = this.#unknownLabelIds(labelIds)
    if (unknown.length > 0) {
      throw new LaborerDatabaseUnknownLabelError(taskId, unknown)
    }
  }

  /** The task a label operation targets, or a stale-revision failure. */
  #requireTaskForLabels(taskId: string): LaborerTask {
    const current = this.findTask(taskId)
    if (current === null) {
      throw new LaborerDatabaseStaleRevisionError('tasks', taskId, null, null)
    }
    return current
  }

  /** Writes an already-deduped label id list. Callers hold the transaction. */
  #writeTaskLabels(
    taskId: string,
    expectedRevision: number | null,
    requested: readonly string[],
    operationId: string | null,
    changedAt: number
  ): MutationResult<LaborerTask> {
    if (requested.length > MAX_TASK_LABELS) {
      throw new Error(`A task carries at most ${MAX_TASK_LABELS} labels`)
    }
    this.#requireTaskForLabels(taskId)
    this.#requireKnownLabels(taskId, requested)
    const guarded = expectedRevision !== null
    const result = this.#database
      .prepare(`UPDATE tasks
          SET label_ids = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?${guarded ? ' AND revision = ?' : ''}`)
      .run(
        serializeLabelIds(requested),
        changedAt,
        taskId,
        ...(expectedRevision === null ? [] : [expectedRevision])
      )
    if (result.changes === 0) {
      throw new LaborerDatabaseStaleRevisionError(
        'tasks',
        taskId,
        expectedRevision,
        this.findTask(taskId)
      )
    }
    const cursor = this.#appendTaskChange(taskId, changedAt, operationId)
    return { cursor, row: this.#requireTask(taskId) }
  }

  /**
   * A review conversation with its whole reply chain, oldest reply first.
   *
   * Replies are append-only children rather than fields of the thread row, so
   * answering a thread deliberately leaves the thread's revision alone: an
   * agent's reply must never invalidate the revision a human is holding to
   * resolve or delete that same thread.
   */
  findReviewCommentThread(id: string): ReviewCommentThread | null {
    const row = this.#database
      .prepare(
        `SELECT ${REVIEW_COMMENT_THREAD_COLUMNS} FROM review_comment_threads
         WHERE id = ?`
      )
      .get(id)
    return row === undefined || row === null
      ? null
      : decodeReviewCommentThreadRow(row, this.#reviewCommentReplies(id))
  }

  /** Every thread in the database, for a snapshot the ledger then tails. */
  listAllReviewCommentThreads(): readonly ReviewCommentThread[] {
    const rows = this.#database
      .prepare(
        `SELECT ${REVIEW_COMMENT_THREAD_COLUMNS} FROM review_comment_threads
         ORDER BY created_at, id LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'review_comment_threads').map((row) =>
      decodeReviewCommentThreadRow(
        row,
        this.#reviewCommentReplies(
          string(sqliteRow(row).id, 'review_comment_threads.id')
        )
      )
    )
  }

  /** Every thread anchored in one workspace, newest thread last. */
  listReviewCommentThreads(
    workspaceId: string,
    options: { readonly includeResolved?: boolean } = {}
  ): readonly ReviewCommentThread[] {
    const rows = this.#database
      .prepare(
        `SELECT ${REVIEW_COMMENT_THREAD_COLUMNS} FROM review_comment_threads
         WHERE workspace_id = ?
           AND (? = 1 OR status = 'open')
         ORDER BY created_at, id LIMIT ?`
      )
      .all(
        workspaceId,
        options.includeResolved === true ? 1 : 0,
        MAX_TABLE_ROWS + 1
      )
    return boundedRows(rows, 'review_comment_threads').map((row) =>
      decodeReviewCommentThreadRow(
        row,
        this.#reviewCommentReplies(
          string(sqliteRow(row).id, 'review_comment_threads.id')
        )
      )
    )
  }

  /**
   * A workspace's conversations and the state-ledger position they reflect,
   * captured in one read transaction, so a client can start tailing
   * `state.subscribe` from exactly where its first read ended.
   */
  reviewCommentsAt(
    workspaceId: string,
    options: { readonly includeResolved?: boolean } = {}
  ): {
    readonly cursor: number
    readonly rows: readonly ReviewCommentThread[]
  } {
    return this.#readTransaction(() => ({
      cursor: this.#stateCursor(),
      rows: this.listReviewCommentThreads(workspaceId, options),
    }))
  }

  /**
   * Opens a thread and writes its first message in one transaction, so a
   * thread never exists without the words that opened it. A stored id is an
   * idempotent retry that returns the thread as it stands.
   *
   * The author is the boundary's, not the caller's: web RPC handlers pass
   * `HUMAN_AUTHOR` and MCP tools pass `AGENT_AUTHOR`.
   */
  createReviewCommentThread(
    input: NewReviewCommentThread,
    author: ReviewCommentAuthor,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<ReviewCommentThread> {
    const draft = validateNewReviewCommentThread(input)
    const id = draft.id ?? createTaskUlid()
    const replyId = draft.replyId ?? createTaskUlid()
    const createdAt = draft.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      const existing = this.findReviewCommentThread(id)
      if (existing !== null) {
        return { cursor: this.#stateCursor(), row: existing }
      }
      this.#database
        .prepare(`INSERT INTO review_comment_threads (
          id, workspace_id, file_path, side, start_line, end_line, status,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`)
        .run(
          id,
          draft.workspaceId,
          draft.filePath,
          draft.side,
          draft.startLine,
          draft.endLine,
          createdAt,
          createdAt
        )
      this.#insertReviewCommentReply(replyId, id, author, draft.body, createdAt)
      const cursor = this.#publishReviewCommentThread(
        id,
        createdAt,
        operationId
      )
      return { cursor, row: this.#requireReviewCommentThread(id) }
    })
  }

  /** Appends one message to an existing thread. See the authorship note on
   * {@link findReviewCommentThread} for why the thread row is untouched. */
  appendReviewCommentReply(
    input: NewReviewCommentReply,
    author: ReviewCommentAuthor,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<ReviewCommentThread> {
    const body = reviewCommentBody(input.body)
    const id = input.id ?? createTaskUlid()
    return this.#writeTransaction(() => {
      const thread = this.findReviewCommentThread(input.threadId)
      if (thread === null) {
        throw new ReviewCommentNotFoundError({
          id: input.threadId,
          message: `Review comment thread not found: ${input.threadId}`,
        })
      }
      if (thread.replies.some((reply) => reply.id === id)) {
        return { cursor: this.#stateCursor(), row: thread }
      }
      if (thread.replies.length >= MAX_REVIEW_COMMENT_REPLIES) {
        throw new ReviewCommentInvalidError({
          message: `A review comment thread holds at most ${MAX_REVIEW_COMMENT_REPLIES} replies`,
        })
      }
      // Replies read back ordered by time then id, and ids carry random
      // entropy inside one millisecond. An answer written in the same
      // millisecond as the message it answers would otherwise be free to sort
      // ahead of it, so an appended reply is stamped after the last one.
      const previous = thread.replies.at(-1)?.createdAt ?? thread.createdAt
      const createdAt = input.createdAt ?? Math.max(changedAt, previous + 1)
      this.#insertReviewCommentReply(
        id,
        input.threadId,
        author,
        body,
        createdAt
      )
      const cursor = this.#publishReviewCommentThread(
        input.threadId,
        createdAt,
        operationId
      )
      return {
        cursor,
        row: this.#requireReviewCommentThread(input.threadId),
      }
    })
  }

  /**
   * Edits the body of a reply the given boundary wrote. A boundary may only
   * rewrite its own words, so a human cannot edit the agent's answer and the
   * agent cannot edit the request it was given.
   */
  updateReviewCommentReply(
    replyId: string,
    body: string,
    author: ReviewCommentAuthor,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<ReviewCommentThread> {
    const nextBody = reviewCommentBody(body)
    return this.#writeTransaction(() => {
      const reply = this.#findReviewCommentReply(replyId)
      if (reply === null) {
        throw new ReviewCommentNotFoundError({
          id: replyId,
          message: `Review comment reply not found: ${replyId}`,
        })
      }
      if (reply.author !== author) {
        throw new ReviewCommentAuthorMismatchError({
          author: reply.author,
          id: replyId,
          message: `Review comment reply ${replyId} was written by ${reply.author}`,
        })
      }
      this.#database
        .prepare('UPDATE review_comment_replies SET body = ? WHERE id = ?')
        .run(nextBody, replyId)
      this.#touchReviewCommentThread(reply.threadId, changedAt)
      const cursor = this.#publishReviewCommentThread(
        reply.threadId,
        changedAt,
        operationId
      )
      return {
        cursor,
        row: this.#requireReviewCommentThread(reply.threadId),
      }
    })
  }

  /** Revision-CAS status write: resolving records that a request was met. */
  setReviewCommentThreadStatus(
    id: string,
    expectedRevision: number,
    status: ReviewCommentStatus,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<ReviewCommentThread> {
    return this.#writeTransaction(() => {
      const result = this.#database
        .prepare(`UPDATE review_comment_threads
          SET status = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(status, changedAt, id, expectedRevision)
      if (result.changes === 0) {
        throw new LaborerDatabaseStaleRevisionError(
          'review_comment_threads',
          id,
          expectedRevision,
          this.findReviewCommentThread(id)
        )
      }
      const cursor = this.#publishReviewCommentThread(
        id,
        changedAt,
        operationId
      )
      return { cursor, row: this.#requireReviewCommentThread(id) }
    })
  }

  /** Hard-deletes a thread under revision CAS; its replies cascade with it. */
  deleteReviewCommentThread(
    id: string,
    expectedRevision: number,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<ReviewCommentThread> {
    return this.#writeTransaction(() => {
      const row = this.findReviewCommentThread(id)
      const result = this.#database
        .prepare(
          'DELETE FROM review_comment_threads WHERE id = ? AND revision = ?'
        )
        .run(id, expectedRevision)
      if (result.changes === 0 || row === null) {
        throw new LaborerDatabaseStaleRevisionError(
          'review_comment_threads',
          id,
          expectedRevision,
          this.findReviewCommentThread(id)
        )
      }
      const cursor = this.#publishReviewCommentThread(
        id,
        changedAt,
        operationId
      )
      return { cursor, row }
    })
  }

  /**
   * Deletes every conversation anchored in one workspace, publishing each so
   * subscribers retire the rows. Used when a worktree is destroyed: a comment
   * anchors to a line range of that worktree's diff, so the anchor cannot
   * outlive it.
   */
  deleteReviewCommentThreadsForWorkspace(
    workspaceId: string,
    operationId: string | null = null,
    changedAt = Date.now()
  ): readonly ReviewCommentThread[] {
    return this.#writeTransaction(() => {
      const rows = this.listReviewCommentThreads(workspaceId, {
        includeResolved: true,
      })
      const remove = this.#database.prepare(
        'DELETE FROM review_comment_threads WHERE id = ?'
      )
      for (const row of rows) {
        remove.run(row.id)
        this.#publishReviewCommentThread(row.id, changedAt, operationId)
      }
      return rows
    })
  }

  /** Rows and both durable ledger cursors captured in one read transaction. */
  snapshot(): LaborerDatabaseSnapshot {
    return this.#readTransaction(() => ({
      labels: this.listLabels(),
      projects: this.listProjects(),
      reviewComments: this.listAllReviewCommentThreads(),
      settings: this.listSettings(),
      stateCursor: this.#ledgerBounds('state_changes').maximum ?? 0,
      taskCursor: this.#ledgerBounds('task_changes').maximum ?? 0,
      tasks: this.listTasks(),
    }))
  }

  taskUpdateAfter(sequence: number): NativeTableUpdate<LaborerTask> | null {
    validateCursorRead(sequence, MAX_LEDGER_READ)
    return this.#readTransaction(() => {
      const bounds = this.#ledgerBounds('task_changes')
      if (this.#cursorNeedsSnapshot(sequence, bounds)) {
        throw new LaborerDatabaseCursorGapError('task_changes', sequence)
      }
      const changes = this.taskChangesAfter(sequence)
      if (changes.length === 0) {
        return null
      }
      this.#assertContiguous(
        sequence,
        changes.map(({ sequence }) => sequence)
      )
      const ids = [...new Set(changes.map(({ taskId }) => taskId))]
      const rows = ids
        .map((id) => this.findTask(id))
        .filter((row): row is LaborerTask => row !== null)
      const present = new Set(rows.map(({ id }) => id))
      return {
        cursor: changes.at(-1)?.sequence ?? sequence,
        deletedRowIds: ids.filter((id) => !present.has(id)),
        operationIds: changes.flatMap(({ operationId }) =>
          operationId === null ? [] : [operationId]
        ),
        rows,
        type: 'delta' as const,
      }
    })
  }

  stateUpdatesAfter(sequence: number): NativeStateUpdates | null {
    validateCursorRead(sequence, MAX_LEDGER_READ)
    return this.#readTransaction(() => {
      const bounds = this.#ledgerBounds('state_changes')
      if (this.#cursorNeedsSnapshot(sequence, bounds)) {
        throw new LaborerDatabaseCursorGapError('state_changes', sequence)
      }
      const changes = this.stateChangesAfter(sequence)
      if (changes.length === 0) {
        return null
      }
      this.#assertContiguous(
        sequence,
        changes.map(({ sequence }) => sequence)
      )
      const cursor = changes.at(-1)?.sequence ?? sequence
      const update = <
        Row extends Project | AppSetting | Label | ReviewCommentThread,
      >(
        tableName: StateChangeTable,
        find: (id: string) => Row | null
      ): NativeTableUpdate<Row> => {
        const tableChanges = changes.filter(
          (change) => change.tableName === tableName
        )
        const ids = [...new Set(tableChanges.map(({ rowId }) => rowId))]
        const rows = ids.map(find).filter((row): row is Row => row !== null)
        const present = new Set(
          rows.map((row) => ('id' in row ? row.id : row.key))
        )
        return {
          cursor,
          deletedRowIds: ids.filter((id) => !present.has(id)),
          operationIds: tableChanges.flatMap(({ operationId }) =>
            operationId === null ? [] : [operationId]
          ),
          rows,
          type: 'delta',
        }
      }
      return {
        labels: update('labels', (id) => this.findLabel(id)),
        projects: update('projects', (id) => this.findProject(id)),
        reviewComments: update('review_comment_threads', (id) =>
          this.findReviewCommentThread(id)
        ),
        settings: update('app_settings', (key) => this.findSetting(key)),
      }
    })
  }

  insertSetting(
    key: string,
    value: string,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<AppSetting> {
    return this.#writeTransaction(() => {
      this.#database
        .prepare(`INSERT INTO app_settings (
          key, value, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 1)`)
        .run(key, value, changedAt, changedAt)
      const cursor = this.#appendStateChange(
        'app_settings',
        key,
        changedAt,
        operationId
      )
      return { row: this.#requireSetting(key), cursor }
    })
  }

  /**
   * Compare-and-set a setting. Revision zero is the sentinel for an absent
   * row, allowing first creation to participate in the same CAS contract.
   */
  setSetting(
    key: string,
    expectedRevision: number,
    value: string,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<AppSetting> {
    if (expectedRevision !== 0) {
      return this.updateSetting(
        key,
        expectedRevision,
        value,
        operationId,
        changedAt
      )
    }
    try {
      return this.insertSetting(key, value, operationId, changedAt)
    } catch (cause) {
      const current = this.findSetting(key)
      if (current !== null) {
        throw new LaborerDatabaseStaleRevisionError(
          'app_settings',
          key,
          expectedRevision,
          current
        )
      }
      throw cause
    }
  }

  updateSetting(
    key: string,
    expectedRevision: number,
    value: string,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<AppSetting> {
    return this.#writeTransaction(() => {
      const result = this.#database
        .prepare(`UPDATE app_settings
          SET value = ?, updated_at = ?, revision = revision + 1
          WHERE key = ? AND revision = ?`)
        .run(value, changedAt, key, expectedRevision)
      if (result.changes === 0) {
        throw new LaborerDatabaseStaleRevisionError(
          'app_settings',
          key,
          expectedRevision,
          this.findSetting(key)
        )
      }
      const cursor = this.#appendStateChange(
        'app_settings',
        key,
        changedAt,
        operationId
      )
      return { row: this.#requireSetting(key), cursor }
    })
  }

  deleteSetting(
    key: string,
    expectedRevision: number,
    operationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<AppSetting> {
    return this.#writeTransaction(() => {
      const row = this.findSetting(key)
      const result = this.#database
        .prepare('DELETE FROM app_settings WHERE key = ? AND revision = ?')
        .run(key, expectedRevision)
      if (result.changes === 0 || row === null) {
        throw new LaborerDatabaseStaleRevisionError(
          'app_settings',
          key,
          expectedRevision,
          this.findSetting(key)
        )
      }
      const cursor = this.#appendStateChange(
        'app_settings',
        key,
        changedAt,
        operationId
      )
      return { row, cursor }
    })
  }

  stateChangesAfter(
    sequence: number,
    limit = MAX_LEDGER_READ
  ): readonly StateChange[] {
    validateCursorRead(sequence, limit)
    return this.#database
      .prepare(`SELECT sequence, table_name, row_id, changed_at, operation_id
        FROM state_changes WHERE sequence > ? ORDER BY sequence LIMIT ?`)
      .all(sequence, limit)
      .map((value) => {
        const row = sqliteRow(value)
        return {
          changedAt: integer(row.changed_at, 'state_changes.changed_at'),
          operationId: nullableString(
            row.operation_id,
            'state_changes.operation_id'
          ),
          rowId: string(row.row_id, 'state_changes.row_id'),
          sequence: integer(row.sequence, 'state_changes.sequence'),
          tableName: enumValue(
            row.table_name,
            STATE_CHANGE_TABLES,
            'state_changes.table_name'
          ),
        }
      })
  }

  #requireTask(id: string): LaborerTask {
    const row = this.findTask(id)
    if (row === null) {
      throw new Error(`Task ${id} could not be read after mutation`)
    }
    return row
  }

  #requireProject(id: string): Project {
    const row = this.findProject(id)
    if (row === null) {
      throw new Error(`Project ${id} could not be read after mutation`)
    }
    return row
  }

  #requireLabel(id: string): Label {
    const row = this.findLabel(id)
    if (row === null) {
      throw new Error(`Label ${id} could not be read after mutation`)
    }
    return row
  }

  #requireReviewCommentThread(id: string): ReviewCommentThread {
    const row = this.findReviewCommentThread(id)
    if (row === null) {
      throw new Error(
        `Review comment thread ${id} could not be read after mutation`
      )
    }
    return row
  }

  /** Oldest first, with the id breaking ties inside one millisecond. */
  #reviewCommentReplies(threadId: string): readonly ReviewCommentReply[] {
    const rows = this.#database
      .prepare(
        `SELECT ${REVIEW_COMMENT_REPLY_COLUMNS} FROM review_comment_replies
         WHERE thread_id = ? ORDER BY created_at, id LIMIT ?`
      )
      .all(threadId, MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'review_comment_replies').map(
      decodeReviewCommentReplyRow
    )
  }

  #findReviewCommentReply(id: string): ReviewCommentReply | null {
    const row = this.#database
      .prepare(
        `SELECT ${REVIEW_COMMENT_REPLY_COLUMNS} FROM review_comment_replies
         WHERE id = ?`
      )
      .get(id)
    return row === undefined || row === null
      ? null
      : decodeReviewCommentReplyRow(row)
  }

  #insertReviewCommentReply(
    id: string,
    threadId: string,
    author: ReviewCommentAuthor,
    body: string,
    createdAt: number
  ): void {
    this.#database
      .prepare(`INSERT INTO review_comment_replies (
        id, thread_id, author, body, created_at
      ) VALUES (?, ?, ?, ?, ?)`)
      .run(id, threadId, author, body, createdAt)
  }

  /**
   * Publishes a thread on the shared state ledger. Replies are children of
   * the thread row, so an appended or edited reply publishes as a change to
   * the thread that carries it — one cursor, one row identity, whatever moved.
   */
  #publishReviewCommentThread(
    threadId: string,
    changedAt: number,
    operationId: string | null
  ): number {
    return this.#appendStateChange(
      'review_comment_threads',
      threadId,
      changedAt,
      operationId
    )
  }

  /** Records that the conversation moved without disturbing its revision. */
  #touchReviewCommentThread(id: string, changedAt: number): void {
    this.#database
      .prepare('UPDATE review_comment_threads SET updated_at = ? WHERE id = ?')
      .run(changedAt, id)
  }

  #stateCursor(): number {
    return this.#ledgerBounds('state_changes').maximum ?? 0
  }

  #taskCursor(): number {
    return this.#ledgerBounds('task_changes').maximum ?? 0
  }

  /** Label ids requested for a task that do not exist at all. */
  #unknownLabelIds(labelIds: readonly string[]): readonly string[] {
    if (labelIds.length === 0) {
      return []
    }
    const known = new Set(
      this.#database
        .prepare(
          `SELECT id FROM labels
           WHERE id IN (${labelIds.map(() => '?').join(', ')})`
        )
        .all(...labelIds)
        .map((row) => string(sqliteRow(row).id, 'labels.id'))
    )
    return labelIds.filter((id) => !known.has(id))
  }

  #stripLabelFromTasks(
    labelId: string,
    changedAt: number,
    operationId: string | null
  ): void {
    const rows = this.#database
      .prepare('SELECT id, label_ids FROM tasks WHERE label_ids LIKE ? LIMIT ?')
      .all(`%${JSON.stringify(labelId)}%`, MAX_TABLE_ROWS + 1)
    const strip = this.#database.prepare(`UPDATE tasks
      SET label_ids = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`)
    for (const value of boundedRows(rows, 'tasks')) {
      const row = sqliteRow(value)
      const taskId = string(row.id, 'tasks.id')
      const labelIds = parseLabelIds(row.label_ids)
      if (!labelIds.includes(labelId)) {
        continue
      }
      strip.run(
        serializeLabelIds(labelIds.filter((id) => id !== labelId)),
        changedAt,
        taskId
      )
      this.#appendTaskChange(taskId, changedAt, operationId)
    }
  }

  #requireSetting(key: string): AppSetting {
    const row = this.findSetting(key)
    if (row === null) {
      throw new Error(`Setting ${key} could not be read after mutation`)
    }
    return row
  }

  #appendTaskChange(
    taskId: string,
    changedAt: number,
    operationId: string | null
  ): number {
    const result = this.#database
      .prepare(`INSERT INTO task_changes (task_id, changed_at, operation_id)
        VALUES (?, ?, ?)`)
      .run(taskId, changedAt, operationId)
    return Number(result.lastInsertRowid)
  }

  #appendStateChange(
    tableName: StateChangeTable,
    rowId: string,
    changedAt: number,
    operationId: string | null
  ): number {
    const result = this.#database
      .prepare(`INSERT INTO state_changes
        (table_name, row_id, changed_at, operation_id) VALUES (?, ?, ?, ?)`)
      .run(tableName, rowId, changedAt, operationId)
    return Number(result.lastInsertRowid)
  }

  #migrate(): void {
    this.#writeTransaction(() => {
      this.#database.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        name TEXT NOT NULL UNIQUE
      )`)
      const applied = this.#database
        .prepare('SELECT name, hash FROM __drizzle_migrations ORDER BY id')
        .all()
        .map(sqliteRow)
      for (const [index, row] of applied.entries()) {
        const name = string(row.name, 'migration name')
        const migration = taskDbMigrations[index]
        if (migration === undefined) {
          throw new LaborerDatabaseSchemaTooNewError(name)
        }
        if (migration.name !== name) {
          throw new Error(
            `Laborer database migration ledger is out of order: expected ${migration.name}, found ${name}`
          )
        }
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        if (hash !== string(row.hash, 'migration hash')) {
          throw new Error(`Laborer database migration hash mismatch: ${name}`)
        }
      }
      const record = this.#database.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
      )
      for (const migration of taskDbMigrations.slice(applied.length)) {
        this.#database.exec(
          migration.sql.replaceAll('--> statement-breakpoint', '')
        )
        record.run(
          createHash('sha256').update(migration.sql).digest('hex'),
          Date.now(),
          migration.name
        )
      }
    })
  }

  #writeTransaction<A>(operation: () => A): A {
    const result = this.#withBusyRetry(() => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.#database.exec('COMMIT')
        return result
      } catch (cause) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Preserve the operation failure.
        }
        throw cause
      }
    })
    notifyLaborerDatabaseWrite(this.#path)
    return result
  }

  #readTransaction<A>(operation: () => A): A {
    this.#database.exec('BEGIN')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (cause) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the read/decode failure so the stream can snapshot-fallback.
      }
      throw cause
    }
  }

  #ledgerBounds(table: 'task_changes' | 'state_changes'): {
    readonly maximum: number | null
    readonly minimum: number | null
  } {
    const row = sqliteRow(
      this.#database
        .prepare(
          `SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum FROM ${table}`
        )
        .get()
    )
    return {
      maximum:
        row.maximum === null ? null : integer(row.maximum, `${table}.maximum`),
      minimum:
        row.minimum === null ? null : integer(row.minimum, `${table}.minimum`),
    }
  }

  #cursorNeedsSnapshot(
    cursor: number,
    bounds: { readonly maximum: number | null; readonly minimum: number | null }
  ): boolean {
    return (
      (bounds.maximum === null && cursor > 0) ||
      (bounds.maximum !== null && cursor > bounds.maximum) ||
      (bounds.maximum !== null && bounds.maximum - cursor > MAX_LEDGER_READ) ||
      (bounds.minimum !== null && bounds.minimum > cursor + 1)
    )
  }

  #assertContiguous(cursor: number, sequences: readonly number[]): void {
    let expected = cursor + 1
    for (const sequence of sequences) {
      if (sequence !== expected) {
        throw new LaborerDatabaseCursorGapError('ledger', cursor)
      }
      expected += 1
    }
  }

  #withBusyRetry<A>(operation: () => A): A {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return operation()
      } catch (cause) {
        if (!isBusy(cause) || attempt >= this.#retry.attempts) {
          if (isBusy(cause)) {
            throw new LaborerDatabaseBusyError(attempt, cause)
          }
          throw cause
        }
        const random = this.#retry.random()
        const jitter =
          0.5 +
          (Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5)
        sleep(
          Math.min(1000, this.#retry.baseDelayMs * 2 ** (attempt - 1) * jitter)
        )
      }
    }
  }
}
