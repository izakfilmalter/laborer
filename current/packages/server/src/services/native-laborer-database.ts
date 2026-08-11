import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { notifyLaborerDatabaseWrite } from './laborer-database-wakeup.js'

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
  readonly parentTaskId: string | null
  readonly prIsDraft: boolean
  readonly prNumber: number | null
  readonly prState: PullRequestState | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  readonly revision: number
  readonly rootPath: string
  readonly setupCompletedAt: number | null
  readonly slackPermalink: string | null
  readonly sortOrder: number | null
  readonly source: TaskSource
  readonly status: TaskStatus
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
  readonly parentTaskId?: string | null
  readonly prIsDraft?: boolean
  readonly prNumber?: number | null
  readonly prState?: PullRequestState | null
  readonly prTitle?: string | null
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
    | 'prIsDraft'
    | 'prNumber'
    | 'prState'
    | 'prTitle'
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
  readonly canonicalGitCommonDir: string
  readonly createdAt: number
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly revision: number
  readonly rootPath: string
  readonly updatedAt: number
}

export interface NewProject {
  readonly canonicalGitCommonDir: string
  readonly createdAt?: number
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly rootPath: string
}

export type ProjectPatch = Partial<
  Pick<Project, 'canonicalGitCommonDir' | 'name' | 'repoId' | 'rootPath'>
>

export interface AppSetting {
  readonly createdAt: number
  readonly key: string
  readonly revision: number
  readonly updatedAt: number
  readonly value: string
}

export interface MutationResult<Row> {
  readonly cursor: number
  readonly row: Row
}

export interface TaskChange {
  readonly changedAt: number
  readonly mutationId: string | null
  readonly sequence: number
  readonly taskId: string
}

export interface StateChange {
  readonly changedAt: number
  readonly mutationId: string | null
  readonly rowId: string
  readonly sequence: number
  readonly tableName: 'projects' | 'app_settings'
}

export interface LaborerDatabaseSnapshot {
  readonly projects: readonly Project[]
  readonly settings: readonly AppSetting[]
  readonly stateCursor: number
  readonly taskCursor: number
  readonly tasks: readonly LaborerTask[]
}

export interface NativeTableUpdate<Row> {
  readonly cursor: number
  readonly deletedRowIds: readonly string[]
  readonly mutationIds: readonly string[]
  readonly rows: readonly Row[]
  readonly type: 'delta'
}

