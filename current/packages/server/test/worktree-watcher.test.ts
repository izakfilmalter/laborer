import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientRealLayer } from './helpers/test-file-watcher-client.js'
import { NoopSandboxProvider } from './helpers/test-sandbox-provider.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay, waitForWithNudge } from './helpers/timing-helpers.js'

const tempRoots: string[] = []

const TestLayer = RepositoryWatchCoordinator.layer.pipe(
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(TestFileWatcherClientRealLayer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(NoopSandboxProvider),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provideMerge(TestLaborerStore)
)

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('RepositoryWatchCoordinator', () => {
  it.scoped('reconciles on worktree add and remove', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('watcher-add-remove', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'watcher-one')

      const coordinator = yield* RepositoryWatchCoordinator
      yield* coordinator.watchProject('project-watch-1', repoPath)
      // Allow @parcel/watcher FSEvents subscription to fully initialize
      yield* Effect.promise(() => delay(500))

      const { store } = yield* LaborerStore

      git(`worktree add -b watcher/one ${linkedPath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              store.query(
                tables.workspaces.where('projectId', 'project-watch-1')
              ).length === 2
            ),
          repoPath
        )
      )

      git(`worktree remove --force ${linkedPath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              store.query(
                tables.workspaces.where('projectId', 'project-watch-1')
              ).length === 1
            ),
          repoPath
        )
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('unwatchProject stops future reconciliation', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('watcher-unwatch', tempRoots)
      const linkedA = join(repoPath, '.worktrees', 'watcher-a')
      const linkedB = join(repoPath, '.worktrees', 'watcher-b')

      const coordinator = yield* RepositoryWatchCoordinator
      yield* coordinator.watchProject('project-watch-2', repoPath)
      // Allow @parcel/watcher FSEvents subscription to fully initialize
      yield* Effect.promise(() => delay(500))

      const { store } = yield* LaborerStore

      git(`worktree add -b watcher/a ${linkedA}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              store.query(
                tables.workspaces.where('projectId', 'project-watch-2')
              ).length === 2
            ),
          repoPath
        )
      )

      yield* coordinator.unwatchProject('project-watch-2')

      git(`worktree add -b watcher/b ${linkedB}`, repoPath)
      yield* Effect.promise(() => delay(1500))

      const rows = store.query(
        tables.workspaces.where('projectId', 'project-watch-2')
      )
      assert.strictEqual(rows.length, 2)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('watchAll reconciles existing projects and starts watchers', () =>
    Effect.gen(function* () {
      const repoA = initRepo('watcher-all-a', tempRoots)
      const repoB = initRepo('watcher-all-b', tempRoots)
      const linkedA = join(repoA, '.worktrees', 'watcher-all-a-one')
      git(`worktree add -b watcher/all-a ${linkedA}`, repoA)

      const coordinator = yield* RepositoryWatchCoordinator
      const { store } = yield* LaborerStore

      // Allow the daemon watchAll (fired during layer construction)
      // to complete on the empty store before seeding projects.
      yield* Effect.promise(() => delay(200))

      store.commit(
        events.projectCreated({
          id: 'project-watch-all-a',
          repoPath: repoA,
          name: 'watch-all-a',
        })
      )
      store.commit(
        events.projectCreated({
          id: 'project-watch-all-b',
          repoPath: repoB,
          name: 'watch-all-b',
        })
      )

      yield* coordinator.watchAll()

      // After watchAll, reconciliation should have run synchronously
      // for both projects: repoA has main + linked worktree (2),
      // repoB has only the main checkout (1).
      const rowsA = store.query(
        tables.workspaces.where('projectId', 'project-watch-all-a')
      )
      const rowsB = store.query(
        tables.workspaces.where('projectId', 'project-watch-all-b')
      )
      assert.strictEqual(
        rowsA.length,
        2,
        'watchAll should reconcile both worktrees for repoA'
      )
      assert.strictEqual(
        rowsB.length,
        1,
        'watchAll should reconcile main checkout for repoB'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'handles repos with no .git/worktrees until first linked worktree',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('watcher-missing-worktrees', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'watcher-late-create')

        const coordinator = yield* RepositoryWatchCoordinator
        yield* coordinator.watchProject('project-watch-3', repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        const { store } = yield* LaborerStore

        git(`worktree add -b watcher/late ${linkedPath}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(
            () =>
              Promise.resolve(
                store.query(
                  tables.workspaces.where('projectId', 'project-watch-3')
                ).length === 2
              ),
            repoPath
          )
        )
      }).pipe(Effect.provide(TestLayer))
  )
})
