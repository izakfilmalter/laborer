import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Either } from 'effect'
import { handleTaskMoveAtPath } from '../src/rpc/handlers.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-task-move-')), 'laborer.sqlite')

const seed = (path: string) => {
  const database = NativeLaborerDatabase.open(path)
  database.insertTask({
    id: 'move-me',
    rootPath: '/repo',
    source: 'manual',
    status: 'todo',
    title: 'Move me',
  })
  database.close()
}

describe('task.move manual ordering', () => {
  it('persists fractional order and the settlement token in one commit', () =>
    Effect.gen(function* () {
      const path = databasePath()
      seed(path)

      const moved = yield* handleTaskMoveAtPath(
        {
          expectedRevision: 1,
          mutationId: 'drag-one',
          sortOrder: 10.5,
          status: 'in_review',
          taskId: 'move-me',
        },
        path
      )

      assert.strictEqual(moved.row.sortOrder, 10.5)
      assert.strictEqual(moved.row.status, 'in_review')
      assert.strictEqual(moved.cursor, 2)

      const reopened = NativeLaborerDatabase.open(path)
      assert.strictEqual(reopened.findTask('move-me')?.sortOrder, 10.5)
      assert.deepStrictEqual(
        reopened.taskChangesAfter(0).map(({ mutationId }) => mutationId),
        [null, 'drag-one']
      )
      reopened.close()
    }))

  it('rejects a stale drag without appending a settlement token', () =>
    Effect.gen(function* () {
      const path = databasePath()
      seed(path)
      const external = NativeLaborerDatabase.open(path)
      external.updateTask('move-me', 1, {
        sortOrder: 4,
        status: 'done',
      })
      external.close()

      const result = yield* handleTaskMoveAtPath(
        {
          expectedRevision: 1,
          mutationId: 'stale-drag',
          sortOrder: 8,
          status: 'in_review',
          taskId: 'move-me',
        },
        path
      ).pipe(Effect.either)

      assert.isTrue(Either.isLeft(result))
      if (Either.isLeft(result)) {
        assert.strictEqual(result.left.code, 'CAS_CONFLICT')
      }
      const database = NativeLaborerDatabase.open(path)
      assert.strictEqual(database.findTask('move-me')?.status, 'done')
      assert.notInclude(
        database.taskChangesAfter(0).map(({ mutationId }) => mutationId),
        'stale-drag'
      )
      database.close()
    }))

  it('assigns newly inserted cards ahead of existing manual ranks', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path)
    const first = database.insertTask({
      id: 'first',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'First',
    }).row
    const incoming = database.insertTask({
      id: 'incoming',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Incoming',
    }).row

    assert.isTrue((incoming.sortOrder ?? 0) < (first.sortOrder ?? 0))
    database.close()
  })

  it('puts an external status-only move at the top of its new column', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path)
    database.insertTask({
      id: 'existing',
      rootPath: '/repo',
      sortOrder: 10,
      source: 'manual',
      status: 'todo',
      title: 'Existing',
    })
    database.insertTask({
      id: 'external',
      rootPath: '/repo',
      sortOrder: 100,
      source: 'manual',
      status: 'in_review',
      title: 'External',
    })
    database.close()

    const externalWriter = NodeTaskBoardDatabase.open(path)
    externalWriter.move('external', 1, 'todo')
    externalWriter.close()

    const reopened = NativeLaborerDatabase.open(path)
    assert.strictEqual(reopened.findTask('external')?.sortOrder, 9)
    reopened.close()
  })
})
