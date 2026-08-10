import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ExecutionStatus,
  Task,
  TaskRead,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from '@laborer/task-db'
import { taskDbMigrations } from '@laborer/task-db/migrations'

const TASK_COLUMNS = `id, root_path, title, status, source, execution_id,
  action_name, execution_status, slack_permalink, worktree_path, branch_name,
  initial_prompt, created_at, updated_at, revision`
const MAX_SNAPSHOT_TASKS = 10_000
const MAX_BUSY_ATTEMPTS = 5
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked/i

type SqliteRow = Record<string, unknown>

const isSqliteRow = (value: unknown): value is SqliteRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  (('code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_BUSY_SNAPSHOT')) ||
    BUSY_MESSAGE.test(error.message))

const sleepSync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const invalidColumn = (column: string): never => {
  throw new Error(`Task database contains an invalid ${column}`)
}

const sqliteRow = (value: unknown): SqliteRow => {
  if (!isSqliteRow(value)) {
    throw new Error('Task database returned an invalid row')
  }
  return value
}

const requiredString = (value: unknown, column: string): string =>
  typeof value === 'string' ? value : invalidColumn(column)

const nullableString = (value: unknown, column: string): string | null =>
  value === null ? null : requiredString(value, column)

const safeInteger = (value: unknown, column: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : invalidColumn(column)

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
    actionName: nullableString(row.action_name, 'action_name'),
    branchName: nullableString(row.branch_name, 'branch_name'),
    createdAt: safeInteger(row.created_at, 'created_at'),
    executionId: nullableString(row.execution_id, 'execution_id'),
    executionStatus: executionStatus(row.execution_status),
    id: requiredString(row.id, 'id'),
    initialPrompt: nullableString(row.initial_prompt, 'initial_prompt'),
    revision,
    rootPath: requiredString(row.root_path, 'root_path'),
    slackPermalink: nullableString(row.slack_permalink, 'slack_permalink'),
    source: taskSource(row.source),
    status: taskStatus(row.status),
    title: requiredString(row.title, 'title'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    worktreePath: nullableString(row.worktree_path, 'worktree_path'),
  }
}

/** Node/Electron-compatible connection to the shared task DB. */
export class NodeTaskBoardDatabase {
  readonly #database: DatabaseSync

  private constructor(database: DatabaseSync) {
    this.#database = database
  }

  static open(path: string): NodeTaskBoardDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA foreign_keys = ON')
      const result = new NodeTaskBoardDatabase(database)
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

  snapshot(): TaskSnapshot {
    return this.#readTransaction(() => this.#snapshotUnsafe())
  }

