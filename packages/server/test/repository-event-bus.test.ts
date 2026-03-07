import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import {
  FileWatcher,
  type WatchEvent,
  type WatchSubscription,
} from '../src/services/file-watcher.js'
import {
  DEFAULT_IGNORED_PREFIXES,
  mergeIgnorePrefixes,
  RepositoryEventBus,
  type RepositoryFileEvent,
  shouldIgnore,
  toWatcherIgnoreGlobs,
} from '../src/services/repository-event-bus.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { waitFor } from './helpers/timing-helpers.js'

const tempRoots: string[] = []

/**
 * Standalone event bus layer — no watcher coordinator, just the bus
 * for unit-level tests of subscribe/publish/normalize behavior.
 */
const EventBusTestLayer = RepositoryEventBus.layer

type RecordedWatchersByPath = Map<
  string,
  { readonly onChange: (event: WatchEvent) => void }[]
>

const createDeterministicIntegrationLayer = (
  repoPath: string,
  recordedWatchers: RecordedWatchersByPath
) => {
  const recordingFileWatcher = Layer.succeed(
    FileWatcher,
    FileWatcher.of({
      subscribe: (path, onChange, _onError, _options) =>
        Effect.sync(() => {
          const existing = recordedWatchers.get(path) ?? []
          existing.push({ onChange })
          recordedWatchers.set(path, existing)
          return {
            close: () => undefined,
          } satisfies WatchSubscription
        }),
    })
  )

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
    Layer.provide(recordingFileWatcher),
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

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// ── Unit tests: shouldIgnore ──────────────────────────────────

describe('shouldIgnore', () => {
  it.effect('ignores .git paths', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('.git', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.git/objects/pack', DEFAULT_IGNORED_PREFIXES))
    })
  )

  it.effect('ignores node_modules paths', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('node_modules', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(
        shouldIgnore('node_modules/lodash/index.js', DEFAULT_IGNORED_PREFIXES)
      )
    })
  )

  it.effect('ignores dist, build, and out paths', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('dist', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('build', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('out', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('dist/bundle.js', DEFAULT_IGNORED_PREFIXES))
    })
  )

  it.effect('ignores framework-specific output directories', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('.next', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.nuxt', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.svelte-kit', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.turbo', DEFAULT_IGNORED_PREFIXES))
    })
  )

  it.effect('ignores IDE and OS metadata', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('.idea', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.vscode', DEFAULT_IGNORED_PREFIXES))
      assert.isTrue(shouldIgnore('.DS_Store', DEFAULT_IGNORED_PREFIXES))
    })
  )

  it.effect('does not ignore source files', () =>
    Effect.sync(() => {
      assert.isFalse(shouldIgnore('src/index.ts', DEFAULT_IGNORED_PREFIXES))
      assert.isFalse(
        shouldIgnore('packages/server/main.ts', DEFAULT_IGNORED_PREFIXES)
      )
      assert.isFalse(shouldIgnore('README.md', DEFAULT_IGNORED_PREFIXES))
    })
  )

  it.effect('ignores empty paths', () =>
    Effect.sync(() => {
      assert.isTrue(shouldIgnore('', DEFAULT_IGNORED_PREFIXES))
    })
  )
})

// ── Unit tests: RepositoryEventBus ──────────────────────────

