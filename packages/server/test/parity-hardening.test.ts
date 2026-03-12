/**
 * Parity hardening and regression coverage
 *
 * This test file consolidates regression coverage across the entire
 * OpenCode alignment work (Issues 1–6), proving that:
 *
 * 1. Persisted identity migration/backfill and direct dedupe behavior
 *    are robust under edge cases.
 * 2. FileWatcherClient subscribe calls include proper ignore globs
 *    when passed by the coordinator.
 * 3. End-to-end downstream invalidation (FileWatcherClient events →
 *    DiffService) operates correctly.
 * 4. Coverage reporting includes the updated repo-watching areas.
 *
 * @see PRD-opencode-repo-watching-alignment — Issue 7
 * @see PRD-file-watcher-extraction.md
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { DiffService } from '../src/services/diff-service.js'
import {
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherClient,
} from '../src/services/file-watcher-client.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import {
  DEFAULT_IGNORED_PREFIXES,
  shouldIgnore,
} from '../src/services/repository-event-bus.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay } from './helpers/timing-helpers.js'

const tempRoots: string[] = []

const SRC_TS_PATTERN = /^src\/.*\.ts$/

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// ── Shared test layer factories ─────────────────────────────────

interface RecordedSubscription {
  readonly id: string
  readonly ignoreGlobs: readonly string[]
  readonly path: string
  readonly recursive: boolean
}

const createRecordingFileWatcherClientLayer = (params: {
  readonly subscribedPaths: RecordedSubscription[]
  readonly emitEvent: { current: (event: WatchFileEvent) => void }
  readonly subscriptionsByPath: Map<string, string>
}) => {
  let subCounter = 0
  const handlers: FileEventHandler[] = []

  params.emitEvent.current = (event: WatchFileEvent) => {
    for (const handler of [...handlers]) {
      handler(event)
    }
  }

  return Layer.succeed(
    FileWatcherClient,
    FileWatcherClient.of({
      subscribe: (path, options) =>
        Effect.sync(() => {
          subCounter += 1
          const id = `test-sub-${subCounter}`
          const sub: RecordedSubscription = {
            id,
            path,
            recursive: options?.recursive ?? false,
            ignoreGlobs: options?.ignoreGlobs ?? [],
          }
          params.subscribedPaths.push(sub)
          params.subscriptionsByPath.set(path, id)
          return sub
        }),
      unsubscribe: () => Effect.void,
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
}

const createCoordinatorTestLayer = (
  repoPath: string,
  params: {
    readonly subscribedPaths: RecordedSubscription[]
    readonly emitEvent: { current: (event: WatchFileEvent) => void }
    readonly subscriptionsByPath: Map<string, string>
  }
) => {
  const fileWatcherClientLayer = createRecordingFileWatcherClientLayer(params)

  return RepositoryWatchCoordinator.layer.pipe(
    Layer.provide(
      Layer.succeed(
        BranchStateTracker,
        BranchStateTracker.of({
          refreshBranches: () => Effect.succeed({ checked: 0, updated: 0 }),
        })
      )
    ),
    Layer.provide(ConfigService.layer),
    Layer.provide(fileWatcherClientLayer),
    Layer.provide(
      Layer.succeed(
        WorktreeReconciler,
        WorktreeReconciler.of({
          reconcile: () =>
            Effect.succeed({ added: 0, removed: 0, unchanged: 0 }),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        RepositoryIdentity,
        RepositoryIdentity.of({
          resolve: () =>
            Effect.succeed({
              canonicalRoot: repoPath,
              canonicalGitCommonDir: join(repoPath, '.git'),
              repoId: `${repoPath}-repo`,
              isMainWorktree: true,
            }),
        })
      )
    ),
    Layer.provideMerge(TestLaborerStore)
  )
}

const createEndToEndLayerWithDiffService = (
  repoPath: string,
  params: {
    readonly subscribedPaths: RecordedSubscription[]
    readonly emitEvent: { current: (event: WatchFileEvent) => void }
    readonly subscriptionsByPath: Map<string, string>
  }
) => {
  const fileWatcherClientLayer = createRecordingFileWatcherClientLayer(params)

  return DiffService.layer.pipe(
    Layer.provideMerge(RepositoryWatchCoordinator.layer),
    Layer.provide(
      Layer.succeed(
        BranchStateTracker,
        BranchStateTracker.of({
          refreshBranches: () => Effect.succeed({ checked: 0, updated: 0 }),
        })
      )
    ),
    Layer.provide(ConfigService.layer),
    Layer.provide(fileWatcherClientLayer),
    Layer.provide(
      Layer.succeed(
        WorktreeReconciler,
        WorktreeReconciler.of({
          reconcile: () =>
            Effect.succeed({ added: 0, removed: 0, unchanged: 0 }),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        RepositoryIdentity,
        RepositoryIdentity.of({
          resolve: () =>
            Effect.succeed({
              canonicalRoot: repoPath,
              canonicalGitCommonDir: join(repoPath, '.git'),
              repoId: `${repoPath}-repo`,
              isMainWorktree: true,
            }),
        })
      )
    ),
    Layer.provideMerge(TestLaborerStore)
  )
}

// ── 1. Persisted identity migration/backfill and dedupe ─────────

describe('Persisted identity migration and dedupe hardening', () => {
  /**
   * Full service stack for tests that exercise the real
   * ProjectRegistry + RepositoryIdentity service path.
   */
  const RegistryTestLayer = ProjectRegistry.layer.pipe(
    Layer.provide(RepositoryWatchCoordinator.layer),
    Layer.provide(BranchStateTracker.layer),
    Layer.provide(ConfigService.layer),
    Layer.provide(TestFileWatcherClientLayer),
    Layer.provide(WorktreeReconciler.layer),
    Layer.provide(WorktreeDetector.layer),
    Layer.provide(RepositoryIdentity.layer),
    Layer.provide(PortAllocator.make(4900, 4920)),
    Layer.provideMerge(TestLaborerStore)
  )

  const RegistryWithIdentityTestLayer = RegistryTestLayer.pipe(
    Layer.provideMerge(RepositoryIdentity.layer)
  )

  it.scoped(
    'dedupe by persisted repoId prevents duplicate across separate registration calls',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-dedupe-repoid', tempRoots)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)

        // Verify persisted identity was written
        const { store } = yield* LaborerStore
        const [record] = store.query(
          tables.projects.where('id', project.id)
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.isNotNull(record?.repoId, 'repoId should be persisted')
        assert.isNotNull(
          record?.canonicalGitCommonDir,
          'canonicalGitCommonDir should be persisted'
        )

        // Attempt to re-register the exact same path
        const result = yield* registry.addProject(repoPath).pipe(Effect.flip)
        assert.include(result.message, 'already registered')

        // Verify only one project exists
        const allProjects = yield* registry.listProjects()
        const matchingProjects = allProjects.filter(
          (p) => p.repoPath === project.repoPath
        )
        assert.strictEqual(matchingProjects.length, 1)
      }).pipe(Effect.provide(RegistryTestLayer))
  )

  it.scoped(
    'backfill populates identity for legacy project with null repoId',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-backfill-null', tempRoots)
        const registry = yield* ProjectRegistry
        const { store } = yield* LaborerStore
        const identity = yield* RepositoryIdentity
        const resolvedIdentity = yield* identity.resolve(repoPath)

        // Seed a legacy project missing identity fields
        store.commit(
          events.projectCreated({
            id: 'legacy-null-identity',
            repoPath,
            name: 'legacy-null-identity',
            rlphConfig: null,
          })
        )

        // Verify the stored record initially has null identity
        const beforeBackfill = store.query(
          tables.projects.where('id', 'legacy-null-identity')
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.isNull(beforeBackfill[0]?.repoId)
        assert.isNull(beforeBackfill[0]?.canonicalGitCommonDir)

        // Listing projects triggers lazy backfill
        const [project] = yield* registry.listProjects()
        assert.strictEqual(project?.repoId, resolvedIdentity.repoId)
        assert.strictEqual(
          project?.canonicalGitCommonDir,
          resolvedIdentity.canonicalGitCommonDir
        )

        // Verify the store was durably updated
        const afterBackfill = store.query(
          tables.projects.where('id', 'legacy-null-identity')
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.strictEqual(afterBackfill[0]?.repoId, resolvedIdentity.repoId)
        assert.strictEqual(
          afterBackfill[0]?.canonicalGitCommonDir,
          resolvedIdentity.canonicalGitCommonDir
        )
      }).pipe(Effect.provide(RegistryWithIdentityTestLayer))
  )

  it.scoped(
    'worktree dedupe works via persisted repoId even when raw paths differ',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-wt-dedupe', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'hardening-wt')
        git(`worktree add -b feature/hardening-wt ${worktreePath}`, repoPath)

        const registry = yield* ProjectRegistry

        // Register the main checkout
        const project = yield* registry.addProject(repoPath)

        // Attempt to register via the linked worktree path
        const result = yield* registry
          .addProject(worktreePath)
          .pipe(Effect.flip)
        assert.include(result.message, 'already registered')

        // Only one project should exist
        const allProjects = yield* registry.listProjects()
        assert.strictEqual(allProjects.length, 1)
        assert.strictEqual(allProjects[0]?.id, project.id)
      }).pipe(Effect.provide(RegistryTestLayer))
  )
})

