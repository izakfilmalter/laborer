import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LaborerDatabaseBusyError,
  LaborerDatabaseSchemaTooNewError,
  LaborerDatabaseStaleRevisionError,
  NativeLaborerDatabase,
} from '../src/services/native-laborer-database.js'

const directories: string[] = []
const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-native-db-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('NativeLaborerDatabase', () => {
  it('migrates memory databases and covers all shared rows', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    expect(database.migrationNames()).toHaveLength(7)

    const task = database.insertTask(
      {
        id: 'task-1',
        rootPath: '/repo',
        title: 'Task',
        status: 'in_progress',
        source: 'manual',
        worktreeStatus: 'ready',
        parentTaskId: null,
        prState: 'open',
        prIsDraft: true,
        sortOrder: 10.5,
      },
      'task-mutation',
      10
    )
    expect(task).toMatchObject({
      cursor: 1,
      row: {
        revision: 1,
        worktreeStatus: 'ready',
        prIsDraft: true,
        sortOrder: 10.5,
      },
    })
    expect(database.taskChangesAfter(0)).toEqual([
      {
        changedAt: 10,
        mutationId: 'task-mutation',
        sequence: 1,
        taskId: 'task-1',
      },
    ])

    const project = database.insertProject(
      {
        id: 'project-1',
        name: 'Laborer',
        rootPath: '/repo',
        repoId: 'repo-1',
        canonicalGitCommonDir: '/repo/.git',
      },
      'project-mutation',
      20
    )
    const setting = database.insertSetting(
      'github.token',
      'secret',
      'setting-mutation',
      30
    )
    expect(project).toMatchObject({ cursor: 1, row: { revision: 1 } })
    expect(setting).toMatchObject({ cursor: 2, row: { revision: 1 } })
    expect(
      database.stateChangesAfter(0).map((change) => change.mutationId)
    ).toEqual(['project-mutation', 'setting-mutation'])
    database.close()
  })

  it('CAS-updates rows and appends exactly one ledger row atomically', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const inserted = database.insertTask({
      id: 'task-1',
      rootPath: '/repo',
      title: 'Before',
      status: 'todo',
      source: 'manual',
    })
    const updated = database.updateTask(
      inserted.row.id,
      inserted.row.revision,
      { title: 'After', status: 'in_progress' },
      'move-1',
      20
    )
    expect(updated).toMatchObject({
      cursor: 2,
      row: { revision: 2, title: 'After', status: 'in_progress' },
    })

    expect(() =>
      database.updateTask('task-1', 1, { title: 'Stale' }, 'stale', 30)
    ).toThrow(LaborerDatabaseStaleRevisionError)
    expect(database.taskChangesAfter(0)).toHaveLength(2)

    expect(() =>
      database.updateTask('task-1', 2, { status: 'not-valid' as 'todo' })
    ).toThrow()
    expect(database.findTask('task-1')).toMatchObject({
      revision: 2,
      status: 'in_progress',
    })
    expect(database.taskChangesAfter(0)).toHaveLength(2)
    database.close()
  })

  it('bounds ledger reads', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    expect(() => database.taskChangesAfter(-1)).toThrow(
      'A change cursor must be a nonnegative integer'
    )
    expect(() => database.stateChangesAfter(0, 1001)).toThrow(
      'A change limit must be between 1 and 1000'
    )
    database.close()
  })

  it('fails closed on a schema newer than this binary', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path)
    database.close()
    const raw = new DatabaseSync(path)
    raw
      .prepare(`INSERT INTO __drizzle_migrations
        (hash, created_at, name) VALUES (?, ?, ?)`)
      .run('future', 1, '9999_future')
    raw.close()
    expect(() => NativeLaborerDatabase.open(path)).toThrow(
      LaborerDatabaseSchemaTooNewError
    )
  })

  it('coordinates two writers with stale CAS and survives reopen', () => {
    const path = databasePath()
    const first = NativeLaborerDatabase.open(path)
    const second = NativeLaborerDatabase.open(path)
    const task = first.insertTask({
      id: 'task-1',
      rootPath: '/repo',
      title: 'Original',
      status: 'todo',
      source: 'manual',
    }).row
    const observed = second.findTask(task.id)
    first.updateTask(task.id, task.revision, { title: 'Winner' })
    expect(() =>
      second.updateTask(task.id, observed?.revision ?? 0, { title: 'Loser' })
    ).toThrow(LaborerDatabaseStaleRevisionError)
    second.close()
    first.close()

    const reopened = NativeLaborerDatabase.open(path)
    expect(reopened.findTask(task.id)).toMatchObject({
      revision: 2,
      title: 'Winner',
    })
    expect(reopened.taskChangesAfter(0)).toHaveLength(2)
    reopened.close()
  })

  it('retries WAL lock contention and reports a typed busy failure', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path, {
      attempts: 2,
      baseDelayMs: 0,
      busyTimeoutMs: 0,
      random: () => 0,
    })
    const holder = new DatabaseSync(path)
    holder.exec('PRAGMA busy_timeout = 0')
    holder.exec('BEGIN IMMEDIATE')
    try {
      expect(() => database.insertSetting('locked', 'value', null, 1)).toThrow(
        LaborerDatabaseBusyError
      )
      expect(database.stateChangesAfter(0)).toEqual([])
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      database.close()
    }
  })
})