describe('RepositoryEventBus', () => {
  it.effect('subscribers receive published events', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus
      const received: RepositoryFileEvent[] = []

      yield* bus.subscribe((event) => {
        received.push(event)
      })

      const testEvent: RepositoryFileEvent = {
        type: 'add',
        relativePath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
        projectId: 'test-project',
        repoRoot: '/repo',
      }

      yield* bus.publish(testEvent)

      assert.strictEqual(received.length, 1)
      assert.deepStrictEqual(received[0], testEvent)
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('multiple subscribers receive the same event', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus
      const receivedA: RepositoryFileEvent[] = []
      const receivedB: RepositoryFileEvent[] = []

      yield* bus.subscribe((event) => {
        receivedA.push(event)
      })
      yield* bus.subscribe((event) => {
        receivedB.push(event)
      })

      const testEvent: RepositoryFileEvent = {
        type: 'change',
        relativePath: 'lib/utils.ts',
        absolutePath: '/repo/lib/utils.ts',
        projectId: 'test-project',
        repoRoot: '/repo',
      }

      yield* bus.publish(testEvent)

      assert.strictEqual(receivedA.length, 1)
      assert.strictEqual(receivedB.length, 1)
      assert.deepStrictEqual(receivedA[0], testEvent)
      assert.deepStrictEqual(receivedB[0], testEvent)
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('unsubscribe removes the handler', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus
      const received: RepositoryFileEvent[] = []

      const sub = yield* bus.subscribe((event) => {
        received.push(event)
      })

      const event1: RepositoryFileEvent = {
        type: 'add',
        relativePath: 'a.ts',
        absolutePath: '/repo/a.ts',
        projectId: 'test-project',
        repoRoot: '/repo',
      }

      yield* bus.publish(event1)
      assert.strictEqual(received.length, 1)

      sub.unsubscribe()

      const event2: RepositoryFileEvent = {
        type: 'change',
        relativePath: 'b.ts',
        absolutePath: '/repo/b.ts',
        projectId: 'test-project',
        repoRoot: '/repo',
      }

      yield* bus.publish(event2)
      assert.strictEqual(
        received.length,
        1,
        'Should not receive events after unsubscribe'
      )
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('normalizeEvent returns null for null fileName', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      const result = bus.normalizeEvent({
        type: 'change',
        fileName: null,
        repoRoot: '/repo',
        projectId: 'test-project',
      })

      assert.isNull(result)
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('normalizeEvent suppresses ignored paths', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      const gitResult = bus.normalizeEvent({
        type: 'change',
        fileName: '.git/objects/pack/abc123',
        repoRoot: '/repo',
        projectId: 'test-project',
      })
      assert.isNull(gitResult)

      const nodeModulesResult = bus.normalizeEvent({
        type: 'add',
        fileName: 'node_modules/lodash/index.js',
        repoRoot: '/repo',
        projectId: 'test-project',
      })
      assert.isNull(nodeModulesResult)

      const distResult = bus.normalizeEvent({
        type: 'change',
        fileName: 'dist/bundle.js',
        repoRoot: '/repo',
        projectId: 'test-project',
      })
      assert.isNull(distResult)
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('normalizeEvent returns event for source files', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      const result = bus.normalizeEvent({
        type: 'change',
        fileName: 'src/index.ts',
        repoRoot: '/repo',
        projectId: 'test-project',
      })

      assert.isNotNull(result)
      assert.strictEqual(result?.type, 'change')
      assert.strictEqual(result?.relativePath, 'src/index.ts')
      assert.strictEqual(result?.projectId, 'test-project')
      assert.strictEqual(result?.repoRoot, '/repo')
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('publish to zero subscribers completes without throwing', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      // No subscribers registered — publish should be a harmless no-op
      yield* bus.publish({
        type: 'add',
        relativePath: 'orphan.ts',
        absolutePath: '/repo/orphan.ts',
        projectId: 'test-project',
        repoRoot: '/repo',
      })

      // If we reach here the publish did not throw
      assert.isTrue(true)
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect(
    'normalizeEvent constructs absolutePath from repoRoot and fileName',
    () =>
      Effect.gen(function* () {
        const bus = yield* RepositoryEventBus

        const result = bus.normalizeEvent({
          type: 'add',
          fileName: 'packages/server/src/main.ts',
          repoRoot: '/workspace/my-project',
          projectId: 'test-project',
        })

        assert.isNotNull(result)
        assert.strictEqual(
          result?.absolutePath,
          '/workspace/my-project/packages/server/src/main.ts'
        )
        assert.strictEqual(result?.relativePath, 'packages/server/src/main.ts')
      }).pipe(Effect.provide(EventBusTestLayer))
  )
})

// ── Integration tests: watcher → event bus pipeline ─────────

describe('RepositoryEventBus watcher integration', () => {
  it.scoped(
    'file add in watched repo emits normalized event through the event bus',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-add-1', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const addEventTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-eventbus-add', repoPath)

          // Create a new source file in the repo, then deterministically
          // deliver the watcher signal through the coordinator.
          writeFileSync(join(repoPath, 'new-file.ts'), 'export const x = 1;\n')
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: 'new-file.ts' })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'new-file.ts')
              )
            )
          )

          const addEvent = received.find(
            (e) => e.relativePath === 'new-file.ts'
          )
          assert.isDefined(addEvent)
          assert.strictEqual(addEvent?.type, 'add')
          assert.strictEqual(addEvent?.projectId, 'project-eventbus-add')
        }).pipe(Effect.provide(addEventTestLayer))
      })
  )

  it.scoped(
    'file change in watched repo emits event through the event bus',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-change-1', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const changeEventTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-eventbus-change', repoPath)
          writeFileSync(join(repoPath, 'README.md'), '# updated content\n')
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'change',
            fileName: 'README.md',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'README.md')
              )
            )
          )

          const changeEvent = received.find(
            (e) => e.relativePath === 'README.md'
          )
          assert.isDefined(changeEvent)
          assert.strictEqual(changeEvent?.type, 'change')
          assert.strictEqual(changeEvent?.projectId, 'project-eventbus-change')
        }).pipe(Effect.provide(changeEventTestLayer))
      })
  )

  it.scoped(
    'file delete in watched repo emits event through the event bus',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-delete-1', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const deleteEventTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        // Create a file first so we can delete it
        const filePath = join(repoPath, 'to-delete.ts')
        writeFileSync(filePath, 'export const x = 1;\n')

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-eventbus-delete', repoPath)
          unlinkSync(filePath)
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: 'to-delete.ts' })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'to-delete.ts')
              )
            )
          )

          const deleteEvent = received.find(
            (e) => e.relativePath === 'to-delete.ts'
          )
          assert.isDefined(deleteEvent)
          assert.strictEqual(deleteEvent?.type, 'delete')
          assert.strictEqual(deleteEvent?.projectId, 'project-eventbus-delete')
        }).pipe(Effect.provide(deleteEventTestLayer))
      })
  )

  it.scoped('ignored paths do not produce events through the event bus', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('eventbus-ignore-1', tempRoots)
      const recordedWatchers: RecordedWatchersByPath = new Map()
      const ignoredPathsTestLayer = createDeterministicIntegrationLayer(
        repoPath,
        recordedWatchers
      )

      // Create files in ignored directories
      const nodeModulesDir = join(repoPath, 'node_modules')
      mkdirSync(nodeModulesDir, { recursive: true })
      writeFileSync(join(nodeModulesDir, 'lodash.js'), 'module.exports = {};\n')

      const distDir = join(repoPath, 'dist')
      mkdirSync(distDir, { recursive: true })
      writeFileSync(join(distDir, 'bundle.js'), '// bundle\n')

      yield* Effect.gen(function* () {
        const coordinator = yield* RepositoryWatchCoordinator
        const bus = yield* RepositoryEventBus

        const received: RepositoryFileEvent[] = []
        yield* bus.subscribe((event) => {
          received.push(event)
        })

        yield* coordinator.watchProject('project-eventbus-ignore', repoPath)

        // Also create a non-ignored file so we know the watcher is working.
        writeFileSync(
          join(repoPath, 'canary-source.ts'),
          'export const canary = true;\n'
        )
        recordedWatchers.get(repoPath)?.at(-1)?.onChange({
          type: 'rename',
          fileName: 'node_modules/lodash.js',
        })
        recordedWatchers.get(repoPath)?.at(-1)?.onChange({
          type: 'rename',
          fileName: 'dist/bundle.js',
        })
        recordedWatchers.get(repoPath)?.at(-1)?.onChange({
          type: 'rename',
          fileName: 'canary-source.ts',
        })

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              received.some((e) => e.relativePath === 'canary-source.ts')
            )
          )
        )

        const ignoredEvents = received.filter(
          (e) =>
            e.relativePath.startsWith('node_modules') ||
            e.relativePath.startsWith('dist') ||
            e.relativePath.startsWith('.git')
        )

        assert.strictEqual(
          ignoredEvents.length,
          0,
          `Expected no events from ignored paths, but received: ${ignoredEvents.map((e) => e.relativePath).join(', ')}`
        )
      }).pipe(Effect.provide(ignoredPathsTestLayer))
    })
  )

  it.scoped(
    'multiple subscribers receive events without creating duplicate watchers',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-multi-sub-1', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const multiSubscriberTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const receivedA: RepositoryFileEvent[] = []
          const receivedB: RepositoryFileEvent[] = []

          yield* bus.subscribe((event) => {
            receivedA.push(event)
          })
          yield* bus.subscribe((event) => {
            receivedB.push(event)
          })

          yield* coordinator.watchProject('project-eventbus-multi', repoPath)
          writeFileSync(
            join(repoPath, 'multi-sub-test.ts'),
            'export const y = 2;\n'
          )
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'rename',
            fileName: 'multi-sub-test.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                receivedA.some((e) => e.relativePath === 'multi-sub-test.ts') &&
                  receivedB.some((e) => e.relativePath === 'multi-sub-test.ts')
              )
            )
          )

          const eventA = receivedA.find(
            (e) => e.relativePath === 'multi-sub-test.ts'
          )
          const eventB = receivedB.find(
            (e) => e.relativePath === 'multi-sub-test.ts'
          )

          assert.isDefined(eventA)
          assert.isDefined(eventB)
          assert.strictEqual(eventA?.projectId, eventB?.projectId)
        }).pipe(Effect.provide(multiSubscriberTestLayer))
      })
  )
})

