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

  it('applies PR transitions with revision CAS and ledger rows', () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    const writer = new DatabaseSync(path)
    const insert = writer.prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, branch_name,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    insert.run(
      'manual-task',
      '/repo/apps/agent',
      'Manual task',
      'in_progress',
      'manual',
      'feature/pr-card',
      10,
      10
    )
    writer
      .prepare('INSERT INTO task_changes (task_id, changed_at) VALUES (?, ?)')
      .run('manual-task', 10)

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
      { task_id: 'manual-task', changed_at: 10 },
      { task_id: 'manual-task', changed_at: 20 },
      { task_id: 'manual-task', changed_at: 30 },
      { task_id: 'manual-task', changed_at: 40 },
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
})
