import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer, Schema } from 'effect'
import { taskDbMigrations } from './migrations.ts'
import { taskDatabasePath as resolveTaskDatabasePath } from './path.ts'

export const ACTION_TITLE_MAX_LENGTH = 100

export const ActionTitle = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(ACTION_TITLE_MAX_LENGTH)
).annotate({
  description: 'A short, nonblank title for the Action Execution.',
})

const require = createRequire(import.meta.url)

const openDatabase = (path: string): DatabaseSync => {
  const { DatabaseSync: NativeDatabase } =
    require('node:sqlite') as typeof import('node:sqlite')
  return new NativeDatabase(path, { timeout: 5000 })
}

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

export interface Task {
  readonly actionName: string | null
  readonly branchName: string | null
  readonly createdAt: number
  readonly description: string | null
  readonly executionId: string | null
  readonly executionStatus: ExecutionStatus | null
  readonly id: string
  readonly revision: number
  readonly rootPath: string
  readonly slackPermalink: string | null
  readonly source: TaskSource
  readonly status: TaskStatus
  readonly title: string
  readonly updatedAt: number
  readonly worktreePath: string | null
}

export interface NewTask {
  readonly actionName?: string | null
  readonly branchName?: string | null
  readonly createdAt?: number
  readonly description?: string | null
  readonly executionId?: string | null
  readonly executionStatus?: ExecutionStatus | null
  readonly id: string
  readonly rootPath: string
  readonly slackPermalink?: string | null
  readonly source: TaskSource
  readonly status: TaskStatus
  readonly title: string
  readonly worktreePath?: string | null
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'status'
    | 'executionStatus'
    | 'slackPermalink'
    | 'worktreePath'
    | 'branchName'
    | 'description'
  >
>

export class TaskDatabaseError extends Error {
  readonly _tag = 'TaskDatabaseError'
  override readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.cause = cause
  }
}

export class TaskDatabaseSchemaTooNewError extends Error {
  readonly _tag = 'TaskDatabaseSchemaTooNewError'
  readonly migration: string
  constructor(migration: string) {
    super(`Task database schema is newer than this binary: ${migration}`)
    this.migration = migration
  }
}

export class TaskDatabaseBusyError extends Error {
  readonly _tag = 'TaskDatabaseBusyError'
  override readonly cause: unknown
  readonly attempts: number
  constructor(attempts: number, cause: unknown) {
    super(`Task database remained busy after ${attempts} attempts`)
    this.attempts = attempts
    this.cause = cause
  }
}

export class TaskStaleRevisionError extends Error {
  readonly _tag = 'TaskStaleRevisionError'
  readonly taskId: string
  readonly expectedRevision: number
  readonly current: Task | null
  constructor(taskId: string, expectedRevision: number, current: Task | null) {
    super(`Task ${taskId} no longer has revision ${expectedRevision}`)
    this.taskId = taskId
    this.expectedRevision = expectedRevision
    this.current = current
  }
}

interface RetryOptions {
  readonly attempts?: number
  readonly baseDelayMs?: number
  readonly random?: () => number
}

const TASK_COLUMNS = `id, root_path, title, status, source, execution_id,
  action_name, execution_status, slack_permalink, worktree_path, branch_name,
  description, created_at, updated_at, revision`

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  status: 'status',
  executionStatus: 'execution_status',
  slackPermalink: 'slack_permalink',
  worktreePath: 'worktree_path',
  branchName: 'branch_name',
  description: 'description',
}

type SqliteRow = Record<string, unknown>
const isSqliteRow = (value: unknown): value is SqliteRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const sqliteRow = (value: unknown): SqliteRow => {
  if (!isSqliteRow(value)) {
    throw new Error('Task database returned an invalid row')
  }
  return value
}
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked/i

const isBusy = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? String(error.code) : ''
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_BUSY_SNAPSHOT' ||
    BUSY_MESSAGE.test(error.message)
  )
}

const sleepSync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const invalidColumn = (column: string): never => {
  throw new Error(`Task database contains an invalid ${column}`)
}

const requiredString = (value: unknown, column: string): string => {
  if (typeof value !== 'string') {
    return invalidColumn(column)
  }
  return value
}

const nullableString = (value: unknown, column: string): string | null => {
  if (value === null) {
    return null
  }
  return requiredString(value, column)
}

const safeInteger = (value: unknown, column: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalidColumn(column)
  }
  return value
}

const taskStatus = (value: unknown): TaskStatus => {
  switch (value) {
    case 'todo':
    case 'in_progress':
    case 'in_review':
    case 'done':
    case 'cancelled':
      return value
    default:
      return invalidColumn('status')
  }
}

const taskSource = (value: unknown): TaskSource => {
  switch (value) {
    case 'execution':
    case 'manual':
    case 'slack_url':
    case 'agent':
    case 'worktree':
      return value
    default:
      return invalidColumn('source')
  }
}