// ── Unit tests: configurable ignore helpers ────────────────────

describe('mergeIgnorePrefixes', () => {
  it.effect('returns defaults when no additional prefixes are provided', () =>
    Effect.sync(() => {
      const merged = mergeIgnorePrefixes([])
      assert.deepStrictEqual(merged, DEFAULT_IGNORED_PREFIXES)
    })
  )

  it.effect('appends new prefixes to defaults', () =>
    Effect.sync(() => {
      const merged = mergeIgnorePrefixes(['.cache', 'tmp'])
      assert.isTrue(merged.includes('.cache'))
      assert.isTrue(merged.includes('tmp'))
      // All defaults should still be present
      for (const prefix of DEFAULT_IGNORED_PREFIXES) {
        assert.isTrue(merged.includes(prefix), `Missing default: ${prefix}`)
      }
    })
  )

  it.effect('deduplicates overlapping prefixes', () =>
    Effect.sync(() => {
      const merged = mergeIgnorePrefixes(['node_modules', '.cache'])
      const nodeModulesCount = merged.filter(
        (p: string) => p === 'node_modules'
      ).length
      assert.strictEqual(nodeModulesCount, 1, 'Should not duplicate entries')
      assert.isTrue(merged.includes('.cache'))
    })
  )
})

describe('toWatcherIgnoreGlobs', () => {
  it.effect('converts prefixes to glob patterns', () =>
    Effect.sync(() => {
      const globs = toWatcherIgnoreGlobs(['node_modules', '.git', 'dist'])
      assert.deepStrictEqual(globs, ['node_modules/**', '.git/**', 'dist/**'])
    })
  )

  it.effect('handles empty prefix list', () =>
    Effect.sync(() => {
      const globs = toWatcherIgnoreGlobs([])
      assert.deepStrictEqual(globs, [])
    })
  )
})

