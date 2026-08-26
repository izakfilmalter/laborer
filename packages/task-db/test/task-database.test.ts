import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  NativeTaskDatabase,
  TaskDatabaseSchemaTooNewError,
  TaskDb,
  TaskStaleRevisionError,
  taskDatabasePath,
} from '@laborer/task-db'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const migrationNames = [
  '0000_shared_task_db',
  '0001_execution_lifecycle_statuses',
  '0002_task_description_agent_source',
  '0003_worktree_task_source',
  '0004_task_worktree_pr_columns',
  '0005_projects',
  '0006_app_settings_and_ledger',
  '0007_projects_sort_order',
  '0008_complete_removed_worktrees',
  '0009_git_hosted_status',
  '0010_pr_check_runs',
  '0011_task_numbers',
  '0012_task_labels',
  '0013_correlated_operations',
  '0014_pr_unresolved_threads',
  '0015_pr_review_decision',
  '0016_review_comments',
]

const temporaryDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-task-db-current-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

const createPreDescriptionDatabase = (path: string): void => {
  const raw = new DatabaseSync(path)
  raw.exec(`CREATE TABLE __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL UNIQUE
  )`)
  const record = raw.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
  )
  for (const migration of taskDbMigrations.slice(0, 2)) {
    raw.exec(migration.sql.replaceAll('--> statement-breakpoint', ''))
    record.run(
      createHash('sha256').update(migration.sql).digest('hex'),
      1,
      migration.name
    )
  }
  raw
    .prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, initial_prompt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('existing', '/repo', 'Existing', 'todo', 'manual', 'Keep me', 1, 1)
  raw.close()
}

