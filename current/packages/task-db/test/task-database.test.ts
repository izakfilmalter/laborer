import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NativeTaskDatabase,
  TaskDatabaseSchemaTooNewError,
  TaskStaleRevisionError,
  taskDatabasePath,
} from '../src/task-database.ts'

const directories: string[] = []

const temporaryDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-task-db-current-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
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
    expect(first.migrationNames()).toEqual([
      '0000_shared_task_db',
      '0001_execution_lifecycle_statuses',
    ])
    const second = NativeTaskDatabase.open(path)
    expect(second.migrationNames()).toEqual([
      '0000_shared_task_db',
      '0001_execution_lifecycle_statuses',
    ])
    second.close()
    first.close()
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

    const raw = new Database(path)
    raw.query('DELETE FROM task_changes WHERE sequence = 1').run()
    raw
      .query(
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
    const raw = new Database(path)
    expect(() =>
      raw
        .query(
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
    const raw = new Database(path)
    raw
      .query(
        'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)'
      )
      .run('future', Date.now(), '9999_future')
    raw.close()
    expect(() => NativeTaskDatabase.open(path)).toThrow(
      TaskDatabaseSchemaTooNewError
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