// ── Unit tests: configurable ignore via event bus ──────────────

describe('RepositoryEventBus configurable ignores', () => {
  it.effect('exposes default ignore prefixes and globs', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      assert.deepStrictEqual(bus.ignorePrefixes, DEFAULT_IGNORED_PREFIXES)
      assert.strictEqual(
        bus.ignoreGlobs.length,
        DEFAULT_IGNORED_PREFIXES.length
      )
      assert.isTrue(
        bus.ignoreGlobs.every((g) => g.endsWith('/**')),
        'All globs should end with /**'
      )
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect('setAdditionalIgnorePrefixes merges with defaults', () =>
    Effect.gen(function* () {
      const bus = yield* RepositoryEventBus

      bus.setAdditionalIgnorePrefixes(['.cache', 'tmp'])

      assert.isTrue(bus.ignorePrefixes.includes('.cache'))
      assert.isTrue(bus.ignorePrefixes.includes('tmp'))
      // Defaults should still be present
      assert.isTrue(bus.ignorePrefixes.includes('node_modules'))
      assert.isTrue(bus.ignorePrefixes.includes('.git'))
    }).pipe(Effect.provide(EventBusTestLayer))
  )

  it.effect(
    'normalizeEvent suppresses paths matching config-added prefixes',
    () =>
      Effect.gen(function* () {
        const bus = yield* RepositoryEventBus

        // Before adding custom ignore, .cache should not be ignored
        const beforeResult = bus.normalizeEvent({
          type: 'change',
          fileName: '.cache/some-file.json',
          repoRoot: '/repo',
          projectId: 'test-project',
        })
        assert.isNotNull(beforeResult)

        // Add custom ignore
        bus.setAdditionalIgnorePrefixes(['.cache'])

        // After adding, .cache should be ignored
        const afterResult = bus.normalizeEvent({
          type: 'change',
          fileName: '.cache/some-file.json',
          repoRoot: '/repo',
          projectId: 'test-project',
        })
        assert.isNull(afterResult)

        // Source files should still pass through
        const sourceResult = bus.normalizeEvent({
          type: 'change',
          fileName: 'src/app.ts',
          repoRoot: '/repo',
          projectId: 'test-project',
        })
        assert.isNotNull(sourceResult)
      }).pipe(Effect.provide(EventBusTestLayer))
  )
})

// ── Integration test: config-driven ignore through coordinator ──

describe('Config-driven ignore filtering', () => {
  it.scoped(
    'custom watchIgnore patterns from config suppress events through the full pipeline',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-config-ignore', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()

        // Create a laborer.json with custom watchIgnore patterns
        writeFileSync(
          join(repoPath, 'laborer.json'),
          JSON.stringify({ watchIgnore: ['.cache', 'tmp'] })
        )

        const configIgnoreTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject(
            'project-config-ignore',
            repoPath,
            'config-ignore-test'
          )

          // Create files in custom-ignored directories
          mkdirSync(join(repoPath, '.cache'), { recursive: true })
          writeFileSync(join(repoPath, '.cache', 'cached-data.json'), '{ }')
          mkdirSync(join(repoPath, 'tmp'), { recursive: true })
          writeFileSync(join(repoPath, 'tmp', 'temp-output.log'), 'log data')
          writeFileSync(
            join(repoPath, 'real-source.ts'),
            'export const x = 1;\n'
          )

          // Deliver watcher events
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: '.cache/cached-data.json' })
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: 'tmp/temp-output.log' })
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: 'real-source.ts' })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'real-source.ts')
              )
            )
          )

          // Custom-ignored paths should not produce events
          const ignoredEvents = received.filter(
            (e) =>
              e.relativePath.startsWith('.cache') ||
              e.relativePath.startsWith('tmp')
          )
          assert.strictEqual(
            ignoredEvents.length,
            0,
            `Expected no events from config-ignored paths, but received: ${ignoredEvents.map((e) => e.relativePath).join(', ')}`
          )

          // Real source files should still produce events
          const sourceEvent = received.find(
            (e) => e.relativePath === 'real-source.ts'
          )
          assert.isDefined(sourceEvent)
        }).pipe(Effect.provide(configIgnoreTestLayer))
      })
  )

  it.scoped(
    'build output churn from default ignore rules stays suppressed',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-build-churn', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const buildChurnTestLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-build-churn', repoPath)

          // Simulate build output churn in multiple ignored directories
          const churnPaths = [
            'dist/bundle.js',
            'dist/bundle.js.map',
            'build/output.css',
            '.next/cache/webpack.js',
            '.turbo/cache/hash.json',
            'coverage/lcov-report/index.html',
            '.nyc_output/processinfo.json',
          ]

          for (const path of churnPaths) {
            recordedWatchers
              .get(repoPath)
              ?.at(-1)
              ?.onChange({ type: 'change', fileName: path })
          }

          // Send one valid source event as canary
          writeFileSync(
            join(repoPath, 'canary.ts'),
            'export const canary = true;\n'
          )
          recordedWatchers
            .get(repoPath)
            ?.at(-1)
            ?.onChange({ type: 'rename', fileName: 'canary.ts' })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'canary.ts')
              )
            )
          )

          // No build churn events should have reached the bus
          const buildEvents = received.filter(
            (e) => e.relativePath !== 'canary.ts'
          )
          assert.strictEqual(
            buildEvents.length,
            0,
            `Build churn should be filtered: ${buildEvents.map((e) => e.relativePath).join(', ')}`
          )
        }).pipe(Effect.provide(buildChurnTestLayer))
      })
  )
})