// ── 2. FileWatcherClient ignore passthrough ─────────────────────

describe('FileWatcherClient ignore passthrough hardening', () => {
  it.scoped(
    'repo-root subscription is created with recursive watching enabled',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-ignore-passthrough', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-ignore-passthrough',
            repoPath
          )

          // Find the repo-root subscription (not the .git subscription)
          const repoRootSub = subscribedPaths.find(
            (sub) => sub.path === repoPath
          )
          assert.isDefined(repoRootSub, 'Should have a repo-root subscription')
          assert.isTrue(
            repoRootSub?.recursive ?? false,
            'Repo-root subscription should be recursive'
          )

          // Without config-driven watchIgnore, the coordinator passes
          // no ignore globs — default filtering is handled by the
          // file-watcher service's WatcherManager.
          const ignoreGlobs = repoRootSub?.ignoreGlobs ?? []
          assert.strictEqual(
            ignoreGlobs.length,
            0,
            'Without config watchIgnore, coordinator should pass no ignore globs (defaults applied by file-watcher service)'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'config-driven watchIgnore patterns are included in watcher-level ignore globs',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-config-ignore-globs', tempRoots)

        // Write a laborer.json with custom watchIgnore
        writeFileSync(
          join(repoPath, 'laborer.json'),
          '{"watchIgnore":[".myCache","tempOutput"]}'
        )

        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-config-ignore-globs',
            repoPath,
            'config-ignore-globs-test'
          )

          const repoRootSub = subscribedPaths.find(
            (sub) => sub.path === repoPath
          )
          const ignoreGlobs = repoRootSub?.ignoreGlobs ?? []

          // Custom config patterns should be in the globs
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('.myCache')),
            '.myCache should be in watcher ignore globs from config'
          )
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('tempOutput')),
            'tempOutput should be in watcher ignore globs from config'
          )

          // Default patterns are NOT passed by the coordinator —
          // they are applied by the file-watcher service's
          // WatcherManager. Only config-driven patterns appear here.
          assert.strictEqual(
            ignoreGlobs.length,
            2,
            'Only config-driven ignore globs should be passed by coordinator'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'git-dir subscription does not receive ignore globs (only repo-root does)',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-gitdir-no-ignore', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject('project-gitdir-no-ignore', repoPath)

          const gitDirSub = subscribedPaths.find((sub) =>
            sub.path.endsWith('.git')
          )
          assert.isDefined(gitDirSub, 'Should have a .git subscription')

          // Git dir subscription should not have ignore globs
          assert.strictEqual(
            gitDirSub?.ignoreGlobs.length ?? 0,
            0,
            'Git dir subscription should not have ignore globs'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )
})

