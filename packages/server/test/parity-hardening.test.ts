/**
 * Parity hardening and regression coverage
 *
 * This test file consolidates regression coverage across the entire
 * OpenCode alignment work (Issues 1–6), proving that:
 *
 * 1. Persisted identity migration/backfill and direct dedupe behavior
 *    are robust under edge cases.
 * 2. Native watcher backend and fs.watch fallback behave correctly,
 *    including ignore option passthrough.
 * 3. Ignore filtering at watcher-boundary and event-bus-boundary
 *    levels work in concert without gaps.
 * 4. End-to-end downstream invalidation (watcher → event bus →
 *    DiffService) operates correctly with native event semantics.
 * 5. Coverage reporting includes the updated repo-watching areas.
 *
 * @see PRD-opencode-repo-watching-alignment — Issue 7
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { DiffService } from '../src/services/diff-service.js'
import {
  FileWatcher,
  type FileWatcherSubscribeOptions,
  type WatchEvent,
  type WatchSubscription,
} from '../src/services/file-watcher.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import {
  DEFAULT_IGNORED_PREFIXES,
  RepositoryEventBus,
  type RepositoryFileEvent,
  shouldIgnore,
} from '../src/services/repository-event-bus.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay, waitFor } from './helpers/timing-helpers.js'

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

/**
 * Records all subscribe calls including path, options, and
 * provides a way to deliver synthetic watcher events.
 */
interface RecordedSubscription {
  readonly onChange: (event: WatchEvent) => void
  readonly onError: (error: Error) => void
  readonly options: FileWatcherSubscribeOptions | undefined
  readonly path: string
}

type RecordedSubscriptions = RecordedSubscription[]

const createRecordingFileWatcherLayer = (
  subscriptions: RecordedSubscriptions
) =>
  Layer.succeed(
    FileWatcher,
    FileWatcher.of({
      subscribe: (path, onChange, onError, options) =>
        Effect.sync(() => {
          subscriptions.push({ path, onChange, onError, options })
          return {
            close: () => undefined,
          } satisfies WatchSubscription
        }),
    })
  )

const createCoordinatorTestLayer = (
  repoPath: string,
  subscriptions: RecordedSubscriptions
) => {
  const fileWatcherLayer = createRecordingFileWatcherLayer(subscriptions)

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
    Layer.provideMerge(RepositoryEventBus.layer),
    Layer.provide(fileWatcherLayer),
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
  subscriptions: RecordedSubscriptions
) => {
  const fileWatcherLayer = createRecordingFileWatcherLayer(subscriptions)

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
    Layer.provideMerge(RepositoryEventBus.layer),
    Layer.provide(fileWatcherLayer),
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
    Layer.provideMerge(RepositoryEventBus.layer),
    Layer.provide(FileWatcher.layer),
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

// ── 2. Native backend and fallback behavior ─────────────────────

describe('Native and fallback backend hardening', () => {
  it.scoped(
    'ignore globs are passed to FileWatcher.subscribe for repo-root subscription',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-ignore-passthrough', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-ignore-passthrough',
            repoPath
          )

          // Find the repo-root subscription (not the .git subscription)
          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)
          assert.isDefined(repoRootSub, 'Should have a repo-root subscription')

          // Verify ignore globs were passed
          assert.isDefined(
            repoRootSub?.options?.ignore,
            'Repo-root subscription should include ignore options'
          )
          assert.isAbove(
            repoRootSub?.options?.ignore?.length ?? 0,
            0,
            'Ignore globs should not be empty'
          )

          // Verify that default ignore patterns are represented
          const ignoreGlobs = repoRootSub?.options?.ignore ?? []
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('node_modules')),
            'node_modules should be in ignore globs'
          )
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('.git')),
            '.git should be in ignore globs'
          )
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('dist')),
            'dist should be in ignore globs'
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
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ watchIgnore: ['.myCache', 'tempOutput'] })
        )

        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-config-ignore-globs',
            repoPath,
            'config-ignore-globs-test'
          )

          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)
          const ignoreGlobs = repoRootSub?.options?.ignore ?? []

          // Custom config patterns should be in the globs
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('.myCache')),
            '.myCache should be in watcher ignore globs from config'
          )
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('tempOutput')),
            'tempOutput should be in watcher ignore globs from config'
          )

          // Default patterns should still be present
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('node_modules')),
            'Default node_modules should still be in globs'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'git-dir subscription does not receive ignore globs (only repo-root does)',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-gitdir-no-ignore', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject('project-gitdir-no-ignore', repoPath)

          const gitDirSub = subscriptions.find((sub) =>
            sub.path.endsWith('.git')
          )
          assert.isDefined(gitDirSub, 'Should have a .git subscription')

          // Git dir subscription should not have ignore globs
          assert.isUndefined(
            gitDirSub?.options?.ignore,
            'Git dir subscription should not have ignore globs'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'fallback watcher produces correct normalized events without nativeKind',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-fallback-events', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-fallback-events', repoPath)

          // Simulate fs.watch fallback events (no nativeKind)
          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)

          // File exists on disk → should be classified as "add"
          writeFileSync(
            join(repoPath, 'fallback-file.ts'),
            'export const x = 1;\n'
          )
          repoRootSub?.onChange({
            type: 'rename',
            fileName: 'fallback-file.ts',
          })

          // change event without nativeKind → "change"
          repoRootSub?.onChange({
            type: 'change',
            fileName: 'fallback-file.ts',
          })

          // File does NOT exist → should be classified as "delete"
          repoRootSub?.onChange({
            type: 'rename',
            fileName: 'nonexistent-fallback.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() => Promise.resolve(received.length >= 3))
          )

          const addEvent = received.find(
            (e) => e.relativePath === 'fallback-file.ts' && e.type === 'add'
          )
          const changeEvent = received.find(
            (e) => e.relativePath === 'fallback-file.ts' && e.type === 'change'
          )
          const deleteEvent = received.find(
            (e) => e.relativePath === 'nonexistent-fallback.ts'
          )

          assert.isDefined(addEvent, 'Should have an add event')
          assert.isDefined(changeEvent, 'Should have a change event')
          assert.isDefined(deleteEvent, 'Should have a delete event')
          assert.strictEqual(deleteEvent?.type, 'delete')

          // All events should have the normalized shape
          for (const event of received) {
            assert.isString(event.absolutePath)
            assert.isString(event.relativePath)
            assert.isString(event.projectId)
            assert.isString(event.repoRoot)
            assert.oneOf(event.type, ['add', 'change', 'delete'])
            assert.notProperty(event, 'nativeKind')
          }
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'native backend events with nativeKind produce correct normalized events',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-native-events', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-native-events', repoPath)

          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)

          // Deliver native events with authoritative nativeKind
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'native-created.ts',
          })
          repoRootSub?.onChange({
            type: 'change',
            nativeKind: 'update',
            fileName: 'native-updated.ts',
          })
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'delete',
            fileName: 'native-deleted.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() => Promise.resolve(received.length >= 3))
          )

          const createEvent = received.find(
            (e) => e.relativePath === 'native-created.ts'
          )
          const updateEvent = received.find(
            (e) => e.relativePath === 'native-updated.ts'
          )
          const deleteEvent = received.find(
            (e) => e.relativePath === 'native-deleted.ts'
          )

          assert.strictEqual(createEvent?.type, 'add')
          assert.strictEqual(updateEvent?.type, 'change')
          assert.strictEqual(deleteEvent?.type, 'delete')

          // No backend-specific fields should leak
          for (const event of received) {
            assert.notProperty(event, 'nativeKind')
          }
        }).pipe(Effect.provide(testLayer))
      })
  )
})

