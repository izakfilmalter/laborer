import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
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
            port: 4103,
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

  it.scoped(
    'bootstrapPolling runs a one-time PR check for stopped workspaces without continuous polling',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        // Create a stopped workspace with pre-populated PR data.
        // bootstrapPolling should run checkPr once for this workspace
        // (refreshing the PR state) but NOT start continuous polling.
        store.commit(
          events.workspaceCreated({
            id: 'workspace-stopped-boot',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/stopped-boot',
            worktreePath: '/tmp/workspace-stopped-boot',
            port: 4104,
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

        // Build PrWatcher layer — this triggers bootstrapPolling
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        // Should NOT be continuously polling (stopped workspaces don't poll)
        const isPolling = yield* prWatcher.isPolling('workspace-stopped-boot')
        assert.isFalse(
          isPolling,
          'stopped workspaces should not have continuous polling'
        )

        // But the one-time bootstrap check should have run, overwriting
        // the stale OPEN state with the gh pr view result (EMPTY_PR since
        // the fake worktree path has no real repo).
        const after = store
          .query(tables.workspaces)
          .find((w) => w.id === 'workspace-stopped-boot')
        assert.strictEqual(
          after?.prState,
          null,
          'bootstrapPolling should have run a one-time checkPr for stopped workspaces'
        )
      })
  )
})