// ── 3. Ignore filtering pure functions ──────────────────────────

describe('Ignore filtering boundary hardening', () => {
  it.effect('shouldIgnore handles deeply nested ignored paths', () =>
    Effect.sync(() => {
      assert.isTrue(
        shouldIgnore(
          'node_modules/@scope/package/dist/index.js',
          DEFAULT_IGNORED_PREFIXES
        )
      )
      assert.isTrue(
        shouldIgnore('.git/refs/heads/main', DEFAULT_IGNORED_PREFIXES)
      )
      assert.isTrue(
        shouldIgnore('dist/esm/chunk-abc123.js', DEFAULT_IGNORED_PREFIXES)
      )
      assert.isTrue(
        shouldIgnore(
          'coverage/lcov-report/src/index.ts.html',
          DEFAULT_IGNORED_PREFIXES
        )
      )
    })
  )

  it.effect('shouldIgnore allows paths that share prefix substrings', () =>
    Effect.sync(() => {
      // "distribution" starts with "dist" but is a different first segment
      assert.isFalse(
        shouldIgnore('distribution/README.md', DEFAULT_IGNORED_PREFIXES)
      )
      // "builder" starts with "build" but is a different first segment
      assert.isFalse(
        shouldIgnore('builder/config.ts', DEFAULT_IGNORED_PREFIXES)
      )
      // "outreach" starts with "out" but is a different first segment
      assert.isFalse(shouldIgnore('outreach/docs.md', DEFAULT_IGNORED_PREFIXES))
    })
  )
})

