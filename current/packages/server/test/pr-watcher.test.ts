import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Context, Duration, Effect, Layer, TestClock } from 'effect'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PR_BACKGROUND_POLL_INTERVAL_MS } from '../src/services/polling-intervals.js'
import { PrTaskTransitions } from '../src/services/pr-task-transitions.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { waitFor } from './helpers/timing-helpers.js'

type PrWatcherService = Context.Tag.Service<typeof PrWatcher>

const waitForPollingState = (
  prWatcher: PrWatcherService,
  workspaceId: string,
  expected: boolean
) =>
  Effect.promise(() =>
    waitFor(
      async () =>
        (await Effect.runPromise(prWatcher.isPolling(workspaceId))) ===
        expected,
      2000,
      `PrWatcher polling state for ${workspaceId}`
    )
  )

/**
 * Helper: build a PrWatcher from a pre-built store context.
 * Returns both the PrWatcher service and the underlying store for assertions.
 */
const buildPrWatcher = (storeContext: Context.Context<LaborerStore>) =>
  Effect.gen(function* () {
    const prWatcherContext = yield* Layer.build(
      PrWatcher.layer.pipe(
        Layer.provide(PrTaskTransitions.noopLayer),
        Layer.provide(Layer.succeedContext(storeContext))
      )
    )
    return Context.get(prWatcherContext, PrWatcher)
  })

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
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(PrTaskTransitions.noopLayer),
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        yield* waitForPollingState(prWatcher, 'workspace-running', true)
        const isPolling = yield* prWatcher.isPolling('workspace-running')

        assert.isTrue(isPolling)
      })
  )

  it.scoped(
    'bootstraps background polling for stopped workspaces on startup',
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
            status: 'stopped',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(PrTaskTransitions.noopLayer),
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        yield* waitForPollingState(prWatcher, 'workspace-stopped', true)
        const isPolling = yield* prWatcher.isPolling('workspace-stopped')

        assert.isTrue(isPolling)
      })
  )

  it.scoped(
    'checkPr attempts to check stopped workspaces instead of skipping them',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        // Create a stopped workspace and pre-populate it with PR data
        // to simulate a workspace that previously had a known PR state.
        store.commit(
          events.workspaceCreated({
            id: 'workspace-stopped',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/stopped-pr',
            worktreePath: '/tmp/workspace-stopped-pr',
            status: 'stopped',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )
        store.commit(
          events.workspacePrUpdated({
            id: 'workspace-stopped',
            prNumber: 42,
            prUrl: 'https://github.com/test/repo/pull/42',
            prTitle: 'Test PR',
            prState: 'MERGED',
          })
        )

        // Verify the pre-populated PR state is set
        const workspaceBefore = store
          .query(tables.workspaces)
          .find((w) => w.id === 'workspace-stopped')
        assert.strictEqual(workspaceBefore?.prState, 'MERGED')
        assert.strictEqual(workspaceBefore?.prNumber, 42)

        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(PrTaskTransitions.noopLayer),
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        // checkPr should NOT short-circuit for a stopped workspace.
        // gh pr view will fail (no real repo at /tmp/...) and return EMPTY_PR,
        // which will be committed as a workspacePrUpdated event, overwriting
        // the previously-set MERGED state. If checkPr short-circuits (current
        // bug), the old MERGED state remains untouched in LiveStore.
        yield* prWatcher.checkPr('workspace-stopped')

        // After checkPr, the workspace PR data should be updated.
        // Since gh pr view fails (fake path), it returns EMPTY_PR and commits
        // null values — overwriting the old MERGED state.
        const workspaceAfter = store
          .query(tables.workspaces)
          .find((w) => w.id === 'workspace-stopped')
        assert.strictEqual(
          workspaceAfter?.prState,
          null,
          'checkPr should have committed a workspacePrUpdated event (clearing the stale MERGED state) instead of short-circuiting'
        )
      })
  )

  it.scoped('refreshes polling coverage for an adopted workspace', () =>
    Effect.gen(function* () {
      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)
      const prWatcher = yield* buildPrWatcher(storeContext)

      store.commit(
        events.workspaceCreated({
          id: 'workspace-adopted',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'laborer/adopted',
          worktreePath: '/tmp/workspace-adopted',
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      yield* prWatcher.refreshPolling()
      yield* waitForPollingState(prWatcher, 'workspace-adopted', true)
      assert.isTrue(yield* prWatcher.isPolling('workspace-adopted'))
    })
  )

  it.scoped('periodically discovers an adopted workspace', () =>
    Effect.gen(function* () {
      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)
      const prWatcher = yield* buildPrWatcher(storeContext)

      // Let the startup coverage pass finish while the store is empty.
      yield* Effect.yieldNow()
      store.commit(
        events.workspaceCreated({
          id: 'workspace-periodically-adopted',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'laborer/periodically-adopted',
          worktreePath: '/tmp/workspace-periodically-adopted',
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      assert.isFalse(
        yield* prWatcher.isPolling('workspace-periodically-adopted')
      )
      yield* TestClock.adjust(Duration.millis(PR_BACKGROUND_POLL_INTERVAL_MS))
      yield* Effect.yieldNow()
      assert.isTrue(
        yield* prWatcher.isPolling('workspace-periodically-adopted')
      )
    })
  )

  it.scoped('polling coverage continuously polls stopped workspaces', () =>
    Effect.gen(function* () {
      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      // Create a stopped workspace with pre-populated PR data.
      // The first polling pass should refresh the persisted PR state and the
      // polling fiber must remain registered for later background checks.
      store.commit(
        events.workspaceCreated({
          id: 'workspace-stopped-boot',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/stopped-boot',
          worktreePath: '/tmp/workspace-stopped-boot',
          status: 'stopped',
          origin: 'laborer',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )
      store.commit(
        events.workspacePrUpdated({
          id: 'workspace-stopped-boot',
          prNumber: 99,
          prUrl: 'https://github.com/test/repo/pull/99',
          prTitle: 'Boot PR',
          prState: 'OPEN',
        })
      )

      // Verify PR state before bootstrap
      const before = store
        .query(tables.workspaces)
        .find((w) => w.id === 'workspace-stopped-boot')
      assert.strictEqual(before?.prState, 'OPEN')

      // Building PrWatcher starts polling coverage.
      const prWatcherContext = yield* Layer.build(
        PrWatcher.layer.pipe(
          Layer.provide(PrTaskTransitions.noopLayer),
          Layer.provide(Layer.succeedContext(storeContext))
        )
      )
      const prWatcher = Context.get(prWatcherContext, PrWatcher)

      yield* waitForPollingState(prWatcher, 'workspace-stopped-boot', true)
      const isPolling = yield* prWatcher.isPolling('workspace-stopped-boot')
      assert.isTrue(isPolling, 'stopped workspaces should poll continuously')

      yield* Effect.promise(() =>
        waitFor(
          async () =>
            store
              .query(tables.workspaces)
              .find((w) => w.id === 'workspace-stopped-boot')?.prState === null,
          5000,
          'stopped workspace bootstrap PR check'
        )
      )

      // The first check overwrites stale OPEN state with EMPTY_PR because the
      // fake worktree path has no repository.
      const after = store
        .query(tables.workspaces)
        .find((w) => w.id === 'workspace-stopped-boot')
      assert.strictEqual(
        after?.prState,
        null,
        'polling coverage should check stopped workspaces'
      )
    })
  )

  it.scoped(
    'checkPr removes workspace from LiveStore and stops polling when workspace is not found',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        // Create a running workspace so PrWatcher starts polling for it.
        store.commit(
          events.workspaceCreated({
            id: 'workspace-vanishing',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/vanish',
            worktreePath: '/tmp/workspace-vanishing',
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        // Building PrWatcher starts continuous polling.
        const prWatcher = yield* buildPrWatcher(storeContext)

        // Verify polling is active
        yield* waitForPollingState(prWatcher, 'workspace-vanishing', true)
        const pollingBefore = yield* prWatcher.isPolling('workspace-vanishing')
        assert.isTrue(pollingBefore, 'should be polling after bootstrap')

        // Now destroy the workspace externally (simulating another service
        // removing it from LiveStore while PrWatcher is still polling).
        store.commit(events.workspaceDestroyed({ id: 'workspace-vanishing' }))

        // Confirm it's gone from LiveStore
        const wsGone = store
          .query(tables.workspaces)
          .find((w) => w.id === 'workspace-vanishing')
        assert.isUndefined(wsGone, 'workspace should be removed from store')

        // Call checkPr directly — this should detect the workspace is gone,
        // log the situation, and stop the polling fiber.
        yield* prWatcher.checkPr('workspace-vanishing')

        // Polling should now be stopped for this workspace.
        const pollingAfter = yield* prWatcher.isPolling('workspace-vanishing')
        assert.isFalse(
          pollingAfter,
          'polling should stop when workspace is not found in LiveStore'
        )
      })
  )
})