const createPreSharedDbExpansionDatabase = (path: string): void => {
  const raw = new DatabaseSync(path)
  raw.exec(`CREATE TABLE __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL UNIQUE
  )`)
  const record = raw.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
  )
  for (const migration of taskDbMigrations.slice(0, 4)) {
    raw.exec(migration.sql.replaceAll('--> statement-breakpoint', ''))
    record.run(
      createHash('sha256').update(migration.sql).digest('hex'),
      1,
      migration.name
    )
  }
  raw
    .prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, worktree_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'legacy-task',
      '/repo',
      'Legacy task',
      'in_progress',
      'manual',
      '/repo/.worktrees/legacy',
      1,
      1
    )
  // Real 0003 databases carry duplicate worktree paths: a cancelled attempt
  // and its retried replacement both keep the same path. Migration 0004+
  // must accept this history instead of failing with a UNIQUE violation.
  const insertTask = raw.prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, worktree_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  insertTask.run(
    'cancelled-attempt',
    '/repo',
    'Retried task',
    'cancelled',
    'manual',
    '/repo/.worktrees/retried',
    2,
    2
  )
  insertTask.run(
    'done-retry',
    '/repo',
    'Retried task',
    'done',
    'manual',
    '/repo/.worktrees/retried',
    3,
    3
  )
  raw.close()
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('NativeTaskDatabase', () => {
  it('migrates a fresh database once and a second writer adopts it', () => {
    const path = temporaryDatabasePath()
    const first = NativeTaskDatabase.open(path)
    expect(first.migrationNames()).toEqual(migrationNames)
    const second = NativeTaskDatabase.open(path)
    expect(second.migrationNames()).toEqual(migrationNames)
    second.close()
    first.close()
  })

  it('migrates a populated 0003 database through the shared-db expansion', () => {
    const path = temporaryDatabasePath()
    createPreSharedDbExpansionDatabase(path)

    const database = NativeTaskDatabase.open(path)
    expect(database.migrationNames()).toEqual(migrationNames)
    expect(database.find('legacy-task')).toMatchObject({
      title: 'Legacy task',
      revision: 1,
    })
    database.close()

    const raw = new DatabaseSync(path)
    const task = raw
      .prepare(`SELECT worktree_status, parent_task_id, pr_is_draft, sort_order
        FROM tasks WHERE id = ?`)
      .get('legacy-task')
    expect(task).toMatchObject({
      parent_task_id: null,
      pr_is_draft: 0,
      sort_order: null,
      worktree_status: null,
    })
    raw
      .prepare(`INSERT INTO projects (
        id, name, root_path, repo_id, canonical_git_common_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('project', 'Project', '/repo', 'repo-id', '/repo/.git', 1, 1)
    raw
      .prepare(`INSERT INTO app_settings (
        key, value, created_at, updated_at
      ) VALUES (?, ?, ?, ?)`)
      .run('github.token', 'test-value', 1, 1)
    raw
      .prepare(`INSERT INTO task_changes (
        task_id, changed_at, operation_id
      ) VALUES (?, ?, ?)`)
      .run('legacy-task', 1, 'task-mutation-1')
    raw
      .prepare(`INSERT INTO state_changes (
        table_name, row_id, changed_at, operation_id
      ) VALUES (?, ?, ?, ?)`)
      .run('app_settings', 'github.token', 1, 'mutation-1')
    expect(
      raw.prepare('SELECT operation_id FROM state_changes').get()
    ).toMatchObject({ operation_id: 'mutation-1' })
    expect(
      raw
        .prepare(
          'SELECT operation_id FROM task_changes WHERE operation_id IS NOT NULL'
        )
        .get()
    ).toMatchObject({ operation_id: 'task-mutation-1' })
    raw.close()
  })

  it('promotes children and keeps worktree path history insertable', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.insert({
      id: 'parent',
      rootPath: '/repo',
      title: 'Parent',
      status: 'in_progress',
      source: 'manual',
      worktreePath: '/repo/.worktrees/parent',
    })
    database.insert({
      id: 'child',
      rootPath: '/repo',
      title: 'Child',
      status: 'in_progress',
      source: 'manual',
      worktreePath: '/repo/.worktrees/child',
    })
    database.close()

    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = ON')
    raw
      .prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?')
      .run('parent', 'child')
    raw.prepare('DELETE FROM tasks WHERE id = ?').run('parent')
    expect(
      raw.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get('child')
    ).toMatchObject({ parent_task_id: null })
    // Retried tasks reuse a worktree path, so cancelled history and the
    // replacement task legitimately share the same path in the database.
    raw
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, worktree_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'retried',
        '/repo',
        'Retried',
        'todo',
        'manual',
        '/repo/.worktrees/child',
        1,
        1
      )
    expect(
      raw
        .prepare('SELECT COUNT(*) AS count FROM tasks WHERE worktree_path = ?')
        .get('/repo/.worktrees/child')
    ).toMatchObject({ count: 2 })
    raw.close()
  })

  it('migrates initial prompts to descriptions without changing the ledger', () => {
    const path = temporaryDatabasePath()
    createPreDescriptionDatabase(path)

    const database = NativeTaskDatabase.open(path)
    expect(database.find('existing')).toMatchObject({
      description: 'Keep me',
      revision: 1,
    })
    expect(database.changesAfter(0)).toEqual([])
    database.close()
  })

  it('accepts agent tasks and rejects unknown sources', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    expect(
      database.insert({
        id: 'agent-task',
        rootPath: '/repo',
        title: 'Agent task',
        description: 'Follow up',
        status: 'todo',
        source: 'agent',
      }).task
    ).toMatchObject({ source: 'agent', description: 'Follow up' })
    database.close()

    const raw = new DatabaseSync(path)
    expect(() =>
      raw
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('unknown', '/repo', 'Unknown', 'todo', 'unknown', 1, 1)
    ).toThrow()
    raw.close()
  })

  it('accepts worktree-source tasks after the 0003 migration', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    expect(
      database.insert({
        id: 'worktree-task',
        rootPath: '/repo',
        title: 'laborer/adopted',
        status: 'in_progress',
        source: 'worktree',
        branchName: 'laborer/adopted',
        worktreePath: '/repo.worktrees/adopted',
      }).task
    ).toMatchObject({
      source: 'worktree',
      status: 'in_progress',
      branchName: 'laborer/adopted',
      worktreePath: '/repo.worktrees/adopted',
    })
    database.close()
  })

  it('rejects a stale CAS across two writers', () => {
    const path = temporaryDatabasePath()
    const first = NativeTaskDatabase.open(path)
    const second = NativeTaskDatabase.open(path)
    const inserted = first.insert(
      {
        id: 'task-1',
        rootPath: '/repo',
        title: 'Original',
        status: 'in_progress',
        source: 'manual',
      },
      100
    ).task
    const staleRevision = second.find(inserted.id)?.revision
    expect(
      first.update(inserted.id, inserted.revision, { title: 'First' }, 200)
        .revision
    ).toBe(2)
    expect(() =>
      second.update(inserted.id, staleRevision ?? -1, { title: 'Second' }, 300)
    ).toThrow(TaskStaleRevisionError)
    expect(second.find(inserted.id)?.title).toBe('First')
    second.close()
    first.close()
  })

  it('makes replayed execution inserts idempotent', () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath())
    const input = {
      id: 'task-execution',
      rootPath: '/repo',
      title: 'Execution',
      status: 'in_progress' as const,
      source: 'execution' as const,
      executionId: 'execution-1',
      executionStatus: 'running' as const,
    }
    expect(database.insert(input, 10).inserted).toBe(true)
    const replay = database.insert({ ...input, id: 'replayed-id' }, 20)
    expect(replay).toMatchObject({
      inserted: false,
      task: { id: 'task-execution', revision: 1 },
    })
    expect(database.changesAfter(0)).toHaveLength(1)
    database.close()
  })

  it('assigns monotonic task numbers independently per project root', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    const insert = (id: string, rootPath: string) =>
      database.insert({
        id,
        rootPath,
        source: 'manual',
        status: 'todo',
        title: id,
      }).task

    expect(insert('first-a', '/repo-a').taskNumber).toBe(1)
    expect(insert('first-b', '/repo-b').taskNumber).toBe(1)
    expect(insert('second-a', '/repo-a').taskNumber).toBe(2)
    database.close()

    const raw = new DatabaseSync(path)
    raw.prepare('DELETE FROM tasks WHERE id = ?').run('second-a')
    raw.close()
    const reopened = NativeTaskDatabase.open(path)
    expect(
      reopened.insert({
        id: 'third-a',
        rootPath: '/repo-a',
        source: 'manual',
        status: 'todo',
        title: 'third-a',
      }).task.taskNumber
    ).toBe(3)
    reopened.close()
  })

  it('appends exactly one change transactionally for each mutation', () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath())
    const inserted = database.insert(
      {
        id: 'task-ledger',
        rootPath: '/repo',
        title: 'Ledger',
        status: 'todo',
        source: 'manual',
      },
      10
    ).task
    database.update(
      inserted.id,
      inserted.revision,
      { status: 'in_progress' },
      20
    )
    expect(database.changesAfter(0)).toEqual([
      { sequence: 1, taskId: inserted.id, changedAt: 10 },
      { sequence: 2, taskId: inserted.id, changedAt: 20 },
    ])
    expect(() =>
      database.update(inserted.id, 1, { title: 'stale' }, 30)
    ).toThrow(TaskStaleRevisionError)
    expect(database.changesAfter(0)).toHaveLength(2)
    database.close()
  })

  it('bounds change-ledger reads', () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath())
    database.insert({
      id: 'task-bounded-ledger',
      rootPath: '/repo',
      title: 'Bounded ledger',
      status: 'todo',
      source: 'manual',
    })
    expect(database.changesAfter(0, 1)).toHaveLength(1)
    expect(() => database.changesAfter(0, 1001)).toThrow(
      'A task change limit must be between 1 and 1000'
    )
    database.close()
  })

  it('reads a consistent snapshot and affected rows after its cursor', () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath())
    const first = database.insert(
      {
        id: 'task-first',
        rootPath: '/repo',
        title: 'First',
        status: 'in_progress',
        source: 'execution',
      },
      10
    ).task
    database.insert(
      {
        id: 'task-second',
        rootPath: '/repo',
        title: 'Second',
        status: 'todo',
        source: 'manual',
      },
      20
    )

    const snapshot = database.snapshot()
    expect(snapshot.cursor).toBe(2)
    expect(snapshot.tasks.map(({ id }) => id)).toEqual([
      'task-first',
      'task-second',
    ])

    database.update(first.id, first.revision, { status: 'in_review' }, 30)
    expect(database.readChanges(snapshot.cursor)).toMatchObject({
      _tag: 'delta',
      cursor: 3,
      deletedTaskIds: [],
      tasks: [{ id: first.id, status: 'in_review', revision: 2 }],
    })
    database.close()
  })

  it('deduplicates changed task IDs and reports deleted tasks', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    const changed = database.insert(
      {
        id: 'task-changed',
        rootPath: '/repo',
        title: 'Changed',
        status: 'todo',
        source: 'manual',
      },
      10
    ).task
    database.insert(
      {
        id: 'task-deleted',
        rootPath: '/repo',
        title: 'Deleted',
        status: 'todo',
        source: 'manual',
      },
      20
    )
    database.update(changed.id, changed.revision, { status: 'in_progress' }, 30)

    const raw = new DatabaseSync(path)
    raw.prepare('DELETE FROM tasks WHERE id = ?').run('task-deleted')
    raw.close()

    expect(database.readChanges(0)).toMatchObject({
      _tag: 'delta',
      cursor: 3,
      deletedTaskIds: ['task-deleted'],
      tasks: [{ id: changed.id, status: 'in_progress', revision: 2 }],
    })
    database.close()
  })

  it('falls back to snapshots for empty and noncontiguous change history', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.insert({
      id: 'task-gap',
      rootPath: '/repo',
      title: 'Gap',
      status: 'todo',
      source: 'manual',
    })

    const raw = new DatabaseSync(path)
    raw
      .prepare('UPDATE task_changes SET sequence = ? WHERE sequence = ?')
      .run(2, 1)
    raw.close()

    expect(database.readChanges(0)).toMatchObject({
      _tag: 'snapshot',
      cursor: 2,
      tasks: [{ id: 'task-gap' }],
    })

    const empty = new DatabaseSync(path)
    empty.prepare('DELETE FROM task_changes').run()
    empty.close()
    expect(database.readChanges(1)).toMatchObject({
      _tag: 'snapshot',
      cursor: 0,
      tasks: [{ id: 'task-gap' }],
    })
    database.close()
  })

  it('validates read cursors and limits', () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath())
    for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => database.readChanges(cursor)).toThrow(
        'A task change cursor must be a nonnegative integer'
      )
    }
    for (const limit of [0, 1.5, 1001]) {
      expect(() => database.readChanges(0, limit)).toThrow(
        'A task change limit must be between 1 and 1000'
      )
    }
    database.close()
  })

  it('bounds snapshots to 10,000 tasks', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    const raw = new DatabaseSync(path)
    raw.exec(`WITH RECURSIVE task_number(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM task_number WHERE value < 10001
    )
    INSERT INTO tasks (
      id, root_path, title, status, source, created_at, updated_at
    )
    SELECT printf('task-%05d', value), '/repo', 'Task', 'todo', 'manual', value, value
    FROM task_number`)
    raw.close()

    expect(() => database.snapshot()).toThrow(
      'Task database snapshot exceeds the 10000 task limit'
    )
    database.close()
  })

  it('requests a snapshot when a cursor was pruned or is ahead', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.insert({
      id: 'task-reset',
      rootPath: '/repo',
      title: 'Reset',
      status: 'todo',
      source: 'manual',
    })

    const raw = new DatabaseSync(path)
    raw.prepare('DELETE FROM task_changes WHERE sequence = 1').run()
    raw
      .prepare(
        'INSERT INTO task_changes (sequence, task_id, changed_at) VALUES (?, ?, ?)'
      )
      .run(5, 'task-reset', 50)
    raw.close()

    expect(database.readChanges(1)).toMatchObject({
      _tag: 'snapshot',
      cursor: 5,
      tasks: [{ id: 'task-reset' }],
    })
    expect(database.readChanges(99)).toMatchObject({
      _tag: 'snapshot',
      cursor: 5,
    })
    database.close()
  })

  it('enforces persisted task enums', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.close()
    const raw = new DatabaseSync(path)
    expect(() =>
      raw
        .prepare(
          `INSERT INTO tasks (
            id, root_path, title, status, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('invalid', '/repo', 'Invalid', 'unknown', 'manual', 1, 1)
    ).toThrow()
    raw.close()
  })

  it('fails closed when the migration ledger contains a newer schema', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.close()
    const raw = new DatabaseSync(path)
    raw
      .prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
      )
      .run('future', Date.now(), '9999_future')
    raw.close()
    expect(() => NativeTaskDatabase.open(path)).toThrow(
      TaskDatabaseSchemaTooNewError
    )
  })
})

