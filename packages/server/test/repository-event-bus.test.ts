/**
 * Unit tests for RepositoryEventBus pure functions and standalone service.
 *
 * These tests verify the event bus's subscribe/publish/normalize behavior
 * and the pure ignore-filtering functions independently of the file-watcher
 * service. Integration tests for the full watcher pipeline are in
 * repository-watch-coordinator tests and diff-service-event-consumer tests.
 */

import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  DEFAULT_IGNORED_PREFIXES,
  mergeIgnorePrefixes,
  RepositoryEventBus,
  type RepositoryFileEvent,
  shouldIgnore,
  toWatcherIgnoreGlobs,
} from '../src/services/repository-event-bus.js'

/**
 * Standalone event bus layer — no watcher coordinator, just the bus
 * for unit-level tests of subscribe/publish/normalize behavior.
 */
const EventBusTestLayer = RepositoryEventBus.layer

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
