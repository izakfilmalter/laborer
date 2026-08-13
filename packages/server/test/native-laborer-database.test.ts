import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NativeTaskDatabase } from '@laborer/task-db'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { afterEach, describe, expect, it } from 'vitest'
import { onLaborerDatabaseWrite } from '../src/services/laborer-database-wakeup.js'
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
  it('shares one migration ledger with the shared task database', () => {
    const path = databasePath()
    const shared = NativeTaskDatabase.open(path)
    shared.close()

    const server = NativeLaborerDatabase.open(path)
    expect(server.migrationNames()).toEqual(
      taskDbMigrations.map(({ name }) => name)
    )
    server.close()

    const raw = new DatabaseSync(path)
    const ledger = raw
      .prepare(
        'SELECT name, hash FROM __drizzle_migrations ORDER BY created_at ASC'
      )
      .all()
    raw.close()
    expect(ledger).toEqual(
      taskDbMigrations.map(({ name, sql }) => ({
        hash: createHash('sha256').update(sql).digest('hex'),
        name,
      }))
    )

    expect(() => NativeTaskDatabase.open(path).close()).not.toThrow()
  })

  it('opens the aggregate database after the shared wrapper migrates it', () => {
    const path = databasePath()
    const shared = NativeTaskDatabase.open(path)
    shared.close()

    const server = NativeLaborerDatabase.open(path)
    expect(server.snapshot()).toMatchObject({
      projects: [],
      settings: [],
      tasks: [],
    })
    server.close()
  })

  it('migrates memory databases and covers all shared rows', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    expect(database.migrationNames()).toHaveLength(8)

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
    const deleted = database.deleteTask('task-1', 2, 'delete-1', 40)
    expect(deleted).toMatchObject({
      cursor: 3,
      row: { revision: 2, status: 'in_progress' },
    })
    expect(database.findTask('task-1')).toBeNull()
    expect(database.taskChangesAfter(0)).toHaveLength(3)
    database.close()
  })

  it('applies project and setting CAS mutations with one ledger row each', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const project = database.insertProject(
      {
        id: 'project-1',
        name: 'Before',
        rootPath: '/repo',
        repoId: 'repo-1',
        canonicalGitCommonDir: '/repo/.git',
      },
      'project-insert',
      10
    )
    const updatedProject = database.updateProject(
      project.row.id,
      project.row.revision,
      { name: 'After' },
      'project-update',
      20
    )
    expect(updatedProject.row).toMatchObject({ name: 'After', revision: 2 })
    expect(() =>
      database.updateProject(
        project.row.id,
        project.row.revision,
        { name: 'Stale' },
        'project-stale',
        30
      )
    ).toThrow(LaborerDatabaseStaleRevisionError)
    const deletedProject = database.deleteProject(
      updatedProject.row.id,
      updatedProject.row.revision,
      'project-delete',
      40
    )
    expect(deletedProject.row).toEqual(updatedProject.row)

    const setting = database.insertSetting(
      'github.token',
      'before',
      'setting-insert',
      50
    )
    const updatedSetting = database.updateSetting(
      setting.row.key,
      setting.row.revision,
      'after',
      'setting-update',
      60
    )
    expect(updatedSetting.row).toMatchObject({ value: 'after', revision: 2 })
    const deletedSetting = database.deleteSetting(
      updatedSetting.row.key,
      updatedSetting.row.revision,
      'setting-delete',
      70
    )
    expect(deletedSetting.row).toEqual(updatedSetting.row)

    expect(
      database.stateChangesAfter(0).map(({ mutationId }) => mutationId)
    ).toEqual([
      'project-insert',
      'project-update',
      'project-delete',
      'setting-insert',
      'setting-update',
      'setting-delete',
    ])
    database.close()
  })

  it('creates settings through revision-zero CAS and rejects stale creation', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const created = database.setSetting(
      'github_desktop_token',
      0,
      'secret',
      'create-setting',
      10
    )

    expect(created).toMatchObject({
      cursor: 1,
      row: { revision: 1, value: 'secret' },
    })
    expect(() =>
      database.setSetting(
        'github_desktop_token',
        0,
        'overwritten',
        'stale-setting',
        20
      )
    ).toThrow(LaborerDatabaseStaleRevisionError)
    expect(database.findSetting('github_desktop_token')?.value).toBe('secret')
    expect(database.stateChangesAfter(0)).toHaveLength(1)
    database.close()
  })

  it('orders projects by rank, falling back to creation time', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const add = (id: string, createdAt: number) =>
      database.insertProject(
        {
          id,
          name: id,
          rootPath: `/${id}`,
          repoId: id,
          canonicalGitCommonDir: `/${id}/.git`,
          createdAt,
        },
        null,
        createdAt
      ).row

    const first = add('project-1', 100)
    const second = add('project-2', 200)
    add('project-3', 300)

    // An untouched install looks exactly as it did before the column existed.
    expect(database.listProjects().map(({ id }) => id)).toEqual([
      'project-1',
      'project-2',
      'project-3',
    ])
    expect(database.listProjects().map(({ sortOrder }) => sortOrder)).toEqual([
      null,
      null,
      null,
    ])

    // Ranking one project mixes it in against the others' creation times.
    database.moveProject(second.id, second.revision, 50, 'move-up', 400)
    expect(database.listProjects().map(({ id }) => id)).toEqual([
      'project-2',
      'project-1',
      'project-3',
    ])

    database.moveProject(first.id, first.revision, 350, 'move-down', 500)
    expect(database.listProjects().map(({ id }) => id)).toEqual([
      'project-2',
      'project-3',
      'project-1',
    ])

    // Clearing a rank returns the project to its creation slot.
    const ranked = database.findProject(first.id)
    database.moveProject(first.id, ranked?.revision ?? 0, null, 'unrank', 600)
    expect(database.listProjects().map(({ id }) => id)).toEqual([
      'project-2',
      'project-1',
      'project-3',
    ])
    database.close()
  })

  it('CAS-guards a project move and records its mutation id', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const project = database.insertProject(
      {
        id: 'project-1',
        name: 'Laborer',
        rootPath: '/repo',
        repoId: 'repo-1',
        canonicalGitCommonDir: '/repo/.git',
      },
      'project-insert',
      10
    ).row

    const moved = database.moveProject(
      project.id,
      project.revision,
      12.5,
      'project-move',
      20
    )
    expect(moved).toMatchObject({
      cursor: 2,
      row: { revision: 2, sortOrder: 12.5 },
    })

    // A stale drag must lose rather than overwrite the winning rank.
    expect(() =>
      database.moveProject(project.id, project.revision, 99, 'stale', 30)
    ).toThrow(LaborerDatabaseStaleRevisionError)
    expect(database.findProject(project.id)?.sortOrder).toBe(12.5)

    // The renderer settles its optimistic rank on these ids.
    expect(
      database.stateChangesAfter(0).map(({ mutationId }) => mutationId)
    ).toEqual(['project-insert', 'project-move'])
    expect(database.stateUpdatesAfter(1)?.projects.mutationIds).toEqual([
      'project-move',
    ])
    database.close()
  })

  it('rolls back constraint failures without appending ledger rows', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    database.insertProject({
      id: 'project-1',
      name: 'First',
      rootPath: '/first',
      repoId: 'same-repo',
      canonicalGitCommonDir: '/first/.git',
    })
    expect(() =>
      database.insertProject({
        id: 'project-2',
        name: 'Second',
        rootPath: '/second',
        repoId: 'same-repo',
        canonicalGitCommonDir: '/second/.git',
      })
    ).toThrow()
    expect(database.listProjects()).toHaveLength(1)
    expect(database.stateChangesAfter(0)).toHaveLength(1)
    database.close()
  })

  it('keeps worktree path history insertable and promotes children on deletion', () => {
    const database = NativeLaborerDatabase.open(':memory:')
    const parent = database.insertTask({
      id: 'parent',
      rootPath: '/repo',
      source: 'worktree',
      status: 'in_progress',
      title: 'Parent',
      worktreePath: '/repo.worktrees/parent',
      worktreeStatus: 'ready',
    }).row
    database.insertTask({
      baseBranch: 'feat/parent',
      id: 'child',
      parentTaskId: parent.id,
      rootPath: '/repo',
      source: 'worktree',
      status: 'in_progress',
      title: 'Child',
    })

    // Retried tasks reuse a worktree path, so cancelled history and the
    // replacement task legitimately share the same path in the database.
    // findTaskByWorktreePath resolves the newest row for a shared path.
    const retried = database.insertTask(
      {
        id: 'retried',
        rootPath: '/repo',
        source: 'worktree',
        status: 'in_progress',
        title: 'Retried',
        worktreePath: '/repo.worktrees/parent',
      },
      null,
      Date.now() + 1000
    ).row
    expect(retried.worktreePath).toBe('/repo.worktrees/parent')
    expect(
      database.findTaskByWorktreePath('/repo.worktrees/parent')
    ).toMatchObject({ id: 'retried' })
    database.deleteTask(retried.id, retried.revision)

    const cleared = database.updateTask(parent.id, parent.revision, {
      worktreePath: null,
      worktreeStatus: null,
    }).row
    expect(cleared.worktreePath).toBeNull()
    database.deleteTask(parent.id, cleared.revision)
    expect(database.findTask('child')).toMatchObject({
      baseBranch: 'feat/parent',
      parentTaskId: null,
    })
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

  it('does not let a failed post-commit wakeup misreport a durable write', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path)
    let healthyWakeups = 0
    const removeBroken = onLaborerDatabaseWrite(path, () => {
      throw new Error('broken subscriber')
    })
    const removeHealthy = onLaborerDatabaseWrite(path, () => {
      healthyWakeups += 1
    })

    try {
      expect(() => database.insertSetting('theme', 'dark')).not.toThrow()
      expect(database.findSetting('theme')?.value).toBe('dark')
      expect(healthyWakeups).toBe(1)
    } finally {
      removeBroken()
      removeHealthy()
      database.close()
    }
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
