import { existsSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import {
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherClient,
} from '../src/services/file-watcher-client.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay, waitFor } from './helpers/timing-helpers.js'

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

/**
 * Create a recording FileWatcherClient layer that tracks subscriptions
 * and allows emitting synthetic events to trigger coordinator behavior.
 */
const createRecordingClientLayer = () => {
  let subCounter = 0
  const handlers: FileEventHandler[] = []
  /** Map from subscription path to subscription ID */
  const subscriptionsByPath = new Map<string, string>()
  const subscribeCalls: string[] = []
  const unsubscribedIds: string[] = []

  const emitEvent = (event: WatchFileEvent): void => {
    for (const handler of [...handlers]) {
      handler(event)
    }
  }

  const layer = Layer.succeed(
    FileWatcherClient,
    FileWatcherClient.of({
      subscribe: (path, options) =>
        Effect.sync(() => {
          subCounter += 1
          const id = `rec-sub-${subCounter}`
          subscribeCalls.push(path)
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
      onFileEvent: (handler): FileEventSubscription => {
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

  return {
    layer,
    emitEvent,
    subscriptionsByPath,
    subscribeCalls,
    unsubscribedIds,
  }
}

const createTestLayerWithRecording = (
  portStart: number,
  portEnd: number,
  clientLayer: Layer.Layer<FileWatcherClient>
) =>
  RepositoryWatchCoordinator.layer.pipe(
    Layer.provide(BranchStateTracker.layer),
    Layer.provide(ConfigService.layer),
    Layer.provide(clientLayer),
    Layer.provide(WorktreeReconciler.layer),
    Layer.provide(WorktreeDetector.layer),
    Layer.provide(RepositoryIdentity.layer),
    Layer.provide(PortAllocator.make(portStart, portEnd)),
    Layer.provideMerge(TestLaborerStore)
  )

describe('RepositoryWatchCoordinator scoped lifecycle', () => {
  it.scoped(
    'each registered project gets a scoped watcher coordinator tied to its lifecycle',
    () =>
      Effect.gen(function* () {
        const recording = createRecordingClientLayer()
        const repoPath = initRepo('coord-scoped-1', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'coord-one')
        const testLayer = createTestLayerWithRecording(
          4500,
          4505,
          recording.layer
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject('project-coord-1', repoPath)

          const { store } = yield* LaborerStore

          // Creating a worktree modifies the git directory
          git(`worktree add -b coord/one ${linkedPath}`, repoPath)

          // Resolve canonical path (macOS tmpdir is a symlink)
          const canonicalRepoPath = realpathSync(repoPath)
          const gitDirPath = join(canonicalRepoPath, '.git')

          // Emit a synthetic git-dir event to simulate the file-watcher
          // service detecting the git metadata change
          const gitDirSubId = recording.subscriptionsByPath.get(gitDirPath)
          assert.isDefined(
            gitDirSubId,
            `Should have a git-dir subscription (subscribed paths: ${[...recording.subscriptionsByPath.keys()].join(', ')})`
          )
          recording.emitEvent({
            subscriptionId: gitDirSubId ?? '',
            type: 'add',
            fileName: 'worktrees/coord-one/HEAD',
            absolutePath: join(gitDirPath, 'worktrees/coord-one/HEAD'),
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                store.query(
                  tables.workspaces.where('projectId', 'project-coord-1')
                ).length === 2
              )
            )
          )

          const workspaces = store.query(
            tables.workspaces.where('projectId', 'project-coord-1')
          )
          assert.strictEqual(workspaces.length, 2)
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'coordinator watches the canonical common git dir for metadata changes',
    () =>
      Effect.gen(function* () {
        const recording = createRecordingClientLayer()
        const repoPath = initRepo('coord-gitdir-1', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'coord-gitdir')
        const testLayer = createTestLayerWithRecording(
          4506,
          4510,
          recording.layer
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject('project-coord-gitdir', repoPath)

          const { store } = yield* LaborerStore

          // Adding a worktree modifies the git common dir
          git(`worktree add -b coord/gitdir ${linkedPath}`, repoPath)

          // Resolve canonical path (macOS tmpdir is a symlink)
          const canonicalRepoPath = realpathSync(repoPath)
          const gitDirPath = join(canonicalRepoPath, '.git')

          // Emit a synthetic git-dir event
          const gitDirSubId = recording.subscriptionsByPath.get(gitDirPath)
          assert.isDefined(
            gitDirSubId,
            `Should have a git-dir subscription (subscribed paths: ${[...recording.subscriptionsByPath.keys()].join(', ')})`
          )
          recording.emitEvent({
            subscriptionId: gitDirSubId ?? '',
            type: 'add',
            fileName: 'worktrees/coord-gitdir/HEAD',
            absolutePath: join(gitDirPath, 'worktrees/coord-gitdir/HEAD'),
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                store.query(
                  tables.workspaces.where('projectId', 'project-coord-gitdir')
                ).length === 2
              )
            )
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped('removing a project tears down its watchers cleanly', () =>
    Effect.gen(function* () {
      const recording = createRecordingClientLayer()
      const repoPath = initRepo('coord-teardown-1', tempRoots)
      const linkedA = join(repoPath, '.worktrees', 'coord-teardown-a')
      const linkedB = join(repoPath, '.worktrees', 'coord-teardown-b')
      const testLayer = createTestLayerWithRecording(
        4531,
        4540,
        recording.layer
      )

      yield* Effect.gen(function* () {
        const coordinator = yield* RepositoryWatchCoordinator
        yield* coordinator.watchProject('project-coord-teardown', repoPath)

        const { store } = yield* LaborerStore

        // Resolve canonical path (macOS tmpdir is a symlink)
        const canonicalRepoPath = realpathSync(repoPath)
        const gitDirPath = join(canonicalRepoPath, '.git')
        const gitDirSubId = recording.subscriptionsByPath.get(gitDirPath)

        // First worktree should be detected after emitting event
        git(`worktree add -b coord/teardown-a ${linkedA}`, repoPath)
        recording.emitEvent({
          subscriptionId: gitDirSubId ?? '',
          type: 'add',
          fileName: 'worktrees/coord-teardown-a/HEAD',
          absolutePath: join(gitDirPath, 'worktrees/coord-teardown-a/HEAD'),
        })

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              store.query(
                tables.workspaces.where('projectId', 'project-coord-teardown')
              ).length === 2
            )
          )
        )

        // Tear down watchers for this project
        yield* coordinator.unwatchProject('project-coord-teardown')

        // Creating another worktree after teardown should NOT be detected.
        // Even if we emit an event, the coordinator should ignore it
        // because the subscription was removed.
        git(`worktree add -b coord/teardown-b ${linkedB}`, repoPath)
        recording.emitEvent({
          subscriptionId: gitDirSubId ?? '',
          type: 'add',
          fileName: 'worktrees/coord-teardown-b/HEAD',
          absolutePath: join(gitDirPath, 'worktrees/coord-teardown-b/HEAD'),
        })
        yield* Effect.promise(() => delay(1500))

        const workspaces = store.query(
          tables.workspaces.where('projectId', 'project-coord-teardown')
        )
        assert.strictEqual(
          workspaces.length,
          2,
          'No new workspace should be created after unwatching'
        )
      }).pipe(Effect.provide(testLayer))
    })
  )

  it.scoped(
    'server shutdown tears down watcher resources through scoped service disposal',
    () =>
      Effect.gen(function* () {
        const recording = createRecordingClientLayer()
        const repoPath = initRepo('coord-shutdown-1', tempRoots)

        const ScopedTestLayer = createTestLayerWithRecording(
          4511,
          4520,
          recording.layer
        )

        // Create a manual scope to simulate server lifecycle
        const scope = yield* Scope.make()

        const ctx = yield* Layer.buildWithScope(ScopedTestLayer, scope)
        const coordinator = Context.get(ctx, RepositoryWatchCoordinator)

        yield* coordinator.watchProject('project-coord-shutdown', repoPath)

        // Verify watchers were subscribed
        assert.isAbove(
          recording.subscribeCalls.length,
          0,
          'Should have subscribed watchers'
        )

        // Close the scope (simulates server shutdown)
        yield* Scope.close(scope, Exit.succeed(undefined))

        // Verify all watchers were unsubscribed
        assert.strictEqual(
          recording.unsubscribedIds.length,
          recording.subscribeCalls.length,
          'All subscribed watchers should be unsubscribed on scope cleanup'
        )
      }).pipe(
        Effect.provide(
          createTestLayerWithRecording(4541, 4550, TestFileWatcherClientLayer)
        )
      )
  )

  it.scoped('uses FileWatcherClient abstraction for subscriptions', () =>
    Effect.gen(function* () {
      const recording = createRecordingClientLayer()
      const repoPath = initRepo('coord-abstraction-1', tempRoots)

      const ScopedTestLayer = createTestLayerWithRecording(
        4521,
        4530,
        recording.layer
      )

      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(ScopedTestLayer, scope)
      const coordinator = Context.get(ctx, RepositoryWatchCoordinator)

      yield* coordinator.watchProject('project-coord-abs', repoPath)

      assert.isAbove(
        recording.subscribeCalls.length,
        0,
        'Should subscribe through FileWatcherClient abstraction'
      )

      // The subscribed path should be a git metadata directory
      const hasGitPath = recording.subscribeCalls.some(
        (p) => p.includes('.git') || p.endsWith('.git')
      )
      assert.isTrue(
        hasGitPath,
        'Should subscribe to the git metadata directory'
      )

      yield* Scope.close(scope, Exit.succeed(undefined))
    }).pipe(
      Effect.provide(
        createTestLayerWithRecording(4551, 4560, TestFileWatcherClientLayer)
      )
    )
  )
})