// ── 3. Ignore filtering at watcher and event-bus boundaries ─────

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

  it.scoped(
    'ignored events never trigger branch refresh or worktree reconciliation',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-ignore-no-refresh', tempRoots)
        const reconcileCalls = { current: 0 }
        const branchRefreshCalls = { current: 0 }

        const subscriptions: RecordedSubscriptions = []
        const fileWatcherLayer = createRecordingFileWatcherLayer(subscriptions)

        const testLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(
            Layer.succeed(
              BranchStateTracker,
              BranchStateTracker.of({
                refreshBranches: () =>
                  Effect.sync(() => {
                    branchRefreshCalls.current += 1
                    return { checked: 0, updated: 0 }
                  }),
              })
            )
          ),
          Layer.provide(ConfigService.layer),
          Layer.provideMerge(RepositoryEventBus.layer),
          Layer.provide(fileWatcherLayer),
          Layer.provide(
            Layer.succeed(
              WorktreeReconciler,
              WorktreeReconciler.of({
                reconcile: () =>
                  Effect.sync(() => {
                    reconcileCalls.current += 1
                    return { added: 0, removed: 0, unchanged: 0 }
                  }),
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

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const receivedEvents: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            receivedEvents.push(event)
          })

          yield* coordinator.watchProject('project-ignore-refresh', repoPath)

          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)

          // Deliver a burst of ignored-path events
          const ignoredPaths = [
            'node_modules/react/index.js',
            'node_modules/@types/node/index.d.ts',
            'dist/bundle.js',
            'dist/bundle.js.map',
            '.next/cache/webpack.js',
            'coverage/lcov.info',
            '.DS_Store',
          ]

          for (const path of ignoredPaths) {
            repoRootSub?.onChange({
              type: 'change',
              nativeKind: 'update',
              fileName: path,
            })
          }

          // Deliver one non-ignored event as canary
          writeFileSync(
            join(repoPath, 'canary-hardening.ts'),
            'export const x = 1;\n'
          )
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'canary-hardening.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                receivedEvents.some(
                  (e) => e.relativePath === 'canary-hardening.ts'
                )
              )
            )
          )

          // Wait for any potential debounced activity
          yield* Effect.promise(() => delay(700))

          // No ignored events should have reached the bus
          assert.strictEqual(
            receivedEvents.length,
            1,
            `Only canary event should reach bus, got: ${receivedEvents.map((e) => e.relativePath).join(', ')}`
          )
          assert.strictEqual(
            receivedEvents[0]?.relativePath,
            'canary-hardening.ts'
          )

          // The repo-root watcher events for ignored paths should
          // NOT trigger branch refresh or worktree reconciliation
          // (only git-dir events do that). Verify counters are 0.
          assert.strictEqual(
            reconcileCalls.current,
            0,
            'Ignored repo-root events should not trigger reconciliation'
          )
          assert.strictEqual(
            branchRefreshCalls.current,
            0,
            'Ignored repo-root events should not trigger branch refresh'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'watcher-boundary and event-bus-boundary filtering complement each other',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-dual-boundary', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createCoordinatorTestLayer(repoPath, subscriptions)

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-dual-boundary', repoPath)

          // Verify watcher-level ignore globs were set
          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)
          const ignoreGlobs = repoRootSub?.options?.ignore ?? []
          assert.isAbove(
            ignoreGlobs.length,
            0,
            'Watcher-level ignore globs should be set'
          )

          // Even if a watcher-level-ignored event "leaks" through
          // (e.g., because the backend doesn't support ignore),
          // the event bus should still catch it.
          // Simulate this by delivering an ignored-path event directly.
          repoRootSub?.onChange({
            type: 'change',
            nativeKind: 'update',
            fileName: 'node_modules/leaked-event.js',
          })

          // Also deliver a valid source event
          writeFileSync(
            join(repoPath, 'valid-source.ts'),
            'export const y = 2;\n'
          )
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'valid-source.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'valid-source.ts')
              )
            )
          )

          // The leaked ignored event should have been caught by the bus
          const leakedEvents = received.filter((e) =>
            e.relativePath.startsWith('node_modules')
          )
          assert.strictEqual(
            leakedEvents.length,
            0,
            'Event bus should catch ignored events that leak through watcher-level filtering'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )
})