export interface NativeStateUpdates {
  readonly projects: NativeTableUpdate<Project>
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

export class LaborerDatabaseStaleRevisionError<Row> extends Error {
  readonly _tag = 'LaborerDatabaseStaleRevisionError'
  readonly current: Row | null
  readonly expectedRevision: number
  readonly rowId: string
  readonly table: 'tasks' | 'projects' | 'app_settings'
  constructor(
    table: 'tasks' | 'projects' | 'app_settings',
    rowId: string,
    expectedRevision: number,
    current: Row | null
  ) {
    super(`${table} row ${rowId} no longer has revision ${expectedRevision}`)
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
  pr_number, pr_url, pr_title, pr_state, pr_is_draft, sort_order`
const PROJECT_COLUMNS = `id, name, root_path, repo_id, canonical_git_common_dir,
  created_at, updated_at, revision`
const SETTING_COLUMNS = 'key, value, created_at, updated_at, revision'
const MAX_LEDGER_READ = 1000
const MAX_TABLE_ROWS = 10_000
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
  'prIsDraft',
  'prNumber',
  'prState',
  'prTitle',
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
  'canonicalGitCommonDir',
  'name',
  'repoId',
  'rootPath',
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
  prIsDraft: 'pr_is_draft',
  prNumber: 'pr_number',
  prState: 'pr_state',
  prTitle: 'pr_title',
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
  canonicalGitCommonDir: 'canonical_git_common_dir',
  name: 'name',
  repoId: 'repo_id',
  rootPath: 'root_path',
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
const nullableNumber = (value: unknown, column: string): number | null => {
  if (value === null) {
    return null
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalidColumn(column)
}
const enumValue = <A extends string>(
  value: unknown,
  values: readonly A[],
  column: string
): A =>
  typeof value === 'string' && values.includes(value as A)
    ? (value as A)
    : invalidColumn(column)
const nullableEnum = <A extends string>(
  value: unknown,
  values: readonly A[],
  column: string
): A | null => (value === null ? null : enumValue(value, values, column))

const boundedRows = (
  rows: readonly unknown[],
  table: 'tasks' | 'projects' | 'app_settings'
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
    parentTaskId: nullableString(row.parent_task_id, 'tasks.parent_task_id'),
    prIsDraft: (() => {
      const value = integer(row.pr_is_draft, 'tasks.pr_is_draft')
      if (value !== 0 && value !== 1) {
        return invalidColumn('tasks.pr_is_draft')
      }
      return value === 1
    })(),
    prNumber: nullableInteger(row.pr_number, 'tasks.pr_number'),
    prState: nullableEnum(
      row.pr_state,
      ['open', 'closed', 'merged'],
      'tasks.pr_state'
    ),
    prTitle: nullableString(row.pr_title, 'tasks.pr_title'),
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
    canonicalGitCommonDir: string(
      row.canonical_git_common_dir,
      'projects.canonical_git_common_dir'
    ),
    createdAt: integer(row.created_at, 'projects.created_at'),
    id: string(row.id, 'projects.id'),
    name: string(row.name, 'projects.name'),
    repoId: string(row.repo_id, 'projects.repo_id'),
    revision: revision(row.revision, 'projects.revision'),
    rootPath: string(row.root_path, 'projects.root_path'),
    updatedAt: integer(row.updated_at, 'projects.updated_at'),
  }
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
    return row === undefined ? null : rowToTask(row)
  }

  listTasks(): readonly LaborerTask[] {
    const rows = this.#database
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, id LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'tasks').map(rowToTask)
  }

  insertTask(
    input: NewLaborerTask,
    mutationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<LaborerTask> {
    const createdAt = input.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision, worktree_status,
          worktree_error, setup_completed_at, parent_task_id, base_sha,
          base_branch, pr_number, pr_url, pr_title, pr_state, pr_is_draft,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          input.sortOrder ?? null
        )
      const cursor = this.#appendTaskChange(input.id, changedAt, mutationId)
      return { row: this.#requireTask(input.id), cursor }
    })
  }

  updateTask(
    id: string,
    expectedRevision: number,
    patch: LaborerTaskPatch,
    mutationId: string | null = null,
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
          ...entries.map(([field, value]) => {
            if (field === 'prIsDraft') {
              return value ? 1 : 0
            }
            if (typeof value === 'boolean') {
              return value ? 1 : 0
            }
            return value ?? null
          }),
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
      const cursor = this.#appendTaskChange(id, changedAt, mutationId)
      return { row: this.#requireTask(id), cursor }
    })
  }

  deleteTask(
    id: string,
    expectedRevision: number,
    mutationId: string | null = null,
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
      const cursor = this.#appendTaskChange(id, changedAt, mutationId)
      return { row, cursor }
    })
  }

  taskChangesAfter(
    sequence: number,
    limit = MAX_LEDGER_READ
  ): readonly TaskChange[] {
    validateCursorRead(sequence, limit)
    return this.#database
      .prepare(`SELECT sequence, task_id, changed_at, mutation_id
        FROM task_changes WHERE sequence > ? ORDER BY sequence LIMIT ?`)
      .all(sequence, limit)
      .map((value) => {
        const row = sqliteRow(value)
        return {
          changedAt: integer(row.changed_at, 'task_changes.changed_at'),
          mutationId: nullableString(
            row.mutation_id,
            'task_changes.mutation_id'
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
    return row === undefined ? null : rowToProject(row)
  }

  listProjects(): readonly Project[] {
    const rows = this.#database
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects
          ORDER BY created_at, id LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'projects').map(rowToProject)
  }

  insertProject(
    input: NewProject,
    mutationId: string | null = null,
    changedAt = Date.now()
  ): MutationResult<Project> {
    const createdAt = input.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      this.#database
        .prepare(`INSERT INTO projects (
          id, name, root_path, repo_id, canonical_git_common_dir,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(
          input.id,
          input.name,
          input.rootPath,
          input.repoId,
          input.canonicalGitCommonDir,
          createdAt,
          changedAt
        )
      const cursor = this.#appendStateChange(
        'projects',
        input.id,
        changedAt,
        mutationId
      )
      return { row: this.#requireProject(input.id), cursor }
    })
  }

