import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ExecutionStatus,
  NewTask,
  Task,
  TaskPatch,
  TaskRead,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from '@laborer/task-db'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { notifyLaborerDatabaseWrite } from './laborer-database-wakeup.js'

const TASK_COLUMNS = `id, root_path, title, status, source, execution_id,
  action_name, execution_status, slack_permalink, worktree_path, branch_name,
  description, created_at, updated_at, revision`
const MAX_SNAPSHOT_TASKS = 10_000
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked/i
const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  status: 'status',
  executionStatus: 'execution_status',
  slackPermalink: 'slack_permalink',
  worktreePath: 'worktree_path',
  branchName: 'branch_name',
  description: 'description',
}
const MAX_BRANCH_TASKS = 1000
const MAX_CAS_ATTEMPTS = 5

export interface PrTaskTransitionInput {
  readonly branchName: string
  readonly changedAt?: number
  readonly projectRepoPath: string
  readonly prState: string | null
  readonly registeredProjectRepoPaths: readonly string[]
}

type SqliteRow = Record<string, unknown>

const isSqliteRow = (value: unknown): value is SqliteRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
    actionName: nullableString(row.action_name, 'action_name'),
    branchName: nullableString(row.branch_name, 'branch_name'),
    createdAt: safeInteger(row.created_at, 'created_at'),
    executionId: nullableString(row.execution_id, 'execution_id'),
    executionStatus: executionStatus(row.execution_status),
    id: requiredString(row.id, 'id'),
    description: nullableString(row.description, 'description'),
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

const pathContains = (parent: string, child: string): boolean =>
  parent === child ||
  child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

const nearestProjectRoot = (
  rootPath: string,
  projectRoots: readonly string[]
): string | undefined => {
  let nearest: string | undefined
  for (const projectRoot of projectRoots) {
    if (
      pathContains(projectRoot, rootPath) &&
      (nearest === undefined || projectRoot.length > nearest.length)
    ) {
      nearest = projectRoot
    }
  }
  return nearest
}

const nextStatusForPr = (task: Task, prState: string): TaskStatus | null => {
  switch (prState.toUpperCase()) {
    case 'MERGED':
      return task.status === 'done' ? null : 'done'
    case 'CLOSED':
      return task.status === 'in_review' ? 'in_progress' : null
    case 'OPEN':
      return task.status === 'in_progress' &&
        (task.source === 'manual' ||
          task.source === 'slack_url' ||
          task.source === 'agent' ||
          task.source === 'worktree')
        ? 'in_review'
        : null
    default:
      return null
  }
}

class StalePrTaskTransition extends Error {}

/** Node/Electron-compatible connection to the shared task DB. */
export class NodeTaskBoardDatabase {
  readonly #database: DatabaseSync
  readonly #path: string

  private constructor(database: DatabaseSync, path: string) {
    this.#database = database
    this.#path = path
  }

  static open(path: string): NodeTaskBoardDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA foreign_keys = ON')
      const result = new NodeTaskBoardDatabase(database, path)
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

  findTask(taskId: string): Task | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(taskId)
    return row === undefined ? null : rowToTask(sqliteRow(row))
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

