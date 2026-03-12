import { assert, describe, it } from '@effect/vitest'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import {
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherClient,
} from '../src/services/file-watcher-client.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { withFsmonitorDisabled } from '../src/services/repo-watching-git.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import {
  formatWatcherWarning,
  RepositoryWatchCoordinator,
} from '../src/services/repository-watch-coordinator.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay, waitFor } from './helpers/timing-helpers.js'

interface RecordedSubscription {
  readonly id: string
  readonly ignoreGlobs: readonly string[]
  readonly path: string
  readonly recursive: boolean
}

const createTestLayer = (params: {
  readonly branchRefreshCalls: { current: number }
  readonly reconcileCalls: { current: number }
  readonly subscribedPaths: string[]
  readonly unsubscribedIds: string[]
  /**
   * Emit a synthetic file event to all registered handlers.
   * Set by the layer construction once handlers are wired.
   */
  readonly emitEvent: { current: (event: WatchFileEvent) => void }
  /**
   * Map from subscription path to subscription ID, for test code
   * to look up which subscription ID to use when emitting events.
   */
  readonly subscriptionsByPath: Map<string, string>
}) => {
  let subCounter = 0
  const handlers: FileEventHandler[] = []

  const fileWatcherClientLayer = Layer.succeed(
    FileWatcherClient,
    FileWatcherClient.of({
      subscribe: (path, options) =>
        Effect.sync(() => {
          subCounter += 1
          const id = `test-sub-${subCounter}`
          params.subscribedPaths.push(path)
          params.subscriptionsByPath.set(path, id)
          return {
            id,
            path,
            recursive: options?.recursive ?? false,
            ignoreGlobs: options?.ignoreGlobs ?? [],
          } satisfies RecordedSubscription
        }),
      unsubscribe: (id) =>
        Effect.sync(() => {
          params.unsubscribedIds.push(id)
        }),
      updateIgnore: () => Effect.void,
      onFileEvent: (handler: FileEventHandler): FileEventSubscription => {
        handlers.push(handler)
        return {
          unsubscribe: () => {
            const idx = handlers.indexOf(handler)
            if (idx !== -1) {
              handlers.splice(idx, 1)
            }
          },
        }
      },
      listSubscriptions: () => Effect.succeed([]),
    })
  )

  // Wire the emitEvent function so tests can fire events
  params.emitEvent.current = (event: WatchFileEvent) => {
    for (const handler of [...handlers]) {
      handler(event)
    }
  }

  const repoIdentityLayer = Layer.succeed(
    RepositoryIdentity,
    RepositoryIdentity.of({
      resolve: (_inputPath) =>
        Effect.succeed({
          canonicalRoot: '/virtual/repo',
          canonicalGitCommonDir: '/virtual/repo/.git',
          repoId: 'repo-1',
          isMainWorktree: true,
        }),
    })
  )

  const reconcilerLayer = Layer.succeed(
    WorktreeReconciler,
    WorktreeReconciler.of({
      reconcile: (_projectId, _repoPath) =>
        Effect.sync(() => {
          params.reconcileCalls.current += 1
          return { added: 0, removed: 0, unchanged: 0 }
        }),
    })
  )

  const branchTrackerLayer = Layer.succeed(
    BranchStateTracker,
    BranchStateTracker.of({
      refreshBranches: (_projectId) =>
        Effect.sync(() => {
          params.branchRefreshCalls.current += 1
          return { checked: 0, updated: 0 }
        }),
    })
  )

  return RepositoryWatchCoordinator.layer.pipe(
    Layer.provide(branchTrackerLayer),
    Layer.provide(ConfigService.layer),
    Layer.provide(fileWatcherClientLayer),
    Layer.provide(reconcilerLayer),
    Layer.provide(repoIdentityLayer),
    Layer.provideMerge(TestLaborerStore)
  )
}

