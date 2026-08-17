import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  handleLabelCreate,
  handleLabelDelete,
  handleLabelUpdate,
  handleTaskLabelsSet,
} from '../src/rpc/handlers.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'

const TestDatabase = LaborerDatabase.temporaryLayer()

const seedTask = Effect.gen(function* () {
  const database = yield* LaborerDatabase
  return yield* database.read('seed task', (native) =>
    native.insertTask({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Seeded',
    })
  )
})

describe('label RPC handlers', () => {
  it.effect('creates, labels a task, and hard-deletes', () =>
    Effect.gen(function* () {
      const { row: task } = yield* seedTask
      const created = yield* handleLabelCreate({
        id: 'label-1',
        name: 'Bug',
      })
      assert.strictEqual(created.row.id, 'label-1')

      const renamed = yield* handleLabelUpdate({
        expectedRevision: created.row.revision,
        labelId: 'label-1',
        name: 'Defect',
      })
      assert.strictEqual(renamed.row.name, 'Defect')

      const applied = yield* handleTaskLabelsSet({
        expectedRevision: task.revision,
        labelIds: ['label-1', 'label-1'],
        operationId: 'mutation-1',
        taskId: 'task-1',
      })
      assert.deepStrictEqual(applied.row.labelIds, ['label-1'])

      yield* handleLabelDelete({
        expectedRevision: renamed.row.revision,
        labelId: 'label-1',
      })
      const database = yield* LaborerDatabase
      const stripped = yield* database.read('read task', (native) =>
        native.findTask('task-1')
      )
      assert.deepStrictEqual(stripped?.labelIds, [])
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect('applies one app-wide label to tasks in different projects', () =>
    Effect.gen(function* () {
      const { row: task } = yield* seedTask
      const database = yield* LaborerDatabase
      const { row: elsewhere } = yield* database.read('seed other task', (n) =>
        n.insertTask({
          id: 'task-2',
          rootPath: '/other-repo',
          source: 'manual',
          status: 'todo',
          title: 'Other project',
        })
      )
      yield* handleLabelCreate({ id: 'label-1', name: 'Bug' })

      const here = yield* handleTaskLabelsSet({
        expectedRevision: task.revision,
        labelIds: ['label-1'],
        operationId: 'mutation-1',
        taskId: task.id,
      })
      const there = yield* handleTaskLabelsSet({
        expectedRevision: elsewhere.revision,
        labelIds: ['label-1'],
        operationId: 'mutation-2',
        taskId: elsewhere.id,
      })

      assert.deepStrictEqual(here.row.labelIds, ['label-1'])
      assert.deepStrictEqual(there.row.labelIds, ['label-1'])
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect('maps a stale label revision to CAS_CONFLICT', () =>
    Effect.gen(function* () {
      const created = yield* handleLabelCreate({
        id: 'label-1',
        name: 'Bug',
      })
      const failure = yield* handleLabelUpdate({
        expectedRevision: created.row.revision + 5,
        labelId: 'label-1',
        name: 'Defect',
      }).pipe(Effect.flip)
      assert.strictEqual(failure.code, 'CAS_CONFLICT')
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect('maps a name collision to LABEL_WRITE_FAILED', () =>
    Effect.gen(function* () {
      yield* handleLabelCreate({
        id: 'label-1',
        name: 'Bug',
      })
      const failure = yield* handleLabelCreate({
        id: 'label-2',
        name: 'BUG',
      }).pipe(Effect.flip)
      assert.strictEqual(failure.code, 'LABEL_WRITE_FAILED')
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect('maps unknown label ids to TASK_LABELS_WRITE_FAILED', () =>
    Effect.gen(function* () {
      const { row: task } = yield* seedTask
      const failure = yield* handleTaskLabelsSet({
        expectedRevision: task.revision,
        labelIds: ['missing'],
        operationId: 'mutation-1',
        taskId: 'task-1',
      }).pipe(Effect.flip)
      assert.strictEqual(failure.code, 'TASK_LABELS_WRITE_FAILED')
    }).pipe(Effect.provide(TestDatabase))
  )
})