const executionStatus = (value: unknown): ExecutionStatus | null => {
  switch (value) {
    case null:
    case 'queued':
    case 'running':
    case 'cancelling':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'needs-attention':
      return value
    default:
      return invalidColumn('execution_status')
  }
}

const rowToTask = (row: SqliteRow): Task => {
  const revision = safeInteger(row.revision, 'revision')
  if (revision < 1) {
    return invalidColumn('revision')
  }
  return {
    id: requiredString(row.id, 'id'),
    rootPath: requiredString(row.root_path, 'root_path'),
    title: requiredString(row.title, 'title'),
    status: taskStatus(row.status),
    source: taskSource(row.source),
    executionId: nullableString(row.execution_id, 'execution_id'),
    actionName: nullableString(row.action_name, 'action_name'),
    executionStatus: executionStatus(row.execution_status),
    slackPermalink: nullableString(row.slack_permalink, 'slack_permalink'),
    worktreePath: nullableString(row.worktree_path, 'worktree_path'),
    branchName: nullableString(row.branch_name, 'branch_name'),
    description: nullableString(row.description, 'description'),
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision,
  }
}

export const taskDatabasePath = resolveTaskDatabasePath

export class NativeTaskDatabase {
  readonly #database: DatabaseSync
  readonly #retry: Required<RetryOptions>

