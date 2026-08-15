import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { handleTaskUpdate } from '../src/rpc/handlers.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

describe('task.update RPC handler', () => {
  it('accepts a readable project task identifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'laborer-task-update-readable-'))
    const path = join(root, 'tasks.sqlite')
    writeFileSync(join(root, 'laborer.json'), '{"shortName":"READ"}\n')
    const database = NativeLaborerDatabase.open(path)
    database.insertProject({
      canonicalGitCommonDir: root,
      id: 'project-1',
      name: 'Readable',
      repoId: 'repo-1',
      rootPath: root,
    })
    const task = database.insertTask({
      id: 'internal-task-id',
      rootPath: root,
      source: 'manual',
      status: 'todo',
      title: 'Before',
    }).row
    database.close()

    await Effect.runPromise(
      handleTaskUpdate(
        {
          description: null,
          expectedRevision: task.revision,
          taskId: `READ-${String(task.taskNumber)}`,
          title: 'After',
        },
        path
      )
    )
    const reopened = NativeLaborerDatabase.open(path)
    expect(reopened.findTask('internal-task-id')?.title).toBe('After')
    reopened.close()
  })

  it('writes title and description through revision CAS with a ledger append', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'laborer-task-update-')),
      'tasks.sqlite'
    )
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Before',
    })
    database.close()

    const result = await Effect.runPromise(
      handleTaskUpdate(
        {
          description: 'Run the focused test first.',
          expectedRevision: 1,
          taskId: 'task-1',
          title: 'After',
        },
        path
      )
    )
    expect(result).toMatchObject({
      description: 'Run the focused test first.',
      revision: 2,
      title: 'After',
    })

    const updated = NodeTaskBoardDatabase.open(path)
    expect(updated.find('task-1')?.description).toBe(
      'Run the focused test first.'
    )
    expect(updated.readChanges(0).cursor).toBe(2)
    updated.close()
  })

  it('reports a stale revision without overwriting or appending a change', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'laborer-task-update-conflict-')),
      'tasks.sqlite'
    )
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-1',
      rootPath: '/repo',
      source: 'execution',
      status: 'in_progress',
      title: 'Winning title',
    })
    database.close()

    const result = await Effect.runPromise(
      Effect.result(
        handleTaskUpdate(
          {
            description: 'Losing description',
            expectedRevision: 0,
            taskId: 'task-1',
            title: 'Losing title',
          },
          path
        )
      )
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'CAS_CONFLICT' },
    })

    const unchanged = NodeTaskBoardDatabase.open(path)
    expect(unchanged.find('task-1')).toMatchObject({
      description: null,
      revision: 1,
      title: 'Winning title',
    })
    expect(unchanged.readChanges(1).cursor).toBe(1)
    unchanged.close()
  })
})