  readChanges(sequence: number, limit = 1000): TaskRead {
    if (!(Number.isSafeInteger(sequence) && sequence >= 0)) {
      throw new Error('A task change cursor must be a nonnegative integer')
    }
    if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000)) {
      throw new Error('A task change limit must be between 1 and 1000')
    }

    return this.#readTransaction(() => {
      const bounds = sqliteRow(
        this.#database
          .prepare(
            'SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum FROM task_changes'
          )
          .get()
      )
      const minimum =
        bounds.minimum === null
          ? null
          : safeInteger(bounds.minimum, 'task_changes.minimum')
      const maximum =
        bounds.maximum === null
          ? null
          : safeInteger(bounds.maximum, 'task_changes.maximum')
      if (
        (maximum === null && sequence > 0) ||
        (maximum !== null && sequence > maximum) ||
        (minimum !== null && minimum > sequence + 1)
      ) {
        return this.#snapshotUnsafe()
      }

      const changes = this.#database
        .prepare(
          'SELECT sequence, task_id FROM task_changes WHERE sequence > ? ORDER BY sequence LIMIT ?'
        )
        .all(sequence, limit)
        .map(sqliteRow)
      if (
        changes.some(
          (change, index) =>
            safeInteger(change.sequence, 'task_changes.sequence') !==
            sequence + index + 1
        )
      ) {
        return this.#snapshotUnsafe()
      }

      const taskIds = [
        ...new Set(
          changes.map((change) =>
            requiredString(change.task_id, 'task_changes.task_id')
          )
        ),
      ]
      const tasks: Task[] = []
      const deletedTaskIds: string[] = []
      const findTask = this.#database.prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`
      )
      for (const taskId of taskIds) {
        const row = findTask.get(taskId)
        if (row === undefined) {
          deletedTaskIds.push(taskId)
        } else {
          tasks.push(rowToTask(sqliteRow(row)))
        }
      }

      const last = changes.at(-1)
      return {
        _tag: 'delta',
        cursor:
          last === undefined
            ? sequence
            : safeInteger(last.sequence, 'task_changes.sequence'),
        deletedTaskIds,
        tasks,
      }
    })
  }

  /**
   * Persist a human status declaration. A stale caller revision is compared
   * with the row under the write lock: an already-applied declaration is
   * idempotent, while a different winning status is left untouched.
   */
  move(
    id: string,
    expectedRevision: number,
    status: TaskStatus,
    changedAt = Date.now()
  ): Task {
    if (!(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) {
      throw new Error('A task move requires a positive expected revision')
    }
    return this.#writeTransaction(() => {
      const find = this.#database.prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`
      )
      const initialRow = find.get(id)
      if (initialRow === undefined) {
        throw new Error(`Task not found: ${id}`)
      }
      const initial = rowToTask(sqliteRow(initialRow))
      if (status === 'cancelled' && initial.source === 'execution') {
        throw new Error('Execution tasks cannot be cancelled from the board')
      }
      if (initial.status === status) {
        return initial
      }
      if (initial.revision !== expectedRevision) {
        throw new Error(`Task changed while moving: ${id}`)
      }

      const update = this.#database.prepare(`UPDATE tasks
        SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`)
      const result = update.run(status, changedAt, id, expectedRevision)
      if (result.changes === 0) {
        throw new Error(`Task changed while moving: ${id}`)
      }
      this.#database
        .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
        .run(id, changedAt)
      const movedRow = find.get(id)
      if (movedRow === undefined) {
        throw new Error(`Moved task could not be read: ${id}`)
      }
      return rowToTask(sqliteRow(movedRow))
    })
  }

  #snapshotUnsafe(): TaskSnapshot {
    const rows = this.#database
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, id LIMIT ?`
      )
      .all(MAX_SNAPSHOT_TASKS + 1)
    if (rows.length > MAX_SNAPSHOT_TASKS) {
      throw new Error(
        `Task board snapshot exceeds the ${MAX_SNAPSHOT_TASKS} task limit`
      )
    }
    const cursor = sqliteRow(
      this.#database
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS cursor FROM task_changes'
        )
        .get()
    )
    return {
      _tag: 'snapshot',
      cursor: safeInteger(cursor.cursor, 'task_changes.cursor'),
      tasks: rows.map((row) => rowToTask(sqliteRow(row))),
    }
  }

  #migrate(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
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
        const migration = taskDbMigrations[index]
        const name = requiredString(row.name, 'migration name')
        if (!migration || migration.name !== name) {
          throw new Error(
            `Task database migration ledger is invalid at ${name}`
          )
        }
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        if (hash !== requiredString(row.hash, 'migration hash')) {
          throw new Error(`Task database migration hash mismatch: ${name}`)
        }
      }
      const insertMigration = this.#database.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
      )
      for (const migration of taskDbMigrations.slice(applied.length)) {
        this.#database.exec(
          migration.sql.replaceAll('--> statement-breakpoint', '')
        )
        const hash = createHash('sha256').update(migration.sql).digest('hex')
        insertMigration.run(hash, Date.now(), migration.name)
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure.
      }
      throw error
    }
  }

  #readTransaction<A>(operation: () => A): A {
    this.#database.exec('BEGIN')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the read failure.
      }
      throw error
    }
  }

  #writeTransaction<A>(operation: () => A): A {
    let attempt = 0
    while (true) {
      try {
        this.#database.exec('BEGIN IMMEDIATE')
        try {
          const result = operation()
          this.#database.exec('COMMIT')
          return result
        } catch (error) {
          try {
            this.#database.exec('ROLLBACK')
          } catch {
            // Preserve the write failure.
          }
          throw error
        }
      } catch (error) {
        attempt += 1
        if (!(isBusy(error) && attempt < MAX_BUSY_ATTEMPTS)) {
          throw error
        }
        const jitter = 0.5 + Math.random()
        sleepSync(10 * 2 ** (attempt - 1) * jitter)
      }
    }
  }
}