  private constructor(database: DatabaseSync, retry: RetryOptions) {
    this.#database = database
    const attempts = retry.attempts ?? 5
    const baseDelayMs = retry.baseDelayMs ?? 10
    if (!(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 10)) {
      throw new Error('Task database retry attempts must be between 1 and 10')
    }
    if (
      !(Number.isFinite(baseDelayMs) && baseDelayMs >= 0 && baseDelayMs <= 1000)
    ) {
      throw new Error(
        'Task database retry base delay must be between 0 and 1000ms'
      )
    }
    this.#retry = {
      attempts,
      baseDelayMs,
      random: retry.random ?? Math.random,
    }
  }

  static open(
    path = taskDatabasePath(),
    retry: RetryOptions = {}
  ): NativeTaskDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const database = openDatabase(path)
    try {
      const result = new NativeTaskDatabase(database, retry)
      database.exec('PRAGMA busy_timeout = 5000')
      result.#withBusyRetry(() => database.exec('PRAGMA journal_mode = WAL'))
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA foreign_keys = ON')
      result.#migrate()
      return result
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.#database.close()
  }

  find(id: string): Task | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id)
    return row === undefined ? null : rowToTask(sqliteRow(row))
  }

  findByExecutionId(executionId: string): Task | null {
    return this.#findByExecutionId(executionId)
  }

  insert(
    input: NewTask,
    changedAt = Date.now()
  ): { task: Task; inserted: boolean } {
    const createdAt = input.createdAt ?? changedAt
    const inserted = this.#transaction(() => {
      const result = this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(execution_id) DO NOTHING`)
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
          changedAt
        )
      if (result.changes === 0) {
        return false
      }
      this.#appendChange(input.id, changedAt)
      return true
    })
    let task = inserted ? this.find(input.id) : null
    if (!(inserted || !input.executionId)) {
      task = this.#findByExecutionId(input.executionId)
    }
    if (!task) {
      throw new Error(`Inserted task ${input.id} could not be read`)
    }
    return { task, inserted }
  }

  update(
    id: string,
    expectedRevision: number,
    patch: TaskPatch,
    changedAt = Date.now()
  ): Task {
    const entries = (
      [
        'title',
        'status',
        'executionStatus',
        'slackPermalink',
        'worktreePath',
        'branchName',
        'description',
      ] as const
    )
      .filter((field) => Object.hasOwn(patch, field))
      .map((field) => [field, patch[field]] as const)
    if (entries.length === 0) {
      throw new Error('A task update requires at least one field')
    }
    return this.#transaction(() => {
      const assignments = entries.map(
        ([field]) => `${PATCH_COLUMNS[field]} = ?`
      )
      const values = entries.map(([, value]) => value ?? null)
      const result = this.#database
        .prepare(`UPDATE tasks SET ${assignments.join(', ')},
          updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(...values, changedAt, id, expectedRevision)
      if (result.changes === 0) {
        throw new TaskStaleRevisionError(id, expectedRevision, this.find(id))
      }
      this.#appendChange(id, changedAt)
      const task = this.find(id)
      if (!task) {
        throw new Error(`Updated task ${id} could not be read`)
      }
      return task
    })
  }

  changesAfter(
    sequence: number,
    limit = 1000
  ): readonly { sequence: number; taskId: string; changedAt: number }[] {
    if (!(Number.isSafeInteger(sequence) && sequence >= 0)) {
      throw new Error('A task change cursor must be a nonnegative integer')
    }
    if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000)) {
      throw new Error('A task change limit must be between 1 and 1000')
    }
    return this.#database
      .prepare(
        'SELECT sequence, task_id, changed_at FROM task_changes WHERE sequence > ? ORDER BY sequence LIMIT ?'
      )
      .all(sequence, limit)
      .map((value) => {
        const row = sqliteRow(value)
        return {
          sequence: safeInteger(row.sequence, 'task_changes.sequence'),
          taskId: requiredString(row.task_id, 'task_changes.task_id'),
          changedAt: safeInteger(row.changed_at, 'task_changes.changed_at'),
        }
      })
  }

  migrationNames(): readonly string[] {
    return this.#database
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY id')
      .all()
      .map((value) => requiredString(sqliteRow(value).name, 'migration name'))
  }

  #findByExecutionId(executionId: string): Task | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE execution_id = ?`)
      .get(executionId)
    return row === undefined ? null : rowToTask(sqliteRow(row))
  }

  #appendChange(taskId: string, changedAt: number): void {
    this.#database
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run(taskId, changedAt)
  }

  #migrate(): void {
    this.#transaction(() => {
      this.#database.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        name TEXT NOT NULL UNIQUE
      )`)
      const applied = this.#database
        .prepare('SELECT name, hash FROM __drizzle_migrations ORDER BY id')
        .all()
        .map((value) => {
          const row = sqliteRow(value)
          return {
            name: requiredString(row.name, 'migration name'),
            hash: requiredString(row.hash, 'migration hash'),
          }
        })
      for (const [index, row] of applied.entries()) {
        const migration = taskDbMigrations[index]
        if (
          !(migration && taskDbMigrations.some(({ name }) => name === row.name))
        ) {
          throw new TaskDatabaseSchemaTooNewError(row.name)
        }
        if (migration.name !== row.name) {
          throw new Error(
            `Task database migration ledger is out of order: expected ${migration.name}, found ${row.name}`
          )
        }
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        if (hash !== row.hash) {
          throw new Error(`Task database migration hash mismatch: ${row.name}`)
        }
      }
      for (const migration of taskDbMigrations.slice(applied.length)) {
        this.#database.exec(
          migration.sql.replaceAll('--> statement-breakpoint', '')
        )
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        this.#database
          .prepare(
            'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
          )
          .run(hash, Date.now(), migration.name)
      }
    })
  }

  #transaction<A>(operation: () => A): A {
    return this.#withBusyRetry(() => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.#database.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Preserve the operation failure.
        }
        throw error
      }
    })
  }

  #withBusyRetry<A>(operation: () => A): A {
    let attempt = 0
    while (true) {
      try {
        return operation()
      } catch (error) {
        attempt += 1
        if (!isBusy(error) || attempt >= this.#retry.attempts) {
          if (isBusy(error)) {
            throw new TaskDatabaseBusyError(attempt, error)
          }
          throw error
        }
        const random = this.#retry.random()
        const jitter =
          0.5 +
          (Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5)
        sleepSync(
          Math.min(1000, this.#retry.baseDelayMs * 2 ** (attempt - 1) * jitter)
        )
      }
    }
  }
}

type TaskDbFailure =
  | TaskDatabaseBusyError
  | TaskDatabaseError
  | TaskDatabaseSchemaTooNewError
  | TaskStaleRevisionError

const effectTry = <A>(operation: () => A): Effect.Effect<A, TaskDbFailure> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof TaskDatabaseSchemaTooNewError ||
      cause instanceof TaskDatabaseBusyError ||
      cause instanceof TaskStaleRevisionError
        ? cause
        : new TaskDatabaseError('Task database operation failed', cause),
  })

export class TaskDb extends Context.Service<
  TaskDb,
  {
    readonly find: (id: string) => Effect.Effect<Task | null, TaskDbFailure>
    readonly changesAfter: (
      sequence: number,
      limit?: number
    ) => Effect.Effect<
      readonly { sequence: number; taskId: string; changedAt: number }[],
      TaskDbFailure
    >
    readonly insert: (
      input: NewTask,
      changedAt?: number
    ) => Effect.Effect<{ task: Task; inserted: boolean }, TaskDbFailure>
    readonly update: (
      id: string,
      expectedRevision: number,
      patch: TaskPatch,
      changedAt?: number
    ) => Effect.Effect<Task, TaskDbFailure>
  }
>()('@laborer/task-db/TaskDb') {
  static layer(path = taskDatabasePath()): Layer.Layer<TaskDb, TaskDbFailure> {
    return Layer.effect(
      TaskDb,
      Effect.acquireRelease(
        effectTry(() => NativeTaskDatabase.open(path)),
        (database) => Effect.sync(() => database.close())
      ).pipe(
        Effect.map((database) => ({
          changesAfter: (sequence: number, limit?: number) =>
            effectTry(() => database.changesAfter(sequence, limit)),
          find: (id: string) => effectTry(() => database.find(id)),
          insert: (input: NewTask, changedAt?: number) =>
            effectTry(() => database.insert(input, changedAt)),
          update: (
            id: string,
            expectedRevision: number,
            patch: TaskPatch,
            changedAt?: number
          ) =>
            effectTry(() =>
              database.update(id, expectedRevision, patch, changedAt)
            ),
        }))
      )
    )
  }
}
