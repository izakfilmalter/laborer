import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { LaborerStore } from '../src/services/laborer-store.js'
import { TaskManager } from '../src/services/task-manager.js'
import { TestLaborerStore } from './helpers/test-store.js'

const TestLayer = TaskManager.layer.pipe(Layer.provideMerge(TestLaborerStore))

describe('TaskManager.createTask', () => {
  it.scoped('accepts an optional prdId and persists it on PRD tasks', () =>
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath: '/tmp/project-1',
          name: 'project-1',
          rlphConfig: null,
        })
      )

      const taskManager = yield* TaskManager
      const task = yield* taskManager.createTask(
        'project-1',
        'Build PRD issue import',
        'prd',
        undefined,
        'prd-1'
      )

      assert.strictEqual(task.projectId, 'project-1')
      assert.strictEqual(task.source, 'prd')
      assert.strictEqual(task.prdId, 'prd-1')
      assert.strictEqual(task.title, 'Build PRD issue import')
      assert.strictEqual(task.status, 'pending')

      const storedTasks = store.query(tables.tasks.where('id', task.id))
      assert.strictEqual(storedTasks.length, 1)
      const storedTask = storedTasks[0]
      assert.isDefined(storedTask)
      if (storedTask === undefined) {
        assert.fail('Expected task to be materialized in store')
      }
      assert.strictEqual(storedTask.id, task.id)
      assert.strictEqual(storedTask.prdId, 'prd-1')
      assert.strictEqual(storedTask.source, 'prd')
    }).pipe(Effect.provide(TestLayer))
  )
})