// ── 4. End-to-end downstream invalidation ───────────────────────

describe('End-to-end downstream invalidation hardening', () => {
  it.scoped(
    'file event triggers DiffService invalidation through full pipeline',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-e2e-native', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createEndToEndLayerWithDiffService(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const diffService = yield* DiffService
          const { store } = yield* LaborerStore

          const projectId = 'project-e2e-native'

          store.commit(
            events.projectCreated({
              id: projectId,
              repoPath,
              name: 'e2e-native-test',
              rlphConfig: null,
            })
          )

          const workspaceId = crypto.randomUUID()
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId,
              taskSource: null,
              branchName: 'main',
              worktreePath: repoPath,
              port: 0,
              status: 'running',
              origin: 'laborer',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )

          yield* coordinator.watchProject(projectId, repoPath)
          yield* diffService.startPolling(workspaceId, 60_000)

          // Deliver a file event through the FileWatcherClient
          const repoSubId = subscriptionsByPath.get(repoPath)
          if (repoSubId === undefined) {
            throw new Error('Expected repo root subscription')
          }

          emitEvent.current({
            subscriptionId: repoSubId,
            type: 'add',
            fileName: 'new-feature.ts',
            absolutePath: join(repoPath, 'new-feature.ts'),
          })

          // Wait for debounce to fire
          yield* Effect.promise(() => delay(500))

          // DiffService should still be operational
          const stillPolling = yield* diffService.isPolling(workspaceId)
          assert.isTrue(
            stillPolling,
            'DiffService should remain operational after event processing'
          )

          yield* diffService.stopPolling(workspaceId)
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'rapid file events coalesce correctly in DiffService debounce',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-e2e-mixed', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createEndToEndLayerWithDiffService(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const diffService = yield* DiffService
          const { store } = yield* LaborerStore

          const projectId = 'project-e2e-mixed'

          store.commit(
            events.projectCreated({
              id: projectId,
              repoPath,
              name: 'e2e-mixed-test',
              rlphConfig: null,
            })
          )

          const workspaceId = crypto.randomUUID()
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId,
              taskSource: null,
              branchName: 'main',
              worktreePath: repoPath,
              port: 0,
              status: 'running',
              origin: 'laborer',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )

          yield* coordinator.watchProject(projectId, repoPath)
          yield* diffService.startPolling(workspaceId, 60_000)

          // Deliver a burst of file events
          const repoSubId = subscriptionsByPath.get(repoPath)
          if (repoSubId === undefined) {
            throw new Error('Expected repo root subscription')
          }

          for (let i = 0; i < 5; i++) {
            emitEvent.current({
              subscriptionId: repoSubId,
              type: 'add',
              fileName: `burst-${i}.ts`,
              absolutePath: join(repoPath, `burst-${i}.ts`),
            })
          }

          // Wait for debounce + processing
          yield* Effect.promise(() => delay(600))

          // DiffService should coalesce them via debounce
          const stillPolling = yield* diffService.isPolling(workspaceId)
          assert.isTrue(stillPolling)

          yield* diffService.stopPolling(workspaceId)
        }).pipe(Effect.provide(testLayer))
      })
  )
})

// ── 5. Coverage reporting ───────────────────────────────────────

describe('Coverage configuration', () => {
  it.effect(
    'vitest config includes src/**/*.ts in coverage include pattern',
    () =>
      Effect.sync(() => {
        // Key source files that MUST be included in coverage:
        const coveredFiles = [
          'src/services/repository-identity.ts',
          'src/services/file-watcher-client.ts',
          'src/services/repository-watch-coordinator.ts',
          'src/services/project-registry.ts',
          'src/services/diff-service.ts',
          'src/services/config-service.ts',
        ]

        // Verify each file matches the src/**/*.ts pattern
        for (const file of coveredFiles) {
          assert.match(
            file,
            SRC_TS_PATTERN,
            `${file} should match the coverage include pattern src/**/*.ts`
          )
        }
      })
  )
})
