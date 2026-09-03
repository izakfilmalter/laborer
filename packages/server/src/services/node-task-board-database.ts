import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ExecutionStatus,
  NativeTaskDatabase,
  type NewTask,
  parseLabelIds,
  type Task,
  type TaskPatch,
  type TaskRead,
  type TaskSnapshot,
  type TaskSource,
  TaskStaleRevisionError,
  type TaskStatus,
} from '@laborer/task-db'
import { DatabaseSync } from '@laborer/task-db/database-sync'
import { notifyLaborerDatabaseWrite } from './laborer-database-wakeup.js'

const TASK_COLUMNS = `id, root_path, title, status, source, execution_id,
  action_name, execution_status, slack_permalink, worktree_path, branch_name,
  description, created_at, updated_at, revision, task_number, label_ids`
const BUSY_MESSAGE = /SQLITE_BUSY|database is locked/i
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
    labelIds: parseLabelIds(row.label_ids),
    revision,
    rootPath: requiredString(row.root_path, 'root_path'),
    slackPermalink: nullableString(row.slack_permalink, 'slack_permalink'),
    source: taskSource(row.source),
    status: taskStatus(row.status),
    taskNumber: safeInteger(row.task_number, 'task_number'),
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
  readonly #shared: NativeTaskDatabase

  private constructor(
    database: DatabaseSync,
    path: string,
    shared: NativeTaskDatabase
  ) {
    this.#database = database
    this.#path = path
    this.#shared = shared
  }

  static open(path: string): NodeTaskBoardDatabase {
    mkdirSync(dirname(path), { recursive: true })
    const shared = NativeTaskDatabase.open(path)
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(path)
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA foreign_keys = ON')
      return new NodeTaskBoardDatabase(database, path, shared)
    } catch (error) {
      database?.close()
      shared.close()
      throw error
    }
  }

  close(): void {
    this.#database.close()
    this.#shared.close()
  }

  snapshot(): TaskSnapshot {
    return this.#shared.snapshot()
  }

  findTask(taskId: string): Task | null {
    return this.#shared.find(taskId)
  }

  readChanges(sequence: number, limit = 1000): TaskRead {
    return this.#shared.readChanges(sequence, limit)
  }

  find(id: string): Task | null {
    return this.#shared.find(id)
  }

  insert(input: NewTask, changedAt = Date.now()): Task {
    const result = this.#shared.insert(input, changedAt)
    if (result.inserted) {
      notifyLaborerDatabaseWrite(this.#path)
    }
    return result.task
  }

  /** `null` expected revision skips the CAS guard (last-write-wins). */
  update(
    id: string,
    expectedRevision: number | null,
    patch: TaskPatch,
    changedAt = Date.now()
  ): Task {
    let task: Task
    try {
      task = this.#shared.update(id, expectedRevision, patch, changedAt)
    } catch (error) {
      if (error instanceof TaskStaleRevisionError) {
        throw new Error(`Task ${id} has a stale revision`, { cause: error })
      }
      throw error
    }
    notifyLaborerDatabaseWrite(this.#path)
    return task
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
      const initial = this.#findLocal(id)
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
          SET status = ?,
              sort_order = (SELECT COALESCE(MIN(sort_order), 0) - 1
                            FROM tasks WHERE status = ?),
              updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`)
        .run(status, status, changedAt, id, expectedRevision)
      if (result.changes === 0) {
        throw new Error(`Task changed while moving: ${id}`)
      }
      this.#appendChange(id, changedAt)
      const moved = this.#findLocal(id)
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
      this.#appendChange(input.id, changedAt)
      const task = this.#findLocal(input.id)
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
              SET status = ?,
                  sort_order = (SELECT COALESCE(MIN(sort_order), 0) - 1
                                FROM tasks WHERE status = ?),
                  updated_at = ?, revision = revision + 1
              WHERE id = ? AND revision = ?`)
            .run(status, status, changedAt, task.id, task.revision)
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

  #appendChange(taskId: string, changedAt: number): void {
    this.#database
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run(taskId, changedAt)
  }

  #findLocal(id: string): Task | null {
    const row = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id)
    return row === undefined ? null : rowToTask(sqliteRow(row))
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
}