describe('TaskDb', () => {
  it('exposes snapshot and delta reads through the Effect service', async () => {
    const path = temporaryDatabasePath()
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* TaskDb
        yield* database.insert({
          id: 'effect-task',
          rootPath: '/repo',
          title: 'Effect task',
          status: 'todo',
          source: 'manual',
        })
        const snapshot = yield* database.snapshot()
        expect(snapshot).toMatchObject({
          _tag: 'snapshot',
          cursor: 1,
          tasks: [{ id: 'effect-task' }],
        })
        expect(yield* database.readChanges(snapshot.cursor)).toEqual({
          _tag: 'delta',
          cursor: snapshot.cursor,
          deletedTaskIds: [],
          tasks: [],
        })
      }).pipe(Effect.provide(TaskDb.layer(path)))
    )
  })
})

describe('taskDatabasePath', () => {
  it('uses only an absolute nonblank XDG_STATE_HOME', () => {
    expect(taskDatabasePath({ XDG_STATE_HOME: '/state' }, '/home/me')).toBe(
      '/state/laborer/laborer.sqlite'
    )
    expect(taskDatabasePath({ XDG_STATE_HOME: 'relative' }, '/home/me')).toBe(
      '/home/me/.local/state/laborer/laborer.sqlite'
    )
  })
})
