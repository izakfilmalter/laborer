import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  NativeTaskDatabase,
  TaskDatabaseSchemaTooNewError,
  TaskStaleRevisionError,
  taskDatabasePath,
} from '@laborer/task-db'
import { taskDbMigrations } from '@laborer/task-db/migrations'
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
  const directory = mkdtempSync(join(tmpdir(), 'laborer-task-db-next-'))
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

  it('keeps the shared migration SQL ledger byte-identical', () => {
    expect(
      taskDbMigrations.map(({ name, sql }) => [
        name,
        createHash('sha256').update(sql).digest('hex'),
      ])
    ).toEqual([
      [
        '0000_shared_task_db',
        '3264d634d1a77c6eaf1d3eb224a62ade548a11853ba11daab15d14ba9f0df3f5',
      ],
      [
        '0001_execution_lifecycle_statuses',
        '8996c9042812807ca5860caabea9ac26701c07af8cd64e5de3c24cc60db06087',
      ],
      [
        '0002_task_description_agent_source',
        'a92e1eec06d3472edc1a0c158f70a11c8ce20b07ffc7e3d25253a3b2ed3ce73f',
      ],
      [
        '0003_worktree_task_source',
        'b1acb7569989fa450149706d7e550519fbd27a2c5921e0008c1ad58bcf66642a',
      ],
      [
        '0004_task_worktree_pr_columns',
        '5cedabec3897807ee4989c9cd66d6f1aa6995ba810a71614c8f81c3af3e1589d',
      ],
      [
        '0005_projects',
        '4ffc231b6369f07683f4b3c21f7507b6df426799db2305b114a04a221455c2f1',
      ],
      [
        '0006_app_settings_and_ledger',
        'f58304502ae583036cbb6847c9253fed482b737fa5a8e76b44db698c232d63e0',
      ],
      [
        '0007_projects_sort_order',
        '4d0f661e5d17a81bb63be3a8c8e87732b6a24d0404baa02687d814addd1c3351',
      ],
      [
        '0008_complete_removed_worktrees',
        '949b371a78627208de4cd23376e586d3efc5000d42f3c7db631434e57cfc1766',
      ],
      [
        '0009_git_hosted_status',
        '4a8ceac62baca7a4a5b96839be6061a890e99486665c05628490dac710584335',
      ],
      [
        '0010_pr_check_runs',
        'e7938c241a71411f6357c961d0e93d45c1a5d8a9211c9f29f498047df7c86a21',
      ],
      [
        '0011_task_numbers',
        '35a3125b9e6fc416742731a6247acb89bbed61522208c42a5ff5ddbb1e0bde83',
      ],
      [
        '0012_task_labels',
        'e0889187314cb52bfde30a4127664ea60b0e926bb4cd8a36a68894ab627ec9e5',
      ],
      [
        '0013_correlated_operations',
        '4a853d0fcad0e8874d8f909d826e927853ca0f68f02b49982b15bcf8b1837657',
      ],
      [
        '0014_pr_unresolved_threads',
        '6cfa6fc5cba0a47d45edece72c6103d35ce0d835c61a0636e4c6aae30076279e',
      ],
      [
        '0015_pr_review_decision',
        'a5effc306d0066844d973079980e94e47b2c676332f6e5bba415fbc8fc44b8c0',
      ],
      [
        '0016_review_comments',
        '3be39b957218d30d7ff98c1366d8835ab5b3ac8a7224c8bbb66270faf4003ec8',
      ],
    ])
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

    const updated = first.update(
      inserted.id,
      inserted.revision,
      { title: 'First' },
      200
    )
    expect(updated.revision).toBe(2)
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

  it('appends exactly one change in the same transaction as each mutation', () => {
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