  updateProject(
    id: string,
    expectedRevision: number,
    patch: ProjectPatch,
    mutationId: string | null = null,
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
        mutationId
      )
      return { row: this.#requireProject(id), cursor }
    })
  }

  deleteProject(
    id: string,
    expectedRevision: number,
    mutationId: string | null = null,
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
        mutationId
      )
      return { row, cursor }
    })
  }

  findSetting(key: string): AppSetting | null {
    const row = this.#database
      .prepare(`SELECT ${SETTING_COLUMNS} FROM app_settings WHERE key = ?`)
      .get(key)
    return row === undefined ? null : rowToSetting(row)
  }

  listSettings(): readonly AppSetting[] {
    const rows = this.#database
      .prepare(
        `SELECT ${SETTING_COLUMNS} FROM app_settings ORDER BY key LIMIT ?`
      )
      .all(MAX_TABLE_ROWS + 1)
    return boundedRows(rows, 'app_settings').map(rowToSetting)
  }

  /** Rows and both durable ledger cursors captured in one read transaction. */
  snapshot(): LaborerDatabaseSnapshot {
    return this.#readTransaction(() => ({
      projects: this.listProjects(),
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
        mutationIds: changes.flatMap(({ mutationId }) =>
          mutationId === null ? [] : [mutationId]
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
      const update = <Row extends Project | AppSetting>(
        tableName: 'projects' | 'app_settings',
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
          mutationIds: tableChanges.flatMap(({ mutationId }) =>
            mutationId === null ? [] : [mutationId]
          ),
          rows,
          type: 'delta',
        }
      }
      return {
        projects: update('projects', (id) => this.findProject(id)),
        settings: update('app_settings', (key) => this.findSetting(key)),
      }
    })
  }

  insertSetting(
    key: string,
    value: string,
    mutationId: string | null = null,
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
        mutationId
      )
      return { row: this.#requireSetting(key), cursor }
    })
  }

  updateSetting(
    key: string,
    expectedRevision: number,
    value: string,
    mutationId: string | null = null,
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
        mutationId
      )
      return { row: this.#requireSetting(key), cursor }
    })
  }

  deleteSetting(
    key: string,
    expectedRevision: number,
    mutationId: string | null = null,
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
        mutationId
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
      .prepare(`SELECT sequence, table_name, row_id, changed_at, mutation_id
        FROM state_changes WHERE sequence > ? ORDER BY sequence LIMIT ?`)
      .all(sequence, limit)
      .map((value) => {
        const row = sqliteRow(value)
        return {
          changedAt: integer(row.changed_at, 'state_changes.changed_at'),
          mutationId: nullableString(
            row.mutation_id,
            'state_changes.mutation_id'
          ),
          rowId: string(row.row_id, 'state_changes.row_id'),
          sequence: integer(row.sequence, 'state_changes.sequence'),
          tableName: enumValue(
            row.table_name,
            ['projects', 'app_settings'],
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
    mutationId: string | null
  ): number {
    const result = this.#database
      .prepare(`INSERT INTO task_changes (task_id, changed_at, mutation_id)
        VALUES (?, ?, ?)`)
      .run(taskId, changedAt, mutationId)
    return Number(result.lastInsertRowid)
  }

  #appendStateChange(
    tableName: 'projects' | 'app_settings',
    rowId: string,
    changedAt: number,
    mutationId: string | null
  ): number {
    const result = this.#database
      .prepare(`INSERT INTO state_changes
        (table_name, row_id, changed_at, mutation_id) VALUES (?, ?, ?, ?)`)
      .run(tableName, rowId, changedAt, mutationId)
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