// ── Integration tests: backend-native event semantics ──────────

describe('Backend-native repository event semantics', () => {
  it.scoped(
    "native watcher create events map to 'add' without existsSync inference",
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-native-create', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const testLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-native-create', repoPath)

          // Deliver a native create event — the file does NOT need to
          // exist on disk because the native backend classification is
          // authoritative.
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'brand-new-file.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'brand-new-file.ts')
              )
            )
          )

          const addEvent = received.find(
            (e) => e.relativePath === 'brand-new-file.ts'
          )
          assert.isDefined(addEvent)
          assert.strictEqual(addEvent?.type, 'add')
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped("native watcher update events map to 'change'", () =>
    Effect.gen(function* () {
      const repoPath = initRepo('eventbus-native-update', tempRoots)
      const recordedWatchers: RecordedWatchersByPath = new Map()
      const testLayer = createDeterministicIntegrationLayer(
        repoPath,
        recordedWatchers
      )

      yield* Effect.gen(function* () {
        const coordinator = yield* RepositoryWatchCoordinator
        const bus = yield* RepositoryEventBus

        const received: RepositoryFileEvent[] = []
        yield* bus.subscribe((event) => {
          received.push(event)
        })

        yield* coordinator.watchProject('project-native-update', repoPath)

        recordedWatchers.get(repoPath)?.at(-1)?.onChange({
          type: 'change',
          nativeKind: 'update',
          fileName: 'README.md',
        })

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              received.some((e) => e.relativePath === 'README.md')
            )
          )
        )

        const changeEvent = received.find((e) => e.relativePath === 'README.md')
        assert.isDefined(changeEvent)
        assert.strictEqual(changeEvent?.type, 'change')
      }).pipe(Effect.provide(testLayer))
    })
  )

  it.scoped(
    "native watcher delete events map to 'delete' without existsSync inference",
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-native-delete', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const testLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-native-delete', repoPath)

          // Deliver a native delete event — the file still exists on
          // disk but the native backend says it was deleted. With the
          // old existsSync inference this would have been classified
          // as "add" because the file exists. The native kind should
          // take precedence.
          writeFileSync(
            join(repoPath, 'still-on-disk.ts'),
            'export const x = 1;\n'
          )
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'rename',
            nativeKind: 'delete',
            fileName: 'still-on-disk.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'still-on-disk.ts')
              )
            )
          )

          const deleteEvent = received.find(
            (e) => e.relativePath === 'still-on-disk.ts'
          )
          assert.isDefined(deleteEvent)
          assert.strictEqual(
            deleteEvent?.type,
            'delete',
            "Native delete should take precedence over existsSync which would say 'add'"
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'fallback watcher still infers add/delete from existsSync when nativeKind is absent',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-fallback-infer', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const testLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-fallback-infer', repoPath)

          // Simulate fs.watch fallback: rename event without nativeKind,
          // file exists → should infer "add"
          writeFileSync(
            join(repoPath, 'fallback-add.ts'),
            'export const fb = 1;\n'
          )
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'rename',
            fileName: 'fallback-add.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'fallback-add.ts')
              )
            )
          )

          const addEvent = received.find(
            (e) => e.relativePath === 'fallback-add.ts'
          )
          assert.isDefined(addEvent)
          assert.strictEqual(addEvent?.type, 'add')

          // Simulate fs.watch fallback: rename event without nativeKind,
          // file does NOT exist → should infer "delete"
          recordedWatchers.get(repoPath)?.at(-1)?.onChange({
            type: 'rename',
            fileName: 'nonexistent-file.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'nonexistent-file.ts')
              )
            )
          )

          const deleteEvent = received.find(
            (e) => e.relativePath === 'nonexistent-file.ts'
          )
          assert.isDefined(deleteEvent)
          assert.strictEqual(deleteEvent?.type, 'delete')
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'rename-heavy churn with native backend classifies events accurately',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-rename-churn', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const testLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-rename-churn', repoPath)

          const watcher = recordedWatchers.get(repoPath)?.at(-1)

          // Simulate a rapid rename: old file deleted, new file created.
          // With native kinds, both events should be classified
          // correctly regardless of disk state.
          watcher?.onChange({
            type: 'rename',
            nativeKind: 'delete',
            fileName: 'old-name.ts',
          })
          watcher?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'new-name.ts',
          })

          // Simulate a rapid sequence of creates and deletes
          // (e.g. branch switch causing many file changes)
          for (let i = 0; i < 5; i++) {
            watcher?.onChange({
              type: 'rename',
              nativeKind: 'delete',
              fileName: `feature-${i}.ts`,
            })
          }
          for (let i = 0; i < 5; i++) {
            watcher?.onChange({
              type: 'rename',
              nativeKind: 'create',
              fileName: `refactor-${i}.ts`,
            })
          }

          // Add a final update as a sync point
          watcher?.onChange({
            type: 'change',
            nativeKind: 'update',
            fileName: 'package.json',
          })

          yield* Effect.promise(() =>
            waitFor(() =>
              Promise.resolve(
                received.some((e) => e.relativePath === 'package.json')
              )
            )
          )

          // Verify rename events were correctly classified
          const oldNameEvent = received.find(
            (e) => e.relativePath === 'old-name.ts'
          )
          assert.isDefined(oldNameEvent)
          assert.strictEqual(oldNameEvent?.type, 'delete')

          const newNameEvent = received.find(
            (e) => e.relativePath === 'new-name.ts'
          )
          assert.isDefined(newNameEvent)
          assert.strictEqual(newNameEvent?.type, 'add')

          // Verify batch deletes
          for (let i = 0; i < 5; i++) {
            const deleteEvent = received.find(
              (e) => e.relativePath === `feature-${i}.ts`
            )
            assert.isDefined(
              deleteEvent,
              `Missing delete event for feature-${i}.ts`
            )
            assert.strictEqual(deleteEvent?.type, 'delete')
          }

          // Verify batch creates
          for (let i = 0; i < 5; i++) {
            const createEvent = received.find(
              (e) => e.relativePath === `refactor-${i}.ts`
            )
            assert.isDefined(
              createEvent,
              `Missing create event for refactor-${i}.ts`
            )
            assert.strictEqual(createEvent?.type, 'add')
          }

          // Verify update
          const updateEvent = received.find(
            (e) => e.relativePath === 'package.json'
          )
          assert.isDefined(updateEvent)
          assert.strictEqual(updateEvent?.type, 'change')
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'event fanout remains backend-agnostic for downstream subscribers',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('eventbus-agnostic-fanout', tempRoots)
        const recordedWatchers: RecordedWatchersByPath = new Map()
        const testLayer = createDeterministicIntegrationLayer(
          repoPath,
          recordedWatchers
        )

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          const bus = yield* RepositoryEventBus

          const received: RepositoryFileEvent[] = []
          yield* bus.subscribe((event) => {
            received.push(event)
          })

          yield* coordinator.watchProject('project-agnostic-fanout', repoPath)

          const watcher = recordedWatchers.get(repoPath)?.at(-1)

          // Mix of native and fallback-style events should all
          // produce the same normalized RepositoryFileEvent shape
          watcher?.onChange({
            type: 'rename',
            nativeKind: 'create',
            fileName: 'native-add.ts',
          })
          watcher?.onChange({
            type: 'change',
            nativeKind: 'update',
            fileName: 'native-change.ts',
          })
          writeFileSync(
            join(repoPath, 'fallback-add.ts'),
            'export const x = 1;\n'
          )
          watcher?.onChange({
            type: 'rename',
            fileName: 'fallback-add.ts',
          })
          watcher?.onChange({
            type: 'change',
            fileName: 'fallback-change.ts',
          })

          yield* Effect.promise(() =>
            waitFor(() => Promise.resolve(received.length >= 4))
          )

          // All events should conform to the same RepositoryFileEvent shape
          for (const event of received) {
            assert.isString(event.absolutePath)
            assert.isString(event.relativePath)
            assert.isString(event.projectId)
            assert.isString(event.repoRoot)
            assert.oneOf(event.type, ['add', 'change', 'delete'])
            // Verify no backend-specific fields leaked through
            assert.notProperty(
              event,
              'nativeKind',
              'Backend-specific nativeKind should not leak to downstream events'
            )
          }
        }).pipe(Effect.provide(testLayer))
      })
  )
})