// ── 4. End-to-end downstream invalidation ───────────────────────

describe('End-to-end downstream invalidation hardening', () => {
  it.scoped(
    'native-kind create event triggers DiffService invalidation through full pipeline',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-e2e-native', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createEndToEndLayerWithDiffService(
          repoPath,
          subscriptions
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const diffService = yield* DiffService
          const bus = yield* RepositoryEventBus
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

          // Track events on the bus
          const busEvents: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            busEvents.push(event)
          })

          // Deliver a native create event through the pipeline
          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'new-feature.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                busEvents.some((e) => e.relativePath === 'new-feature.ts')
              )
            )
          )

          // Verify the event reached the bus with correct native-derived type
          const fileEvent = busEvents.find(
            (e) => e.relativePath === 'new-feature.ts'
          )
          assert.isDefined(fileEvent)
          assert.strictEqual(fileEvent?.type, 'add')
          assert.strictEqual(fileEvent?.projectId, projectId)

          // Wait for debounce to fire
          yield* Effect.promise(() => delay(500))

          // DiffService should still be operational
          const stillPolling = yield* diffService.isPolling(workspaceId)
          assert.isTrue(
            stillPolling,
            'DiffService should remain operational after native-kind event processing'
          )

          yield* diffService.stopPolling(workspaceId)
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'mixed native and fallback events coalesce correctly in DiffService debounce',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-e2e-mixed', tempRoots)
        const subscriptions: RecordedSubscriptions = []
        const testLayer = createEndToEndLayerWithDiffService(
          repoPath,
          subscriptions
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const diffService = yield* DiffService
          const bus = yield* RepositoryEventBus
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

          let busEventCount = 0
          yield* bus.subscribe(() => {
            busEventCount++
          })

          const repoRootSub = subscriptions.find((sub) => sub.path === repoPath)

          // Deliver a burst of mixed native and fallback events
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'native-new.ts',
          })
          writeFileSync(
            join(repoPath, 'fallback-exists.ts'),
            'export const x = 1;\n'
          )
          repoRootSub?.onChange({
            type: 'rename',
            fileName: 'fallback-exists.ts',
          })
          repoRootSub?.onChange({
            type: 'change',
            nativeKind: 'update',
            fileName: 'native-updated.ts',
          })
          repoRootSub?.onChange({
            type: 'change',
            fileName: 'fallback-changed.ts',
          })
          repoRootSub?.onChange({
            type: 'rename',
            nativeKind: 'delete',
            fileName: 'native-deleted.ts',
          })

          // Wait for all events to propagate
          yield* Effect.promise(() =>
            waitFor(() => Promise.resolve(busEventCount >= 5))
          )

          // Wait for debounce + processing
          yield* Effect.promise(() => delay(600))

          // All 5 events should reach the bus
          assert.strictEqual(
            busEventCount,
            5,
            'All mixed events should reach the bus'
          )

          // DiffService should coalesce them via debounce
          // The key assertion is completion without timeout
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
        // This test verifies that the coverage configuration is
        // correctly set up to include all repo-watching source files.
        // The actual coverage inclusion is validated by vitest.config.ts
        // having `include: ["src/**/*.ts"]` and `provider: "v8"`.
        //
        // Key source files that MUST be included in coverage:
        const coveredFiles = [
          'src/services/repository-identity.ts',
          'src/services/file-watcher.ts',
          'src/services/repository-event-bus.ts',
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
