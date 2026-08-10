import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-board-reader-')), 'tasks.sqlite')

describe('NodeTaskBoardDatabase', () => {
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

  it('allows cancelling human cards but not execution cards', () => {
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
    expect(() => database.move('execution', 1, 'cancelled', 20)).toThrow(
      'Execution tasks cannot be cancelled from the board'
    )
    expect(
      raw.prepare('SELECT status FROM tasks WHERE id = ?').get('execution')
    ).toEqual({ status: 'in_progress' })

    raw.close()
    database.close()
  })
})
