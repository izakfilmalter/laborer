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
})
