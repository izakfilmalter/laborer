import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { handleTaskUpdate } from '../src/rpc/handlers.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

describe('task.update RPC handler', () => {
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
      Effect.either(
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
      _tag: 'Left',
      left: { code: 'CAS_CONFLICT' },
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
