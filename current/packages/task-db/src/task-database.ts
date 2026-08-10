import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite'
import { Context, Effect, Layer } from 'effect'
import { taskDbMigrations } from './migrations.ts'
import { taskChanges, tasks } from './schema.sql.ts'

const schema = { taskChanges, tasks }

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'
export type TaskSource = 'execution' | 'manual' | 'slack_url'
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
  readonly executionId: string | null
  readonly executionStatus: ExecutionStatus | null
  readonly id: string
  readonly initialPrompt: string | null
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
  readonly executionId?: string | null
  readonly executionStatus?: ExecutionStatus | null
  readonly id: string
  readonly initialPrompt?: string | null
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
    | 'initialPrompt'
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
  initial_prompt, created_at, updated_at, revision`

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  status: 'status',
  executionStatus: 'execution_status',
  slackPermalink: 'slack_permalink',
  worktreePath: 'worktree_path',
  branchName: 'branch_name',
  initialPrompt: 'initial_prompt',
}

type SqliteRow = Record<string, unknown>
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

const rowToTask = (row: SqliteRow): Task => ({
  id: String(row.id),
  rootPath: String(row.root_path),
  title: String(row.title),
  status: String(row.status) as TaskStatus,
  source: String(row.source) as TaskSource,
  executionId: row.execution_id === null ? null : String(row.execution_id),
  actionName: row.action_name === null ? null : String(row.action_name),
  executionStatus:
    row.execution_status === null
      ? null
      : (String(row.execution_status) as ExecutionStatus),
  slackPermalink:
    row.slack_permalink === null ? null : String(row.slack_permalink),
  worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
  branchName: row.branch_name === null ? null : String(row.branch_name),
  initialPrompt:
    row.initial_prompt === null ? null : String(row.initial_prompt),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  revision: Number(row.revision),
})

export const taskDatabasePath = (
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string => {
  const xdgStateHome = environment.XDG_STATE_HOME?.trim()
  const stateHome =
    xdgStateHome && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, '.local', 'state')
  return join(stateHome, 'laborer', 'laborer.sqlite')
}

export class NativeTaskDatabase {
  readonly #database: Database
  readonly #retry: Required<RetryOptions>
  readonly drizzle: BunSQLiteDatabase<typeof schema>

  private constructor(database: Database, retry: RetryOptions) {
    this.#database = database
    this.drizzle = drizzle(database, { schema })
    this.#retry = {
      attempts: retry.attempts ?? 5,
      baseDelayMs: retry.baseDelayMs ?? 10,
      random: retry.random ?? Math.random,
    }
  }

  static open(
    path = taskDatabasePath(),
    retry: RetryOptions = {}
  ): NativeTaskDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const database = new Database(path, { create: true, strict: true })
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA foreign_keys = ON')
      const result = new NativeTaskDatabase(database, retry)
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
      .query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as SqliteRow | undefined
    return row ? rowToTask(row) : null
  }

  insert(
    input: NewTask,
    changedAt = Date.now()
  ): { task: Task; inserted: boolean } {
    const createdAt = input.createdAt ?? changedAt
    const inserted = this.#transaction(() => {
      const result = this.#database
        .query(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          initial_prompt, created_at, updated_at, revision
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
          input.initialPrompt ?? null,
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
    const entries = Object.entries(patch) as [
      keyof TaskPatch,
      TaskPatch[keyof TaskPatch],
    ][]
    if (entries.length === 0) {
      throw new Error('A task update requires at least one field')
    }
    return this.#transaction(() => {
      const assignments = entries.map(
        ([field]) => `${PATCH_COLUMNS[field]} = ?`
      )
      const values = entries.map(([, value]) => value ?? null)
      const result = this.#database
        .query(`UPDATE tasks SET ${assignments.join(', ')},
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

  changesFor(
    taskId: string
  ): readonly { sequence: number; changedAt: number }[] {
    const rows = this.#database
      .query(
        'SELECT sequence, changed_at FROM task_changes WHERE task_id = ? ORDER BY sequence'
      )
      .all(taskId) as SqliteRow[]
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      changedAt: Number(row.changed_at),
    }))
  }

  migrationNames(): readonly string[] {
    const rows = this.#database
      .query('SELECT name FROM __drizzle_migrations ORDER BY id')
      .all() as SqliteRow[]
    return rows.map((row) => String(row.name))
  }

  #findByExecutionId(executionId: string): Task | null {
    const row = this.#database
      .query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE execution_id = ?`)
      .get(executionId) as SqliteRow | undefined
    return row ? rowToTask(row) : null
  }

  #appendChange(taskId: string, changedAt: number): void {
    this.#database
      .query('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
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
        .query('SELECT name, hash FROM __drizzle_migrations ORDER BY id')
        .all() as { name: string; hash: string }[]
      for (const row of applied) {
        const migration = taskDbMigrations.find(({ name }) => name === row.name)
        if (!migration) {
          console.error('[task-db] Refusing newer task database schema', {
            migration: row.name,
          })
          throw new TaskDatabaseSchemaTooNewError(row.name)
        }
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        if (hash !== row.hash) {
          throw new Error(`Task database migration hash mismatch: ${row.name}`)
        }
      }
      const completed = new Set(applied.map(({ name }) => name))
      for (const migration of taskDbMigrations) {
        if (completed.has(migration.name)) {
          continue
        }
        this.#database.exec(
          migration.sql.replaceAll('--> statement-breakpoint', '')
        )
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        this.#database
          .query(
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
          throw error
        }
        const jitter = 0.5 + this.#retry.random()
        sleepSync(this.#retry.baseDelayMs * 2 ** (attempt - 1) * jitter)
      }
    }
  }
}

type TaskDbFailure =
  | TaskDatabaseError
  | TaskDatabaseSchemaTooNewError
  | TaskStaleRevisionError

const effectTry = <A>(operation: () => A): Effect.Effect<A, TaskDbFailure> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof TaskDatabaseSchemaTooNewError ||
      cause instanceof TaskStaleRevisionError
        ? cause
        : new TaskDatabaseError('Task database operation failed', cause),
  })

export class TaskDb extends Context.Tag('@laborer/task-db/TaskDb')<
  TaskDb,
  {
    readonly find: (id: string) => Effect.Effect<Task | null, TaskDbFailure>
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
>() {
  static layer(path = taskDatabasePath()): Layer.Layer<TaskDb, TaskDbFailure> {
    return Layer.scoped(
      TaskDb,
      Effect.acquireRelease(
        effectTry(() => NativeTaskDatabase.open(path)),
        (database) => Effect.sync(() => database.close())
      ).pipe(
        Effect.map((database) =>
          TaskDb.of({
            find: (id) => effectTry(() => database.find(id)),
            insert: (input, changedAt) =>
              effectTry(() => database.insert(input, changedAt)),
            update: (id, expectedRevision, patch, changedAt) =>
              effectTry(() =>
                database.update(id, expectedRevision, patch, changedAt)
              ),
          })
        )
      )
    )
  }
}