describe('RepositoryWatchCoordinator hardening', () => {
  it.scoped('coalesces heavy churn into stable refresh behavior', () => {
    const reconcileCalls = { current: 0 }
    const branchRefreshCalls = { current: 0 }
    const subscribedPaths: string[] = []
    const unsubscribedIds: string[] = []
    const emitEvent = { current: (_event: WatchFileEvent) => undefined }
    const subscriptionsByPath = new Map<string, string>()

    const TestLayer = createTestLayer({
      reconcileCalls,
      branchRefreshCalls,
      subscribedPaths,
      unsubscribedIds,
      emitEvent,
      subscriptionsByPath,
    })

    return Effect.gen(function* () {
      const coordinator = yield* RepositoryWatchCoordinator
      yield* coordinator.watchProject('project-hardening', '/input/repo')

      const gitSubId = subscriptionsByPath.get('/virtual/repo/.git')
      if (gitSubId === undefined) {
        throw new Error('Expected git dir subscription')
      }

      for (let index = 0; index < 10; index += 1) {
        emitEvent.current({
          subscriptionId: gitSubId,
          type: 'add',
          fileName: 'worktrees/feature',
          absolutePath: '/virtual/repo/.git/worktrees/feature',
        })
        emitEvent.current({
          subscriptionId: gitSubId,
          type: 'change',
          fileName: 'HEAD',
          absolutePath: '/virtual/repo/.git/HEAD',
        })
      }

      yield* Effect.promise(() =>
        waitFor(() =>
          Promise.resolve(
            reconcileCalls.current === 1 && branchRefreshCalls.current === 1
          )
        )
      )

      assert.deepStrictEqual(subscribedPaths, [
        '/virtual/repo/.git',
        '/virtual/repo',
      ])
      assert.deepStrictEqual(unsubscribedIds, [])
    }).pipe(Effect.provide(TestLayer))
  })

  it.scoped(
    'startup restore reuses persisted repository identity without re-resolving',
    () => {
      const reconcileCalls = { current: 0 }
      const branchRefreshCalls = { current: 0 }
      const subscribedPaths: string[] = []
      const unsubscribedIds: string[] = []
      const emitEvent = { current: (_event: WatchFileEvent) => undefined }
      const subscriptionsByPath = new Map<string, string>()
      const resolveCalls = { current: 0 }

      const handlers: FileEventHandler[] = []

      const fileWatcherClientLayer = Layer.succeed(
        FileWatcherClient,
        FileWatcherClient.of({
          subscribe: (path, options) =>
            Effect.sync(() => {
              const id = `test-sub-${subscribedPaths.length + 1}`
              subscribedPaths.push(path)
              subscriptionsByPath.set(path, id)
              return {
                id,
                path,
                recursive: options?.recursive ?? false,
                ignoreGlobs: options?.ignoreGlobs ?? [],
              }
            }),
          unsubscribe: (id) =>
            Effect.sync(() => {
              unsubscribedIds.push(id)
            }),
          updateIgnore: () => Effect.void,
          onFileEvent: (handler: FileEventHandler): FileEventSubscription => {
            handlers.push(handler)
            return {
              unsubscribe: () => {
                const idx = handlers.indexOf(handler)
                if (idx !== -1) {
                  handlers.splice(idx, 1)
                }
              },
            }
          },
          listSubscriptions: () => Effect.succeed([]),
        })
      )

      emitEvent.current = (event: WatchFileEvent) => {
        for (const handler of [...handlers]) {
          handler(event)
        }
      }

      const repoIdentityLayer = Layer.succeed(
        RepositoryIdentity,
        RepositoryIdentity.of({
          resolve: () =>
            Effect.sync(() => {
              resolveCalls.current += 1
              throw new Error('watchAll should use persisted identity')
            }),
        })
      )

      const reconcilerLayer = Layer.succeed(
        WorktreeReconciler,
        WorktreeReconciler.of({
          reconcile: (_projectId, _repoPath) =>
            Effect.sync(() => {
              reconcileCalls.current += 1
              return { added: 0, removed: 0, unchanged: 0 }
            }),
        })
      )

      const branchTrackerLayer = Layer.succeed(
        BranchStateTracker,
        BranchStateTracker.of({
          refreshBranches: (_projectId) =>
            Effect.sync(() => {
              branchRefreshCalls.current += 1
              return { checked: 0, updated: 0 }
            }),
        })
      )

      const TestLayer = RepositoryWatchCoordinator.layer.pipe(
        Layer.provide(branchTrackerLayer),
        Layer.provide(ConfigService.layer),
        Layer.provide(fileWatcherClientLayer),
        Layer.provide(reconcilerLayer),
        Layer.provide(repoIdentityLayer),
        Layer.provideMerge(TestLaborerStore)
      )

      return Effect.gen(function* () {
        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: 'project-persisted-startup',
            repoPath: '/persisted/repo',
            repoId: 'repo-1',
            canonicalGitCommonDir: '/persisted/repo/.git',
            name: 'persisted-repo',
            rlphConfig: null,
          })
        )

        const coordinator = yield* RepositoryWatchCoordinator
        yield* coordinator.watchAll()

        assert.strictEqual(resolveCalls.current, 0)
        assert.strictEqual(reconcileCalls.current, 1)
        assert.strictEqual(branchRefreshCalls.current, 1)
        assert.deepStrictEqual(
          store.query(tables.projects.where('id', 'project-persisted-startup')),
          [
            {
              id: 'project-persisted-startup',
              repoPath: '/persisted/repo',
              repoId: 'repo-1',
              canonicalGitCommonDir: '/persisted/repo/.git',
              name: 'persisted-repo',
              rlphConfig: null,
            },
          ]
        )
        assert.deepStrictEqual(subscribedPaths, [
          '/persisted/repo/.git',
          '/persisted/repo',
        ])
        assert.deepStrictEqual(unsubscribedIds, [])
      }).pipe(Effect.provide(TestLayer))
    }
  )

  it('formats actionable non-blocking watcher warnings', () => {
    assert.strictEqual(
      formatWatcherWarning('Git watcher error', {
        projectId: 'project-warning',
        path: '/virtual/repo/.git',
        detail: 'ENOENT: watcher target disappeared',
        retrying: true,
      }),
      'Git watcher error for project project-warning at /virtual/repo/.git: ENOENT: watcher target disappeared. Git-backed refresh remains active; retrying watcher setup in 1000ms.'
    )

    assert.strictEqual(
      formatWatcherWarning('Watcher degraded', {
        projectId: 'project-warning',
        detail: 'git-watcher-error; attempting recovery now',
      }),
      'Watcher degraded for project project-warning: git-watcher-error; attempting recovery now.'
    )
  })

  it.scoped('ignores late watcher callbacks after project teardown', () => {
    const reconcileCalls = { current: 0 }
    const branchRefreshCalls = { current: 0 }
    const subscribedPaths: string[] = []
    const unsubscribedIds: string[] = []
    const emitEvent = { current: (_event: WatchFileEvent) => undefined }
    const subscriptionsByPath = new Map<string, string>()

    const TestLayer = createTestLayer({
      reconcileCalls,
      branchRefreshCalls,
      subscribedPaths,
      unsubscribedIds,
      emitEvent,
      subscriptionsByPath,
    })

    return Effect.gen(function* () {
      const coordinator = yield* RepositoryWatchCoordinator
      yield* coordinator.watchProject('project-teardown', '/input/repo')

      const gitSubId = subscriptionsByPath.get('/virtual/repo/.git')
      const repoSubId = subscriptionsByPath.get('/virtual/repo')
      if (gitSubId === undefined || repoSubId === undefined) {
        throw new Error('Expected initial subscriptions')
      }

      yield* coordinator.unwatchProject('project-teardown')

      // Fire events on the old subscription IDs — should be ignored
      emitEvent.current({
        subscriptionId: gitSubId,
        type: 'change',
        fileName: 'HEAD',
        absolutePath: '/virtual/repo/.git/HEAD',
      })
      emitEvent.current({
        subscriptionId: repoSubId,
        type: 'change',
        fileName: 'src/index.ts',
        absolutePath: '/virtual/repo/src/index.ts',
      })

      yield* Effect.promise(() => delay(1600))

      assert.strictEqual(reconcileCalls.current, 0)
      assert.strictEqual(branchRefreshCalls.current, 0)
      assert.deepStrictEqual(subscribedPaths, [
        '/virtual/repo/.git',
        '/virtual/repo',
      ])
      // Unsubscribe should have been called for both subscriptions
      assert.strictEqual(unsubscribedIds.length, 2)
    }).pipe(Effect.provide(TestLayer))
  })

  it.scoped('ignores late watcher callbacks after scope shutdown', () => {
    const reconcileCalls = { current: 0 }
    const branchRefreshCalls = { current: 0 }
    const subscribedPaths: string[] = []
    const unsubscribedIds: string[] = []
    const emitEvent = { current: (_event: WatchFileEvent) => undefined }
    const subscriptionsByPath = new Map<string, string>()

    const TestLayer = createTestLayer({
      reconcileCalls,
      branchRefreshCalls,
      subscribedPaths,
      unsubscribedIds,
      emitEvent,
      subscriptionsByPath,
    })

    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(TestLayer, scope)
      const coordinator = Context.get(ctx, RepositoryWatchCoordinator)

      yield* coordinator.watchProject('project-shutdown', '/input/repo')

      const gitSubId = subscriptionsByPath.get('/virtual/repo/.git')
      if (gitSubId === undefined) {
        throw new Error('Expected git dir subscription')
      }

      yield* Scope.close(scope, Exit.succeed(undefined))

      // Fire events after scope shutdown — should be ignored
      emitEvent.current({
        subscriptionId: gitSubId,
        type: 'add',
        fileName: 'worktrees/late',
        absolutePath: '/virtual/repo/.git/worktrees/late',
      })

      yield* Effect.promise(() => delay(1600))

      assert.strictEqual(reconcileCalls.current, 0)
      assert.strictEqual(branchRefreshCalls.current, 0)
      assert.deepStrictEqual(subscribedPaths, [
        '/virtual/repo/.git',
        '/virtual/repo',
      ])
      // Unsubscribe should have been called for both subscriptions
      assert.strictEqual(unsubscribedIds.length, 2)
    })
  })

  it.scoped(
    'watchProject is idempotent — re-calling for the same project replaces previous watchers',
    () => {
      const reconcileCalls = { current: 0 }
      const branchRefreshCalls = { current: 0 }
      const subscribedPaths: string[] = []
      const unsubscribedIds: string[] = []
      const emitEvent = { current: (_event: WatchFileEvent) => undefined }
      const subscriptionsByPath = new Map<string, string>()

      const TestLayer = createTestLayer({
        reconcileCalls,
        branchRefreshCalls,
        subscribedPaths,
        unsubscribedIds,
        emitEvent,
        subscriptionsByPath,
      })

      return Effect.gen(function* () {
        const coordinator = yield* RepositoryWatchCoordinator

        // First watch
        yield* coordinator.watchProject('project-idempotent', '/input/repo')

        const firstGitSubId = subscriptionsByPath.get('/virtual/repo/.git')
        const firstRepoSubId = subscriptionsByPath.get('/virtual/repo')
        assert.isDefined(firstGitSubId)
        assert.isDefined(firstRepoSubId)

        // Re-watch the same project — should unsubscribe old and create new
        yield* coordinator.watchProject('project-idempotent', '/input/repo')

        // The first subscriptions should have been unsubscribed
        if (firstGitSubId === undefined || firstRepoSubId === undefined) {
          throw new Error('Expected first subscription IDs')
        }
        assert.isTrue(
          unsubscribedIds.includes(firstGitSubId),
          'First git subscription should be unsubscribed after re-watch'
        )
        assert.isTrue(
          unsubscribedIds.includes(firstRepoSubId),
          'First repo subscription should be unsubscribed after re-watch'
        )

        // New subscriptions should have been created
        const secondGitSubId = subscriptionsByPath.get('/virtual/repo/.git')
        if (secondGitSubId === undefined) {
          throw new Error('Expected second git subscription')
        }
        assert.notStrictEqual(
          secondGitSubId,
          firstGitSubId,
          'Should have a new git subscription after re-watch'
        )

        // The new subscriptions should still work — deliver a branch event
        emitEvent.current({
          subscriptionId: secondGitSubId,
          type: 'change',
          fileName: 'HEAD',
          absolutePath: '/virtual/repo/.git/HEAD',
        })

        yield* Effect.promise(() =>
          waitFor(() => Promise.resolve(branchRefreshCalls.current === 1))
        )
      }).pipe(Effect.provide(TestLayer))
    }
  )

  it.scoped(
    'git event classification routes HEAD and refs to branch refresh, worktrees to reconciliation',
    () => {
      const reconcileCalls = { current: 0 }
      const branchRefreshCalls = { current: 0 }
      const subscribedPaths: string[] = []
      const unsubscribedIds: string[] = []
      const emitEvent = { current: (_event: WatchFileEvent) => undefined }
      const subscriptionsByPath = new Map<string, string>()

      const TestLayer = createTestLayer({
        reconcileCalls,
        branchRefreshCalls,
        subscribedPaths,
        unsubscribedIds,
        emitEvent,
        subscriptionsByPath,
      })

      return Effect.gen(function* () {
        const coordinator = yield* RepositoryWatchCoordinator
        yield* coordinator.watchProject('project-classify', '/input/repo')

        const gitSubId = subscriptionsByPath.get('/virtual/repo/.git')
        if (gitSubId === undefined) {
          throw new Error('Expected git dir subscription')
        }

        // Test branch-related events: HEAD, refs/heads/main, MERGE_HEAD,
        // REBASE_HEAD, ORIG_HEAD, FETCH_HEAD
        const branchFiles = [
          'HEAD',
          'refs/heads/main',
          'MERGE_HEAD',
          'REBASE_HEAD',
          'ORIG_HEAD',
          'FETCH_HEAD',
        ]

        for (const fileName of branchFiles) {
          emitEvent.current({
            subscriptionId: gitSubId,
            type: 'change',
            fileName,
            absolutePath: `/virtual/repo/.git/${fileName}`,
          })
        }

        yield* Effect.promise(() =>
          waitFor(() => Promise.resolve(branchRefreshCalls.current === 1))
        )

        // All branch events debounce to a single branch refresh
        assert.strictEqual(
          branchRefreshCalls.current,
          1,
          'Branch-related events should trigger branch refresh'
        )

        // Reset and test worktree-specific events
        reconcileCalls.current = 0
        branchRefreshCalls.current = 0

        emitEvent.current({
          subscriptionId: gitSubId,
          type: 'add',
          fileName: 'worktrees/my-feature',
          absolutePath: '/virtual/repo/.git/worktrees/my-feature',
        })

        yield* Effect.promise(() =>
          waitFor(() => Promise.resolve(reconcileCalls.current === 1))
        )

        assert.strictEqual(
          reconcileCalls.current,
          1,
          'Worktree-related events should trigger reconciliation'
        )

        // Test null fileName — should trigger both branch AND worktree
        reconcileCalls.current = 0
        branchRefreshCalls.current = 0

        emitEvent.current({
          subscriptionId: gitSubId,
          type: 'change',
          fileName: null,
          absolutePath: '/virtual/repo/.git',
        })

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              reconcileCalls.current === 1 && branchRefreshCalls.current === 1
            )
          )
        )

        assert.strictEqual(
          reconcileCalls.current,
          1,
          'null fileName should trigger reconciliation'
        )
        assert.strictEqual(
          branchRefreshCalls.current,
          1,
          'null fileName should trigger branch refresh'
        )
      }).pipe(Effect.provide(TestLayer))
    }
  )
})

describe('repo-watching git command options', () => {
  it('disables fsmonitor for correctness-sensitive git reads', () => {
    assert.deepStrictEqual(withFsmonitorDisabled(['status', '--porcelain']), [
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain',
    ])
  })
})
