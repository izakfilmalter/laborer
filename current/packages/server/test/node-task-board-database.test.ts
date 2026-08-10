import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-board-reader-')), 'tasks.sqlite')

describe('NodeTaskBoardDatabase', () => {
  it('inserts and CAS-updates cards with a ledger row in each transaction', () => {
    const database = NodeTaskBoardDatabase.open(databasePath())
    const inserted = database.insert(
      {
        id: 'manual-card',
        rootPath: '/repo',
        source: 'manual',
        status: 'in_review',
        title: 'Review this',
      },
      10
    )
    const updated = database.update(
      inserted.id,
      inserted.revision,
      { title: 'Reviewed' },
      20
    )

    expect(updated).toMatchObject({ revision: 2, title: 'Reviewed' })
    expect(database.readChanges(0)).toMatchObject({
      cursor: 2,
      tasks: [{ id: 'manual-card', revision: 2 }],
    })
    expect(() =>
      database.update(inserted.id, inserted.revision, { title: 'Stale' })
    ).toThrow('stale revision')
    database.close()
  })

  it('reads Bun-compatible task snapshots and bounded deltas under Node', () => {
    const path = databasePath()
    const reader = NodeTaskBoardDatabase.open(path)
    const writer = new DatabaseSync(path)
    writer
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('task-1', '/repo', 'Task', 'todo', 'manual', 10, 10, 1)
    writer
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run('task-1', 10)

    const snapshot = reader.snapshot()
    expect(snapshot).toMatchObject({
      _tag: 'snapshot',
      cursor: 1,
      tasks: [{ id: 'task-1', status: 'todo' }],
    })
    expect(reader.findTask('task-1')).toMatchObject({
      id: 'task-1',
      rootPath: '/repo',
    })
    expect(reader.findTask('missing')).toBeNull()

    writer
      .prepare(
        'UPDATE tasks SET status = ?, revision = ?, updated_at = ? WHERE id = ?'
      )
      .run('in_review', 2, 20, 'task-1')
    writer
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run('task-1', 20)
    expect(reader.readChanges(snapshot.cursor)).toMatchObject({
      _tag: 'delta',
      cursor: 2,
      deletedTaskIds: [],
      tasks: [{ id: 'task-1', revision: 2, status: 'in_review' }],
    })

    writer.close()
    reader.close()
  })

  it('applies PR transitions with revision CAS and ledger rows', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const writer = new DatabaseSync(path)
    const insert = writer.prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, branch_name,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    insert.run(
      'agent-task',
      '/repo/apps/agent',
      'Agent task',
      'in_progress',
      'agent',
      'feature/pr-card',
      10,
      10
    )
    writer
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run('agent-task', 10)

    expect(
      database.transitionTaskForPr({
        branchName: 'feature/pr-card',
        projectRepoPath: '/repo',
        registeredProjectRepoPaths: ['/repo'],
        prState: 'OPEN',
        changedAt: 20,
      })
    ).toMatchObject({ status: 'in_review', revision: 2 })
    expect(
      database.transitionTaskForPr({
        branchName: 'feature/pr-card',
        projectRepoPath: '/repo',
        registeredProjectRepoPaths: ['/repo'],
        prState: 'CLOSED',
        changedAt: 30,
      })
    ).toMatchObject({ status: 'in_progress', revision: 3 })
    expect(
      database.transitionTaskForPr({
        branchName: 'feature/pr-card',
        projectRepoPath: '/repo',
        registeredProjectRepoPaths: ['/repo'],
        prState: 'MERGED',
        changedAt: 40,
      })
    ).toMatchObject({ status: 'done', revision: 4 })

    const changes = writer
      .prepare('SELECT task_id, changed_at FROM task_changes ORDER BY sequence')
      .all()
    expect(changes).toEqual([
      { task_id: 'agent-task', changed_at: 10 },
      { task_id: 'agent-task', changed_at: 20 },
      { task_id: 'agent-task', changed_at: 30 },
      { task_id: 'agent-task', changed_at: 40 },
    ])

    writer.close()
    database.close()
  })

  it('uses the nearest registered project root and source transition rules', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const writer = new DatabaseSync(path)
    const insert = writer.prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, branch_name,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    insert.run(
      'nested-task',
      '/repo/packages/app/root',
      'Nested execution',
      'in_progress',
      'execution',
      'feature/shared',
      20,
      20
    )
    insert.run(
      'parent-task',
      '/repo/other/root',
      'Parent manual',
      'in_progress',
      'manual',
      'feature/shared',
      10,
      10
    )

    expect(
      database.transitionTaskForPr({
        branchName: 'feature/shared',
        projectRepoPath: '/repo',
        registeredProjectRepoPaths: ['/repo', '/repo/packages/app'],
        prState: 'OPEN',
        changedAt: 30,
      })
    ).toMatchObject({ id: 'parent-task', status: 'in_review' })
    expect(
      database.transitionTaskForPr({
        branchName: 'feature/shared',
        projectRepoPath: '/repo/packages/app',
        registeredProjectRepoPaths: ['/repo', '/repo/packages/app'],
        prState: 'OPEN',
        changedAt: 40,
      })
    ).toBeNull()
    expect(
      database.transitionTaskForPr({
        branchName: 'feature/shared',
        projectRepoPath: '/repo/packages/app',
        registeredProjectRepoPaths: ['/repo', '/repo/packages/app'],
        prState: 'MERGED',
        changedAt: 50,
      })
    ).toMatchObject({ id: 'nested-task', status: 'done' })

    writer.close()
    database.close()
  })

  it('persists status moves and appends the change in the same transaction', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const raw = new DatabaseSync(path)
    raw
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('task-1', '/repo', 'Task', 'todo', 'manual', 10, 10, 1)

    const moved = database.move('task-1', 1, 'done', 20)

    expect(moved).toMatchObject({
      id: 'task-1',
      revision: 2,
      status: 'done',
      updatedAt: 20,
    })
    expect(
      raw
        .prepare(
          'SELECT task_id, changed_at FROM task_changes ORDER BY sequence'
        )
        .all()
    ).toEqual([{ task_id: 'task-1', changed_at: 20 }])

    database.close()
    const reopened = NodeTaskBoardDatabase.open(path)
    expect(reopened.snapshot().tasks).toMatchObject([
      { id: 'task-1', revision: 2, status: 'done' },
    ])

    reopened.close()
    raw.close()
  })

  it('leaves the winning state visible when a human move loses its CAS', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const concurrentWriter = new DatabaseSync(path)
    concurrentWriter
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('task-1', '/repo', 'Task', 'todo', 'manual', 10, 10, 1)
    concurrentWriter
      .prepare(
        'UPDATE tasks SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?'
      )
      .run('in_review', 15, 'task-1', 1)

    expect(() => database.move('task-1', 1, 'done', 20)).toThrow(
      'Task changed while moving: task-1'
    )
    expect(
      concurrentWriter
        .prepare('SELECT status, revision FROM tasks WHERE id = ?')
        .get('task-1')
    ).toEqual({ status: 'in_review', revision: 2 })

    concurrentWriter.close()
    database.close()
  })

  it('replays an already-applied status declaration without another write', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const raw = new DatabaseSync(path)
    raw
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('task-1', '/repo', 'Task', 'todo', 'manual', 10, 10, 1)

    expect(database.move('task-1', 1, 'done', 20)).toMatchObject({
      revision: 2,
      status: 'done',
      updatedAt: 20,
    })
    expect(database.move('task-1', 1, 'done', 30)).toMatchObject({
      revision: 2,
      status: 'done',
      updatedAt: 20,
    })
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM task_changes').get()
    ).toEqual({ count: 1 })

    raw.close()
    database.close()
  })

  it('allows cancelling human and execution cards', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const raw = new DatabaseSync(path)
    const insert = raw.prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, execution_id, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('manual', '/repo', 'Manual', 'todo', 'manual', null, 10, 10, 1)
    insert.run(
      'execution',
      '/repo',
      'Execution',
      'in_progress',
      'execution',
      'execution-1',
      10,
      10,
      1
    )

    expect(database.move('manual', 1, 'cancelled', 20).status).toBe('cancelled')
    expect(database.move('execution', 1, 'cancelled', 20)).toMatchObject({
      revision: 2,
      status: 'cancelled',
    })
    expect(
      raw.prepare('SELECT status FROM tasks WHERE id = ?').get('execution')
    ).toEqual({ status: 'cancelled' })

    raw.close()
    database.close()
  })
})
