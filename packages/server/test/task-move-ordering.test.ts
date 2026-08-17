import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
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
  it('canonicalizes a readable identifier before moving and writing the ledger', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'laborer-task-move-readable-'))
      const path = join(root, 'laborer.sqlite')
      writeFileSync(join(root, 'laborer.json'), '{"shortName":"MOVE"}\n')
      const database = NativeLaborerDatabase.open(path)
      database.insertProject({
        canonicalGitCommonDir: root,
        id: 'project-1',
        name: 'Move',
        repoId: 'repo-1',
        rootPath: root,
      })
      const task = database.insertTask({
        id: 'internal-move-id',
        rootPath: root,
        source: 'manual',
        status: 'todo',
        title: 'Move readably',
      }).row
      database.close()

      const moved = yield* handleTaskMoveAtPath(
        {
          expectedRevision: task.revision,
          operationId: 'readable-move',
          sortOrder: 3,
          status: 'in_review',
          taskId: `MOVE-${String(task.taskNumber)}`,
        },
        path
      )
      assert.strictEqual(moved.row.id, 'internal-move-id')
      const reopened = NativeLaborerDatabase.open(path)
      assert.strictEqual(
        reopened.findTask('internal-move-id')?.status,
        'in_review'
      )
      assert.strictEqual(
        reopened.taskChangesAfter(1)[0]?.taskId,
        'internal-move-id'
      )
      reopened.close()
    }))

  it('persists fractional order and the settlement token in one commit', () =>
    Effect.gen(function* () {
      const path = databasePath()
      seed(path)

      const moved = yield* handleTaskMoveAtPath(
        {
          expectedRevision: 1,
          operationId: 'drag-one',
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
        reopened.taskChangesAfter(0).map(({ operationId }) => operationId),
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
          operationId: 'stale-drag',
          sortOrder: 8,
          status: 'in_review',
          taskId: 'move-me',
        },
        path
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, 'CAS_CONFLICT')
      }
      const database = NativeLaborerDatabase.open(path)
      assert.strictEqual(database.findTask('move-me')?.status, 'done')
      assert.notInclude(
        database.taskChangesAfter(0).map(({ operationId }) => operationId),
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