  find(id: string): Task | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id)
    return row === undefined ? null : rowToTask(sqliteRow(row))
  }

  insert(input: NewTask, changedAt = Date.now()): Task {
    const createdAt = input.createdAt ?? changedAt
    return this.#writeTransaction(() => {
      this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
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
      this.#appendChange(input.id, changedAt)
      const task = this.find(input.id)
      if (!task) {
        throw new Error(`Inserted task ${input.id} could not be read`)
      }
      return task
    })
  }

  update(
    id: string,
    expectedRevision: number,
    patch: TaskPatch,
    changedAt = Date.now()
  ): Task {
    const entries = (Object.keys(patch) as (keyof TaskPatch)[]).map(
      (field) => [field, patch[field]] as const
    )
    if (entries.length === 0) {
      throw new Error('A task update requires at least one field')
    }
    return this.#writeTransaction(() => {
      const result = this.#database
        .prepare(`UPDATE tasks SET ${entries
          .map(([field]) => `${PATCH_COLUMNS[field]} = ?`)
          .join(', ')}, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(
          ...entries.map(([, value]) => value ?? null),
          changedAt,
          id,
          expectedRevision
        )
      if (result.changes === 0) {
        throw new Error(`Task ${id} has a stale revision`)
      }
      this.#appendChange(id, changedAt)
      const task = this.find(id)
      if (!task) {
        throw new Error(`Updated task ${id} could not be read`)
      }
      return task
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
      const initial = this.find(id)
      if (initial === null) {
        throw new Error(`Task not found: ${id}`)
      }
      if (initial.status === status) {
        return initial
      }
      if (initial.revision !== expectedRevision) {
        throw new Error(`Task changed while moving: ${id}`)
      }

      const result = this.#database
        .prepare(`UPDATE tasks
          SET status = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(status, changedAt, id, expectedRevision)
      if (result.changes === 0) {
        throw new Error(`Task changed while moving: ${id}`)
      }
      this.#appendChange(id, changedAt)
      const moved = this.find(id)
      if (moved === null) {
        throw new Error(`Moved task could not be read: ${id}`)
      }
      return moved
    })
  }

  /**
   * Insert an `in_progress` task witnessing an existing git worktree, unless
   * some task already claims that worktree. The claim check and the insert
   * share one IMMEDIATE transaction, so concurrent reconciles cannot mint
   * duplicate cards for the same worktree.
   *
   * A worktree is claimed when any task row (any status, cancelled and done
   * included) stores one of the worktree path aliases, or binds the same
   * branch within an overlapping root. The branch guard covers execution
   * tasks whose deterministic worktree path has not materialized on disk yet
   * and slack cards whose planned branch precedes provisioning.
   *
   * Returns the inserted task, or null when the worktree was already claimed.
   */
  adoptWorktreeTask(
    input: {
      readonly branchName: string | null
      readonly id: string
      readonly rootPath: string
      readonly title: string
      readonly worktreePath: string
      readonly worktreePathAliases: readonly string[]
    },
    changedAt = Date.now()
  ): Task | null {
    const aliases = [
      ...new Set([input.worktreePath, ...input.worktreePathAliases]),
    ]
    return this.#writeTransaction(() => {
      const pathRows = this.#database
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks
           WHERE worktree_path IN (${aliases.map(() => '?').join(', ')})
           LIMIT 1`
        )
        .all(...aliases)
      if (pathRows.length > 0) {
        return null
      }

      if (input.branchName !== null) {
        const branchRows = this.#database
          .prepare(
            `SELECT ${TASK_COLUMNS} FROM tasks
             WHERE branch_name = ? LIMIT ?`
          )
          .all(input.branchName, MAX_BRANCH_TASKS)
        const claimed = branchRows
          .map((row) => rowToTask(sqliteRow(row)))
          .some(
            (candidate) =>
              pathContains(candidate.rootPath, input.rootPath) ||
              pathContains(input.rootPath, candidate.rootPath)
          )
        if (claimed) {
          return null
        }
      }

      this.#database
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, execution_id, action_name,
          execution_status, slack_permalink, worktree_path, branch_name,
          description, created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'in_progress', 'worktree', NULL, NULL, NULL, NULL,
          ?, ?, NULL, ?, ?, 1)`)
        .run(
          input.id,
          input.rootPath,
          input.title,
          input.worktreePath,
          input.branchName,
          changedAt,
          changedAt
        )
      this.#appendChange(input.id, changedAt)
      const task = this.find(input.id)
      if (!task) {
        throw new Error(`Adopted worktree task ${input.id} could not be read`)
      }
      return task
    })
  }

  /**
   * Move the newest task bound to a branch when its PR lifecycle requires it.
   * Selection and the revision-CAS write share a short IMMEDIATE transaction;
   * the ledger append is committed atomically with the task update.
   */
  transitionTaskForPr(input: PrTaskTransitionInput): Task | null {
    if (input.prState === null) {
      return null
    }
    const projectRoots = input.registeredProjectRepoPaths.includes(
      input.projectRepoPath
    )
      ? input.registeredProjectRepoPaths
      : [...input.registeredProjectRepoPaths, input.projectRepoPath]
    const changedAt = input.changedAt ?? Date.now()

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      try {
        return this.#writeTransaction(() => {
          const rows = this.#database
            .prepare(
              `SELECT ${TASK_COLUMNS} FROM tasks
               WHERE branch_name = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(input.branchName, MAX_BRANCH_TASKS + 1)
          if (rows.length > MAX_BRANCH_TASKS) {
            throw new Error(
              `Branch ${input.branchName} exceeds the ${MAX_BRANCH_TASKS} task match limit`
            )
          }
          const task = rows
            .map((row) => rowToTask(sqliteRow(row)))
            .find(
              (candidate) =>
                nearestProjectRoot(candidate.rootPath, projectRoots) ===
                input.projectRepoPath
            )
          if (task === undefined) {
            return null
          }
          const status = nextStatusForPr(task, input.prState ?? '')
          if (status === null) {
            return null
          }

          const result = this.#database
            .prepare(`UPDATE tasks
              SET status = ?, updated_at = ?, revision = revision + 1
              WHERE id = ? AND revision = ?`)
            .run(status, changedAt, task.id, task.revision)
          if (result.changes === 0) {
            throw new StalePrTaskTransition()
          }
          this.#database
            .prepare(
              'INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)'
            )
            .run(task.id, changedAt)
          const updated = this.#database
            .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
            .get(task.id)
          if (updated === undefined) {
            throw new Error(`Updated task ${task.id} could not be read`)
          }
          return rowToTask(sqliteRow(updated))
        })
      } catch (error) {
        if (
          !(error instanceof StalePrTaskTransition) ||
          attempt === MAX_CAS_ATTEMPTS
        ) {
          throw error
        }
      }
    }
    return null
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

  #appendChange(taskId: string, changedAt: number): void {
    this.#database
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run(taskId, changedAt)
  }

  #writeTransaction<A>(operation: () => A): A {
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.#database.exec('BEGIN IMMEDIATE')
        try {
          const result = operation()
          this.#database.exec('COMMIT')
          notifyLaborerDatabaseWrite(this.#path)
          return result
        } catch (error) {
          try {
            this.#database.exec('ROLLBACK')
          } catch {
            // Preserve the operation failure.
          }
          throw error
        }
      } catch (error) {
        if (
          attempt >= 5 ||
          !(error instanceof Error && BUSY_MESSAGE.test(error.message))
        ) {
          throw error
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(250, 10 * 2 ** (attempt - 1) * (0.5 + Math.random()))
        )
      }
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
}
