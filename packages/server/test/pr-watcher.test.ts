import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { TestLaborerStore } from './helpers/test-store.js'

describe('PrWatcher', () => {
  it.scoped(
    'bootstraps polling for persisted active workspaces on startup',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        store.commit(
          events.workspaceCreated({
            id: 'workspace-running',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/pr-status',
            worktreePath: '/tmp/workspace-running',
            port: 4101,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        const isPolling = yield* prWatcher.isPolling('workspace-running')

        assert.isTrue(isPolling)
      })
  )

  it.scoped(
    'does not bootstrap polling for inactive workspaces on startup',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        store.commit(
          events.workspaceCreated({
            id: 'workspace-stopped',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/stopped',
            worktreePath: '/tmp/workspace-stopped',
            port: 4102,
            status: 'stopped',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        const isPolling = yield* prWatcher.isPolling('workspace-stopped')

        assert.isFalse(isPolling)
      })
  )
})
