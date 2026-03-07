import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  DEFAULT_FILE_WATCHER_BACKEND,
  FileWatcherError,
  makeFileWatcher,
  resolveFileWatcherBackendPreference,
  type WatchSubscription,
} from '../src/services/file-watcher.js'

describe('FileWatcher', () => {
  it.effect('prefers the native backend by default', () =>
    Effect.sync(() => {
      const original = process.env.LABORER_FILE_WATCHER_BACKEND
      Reflect.deleteProperty(process.env, 'LABORER_FILE_WATCHER_BACKEND')

      try {
        assert.strictEqual(
          resolveFileWatcherBackendPreference(),
          DEFAULT_FILE_WATCHER_BACKEND
        )
      } finally {
        if (original === undefined) {
          Reflect.deleteProperty(process.env, 'LABORER_FILE_WATCHER_BACKEND')
        } else {
          process.env.LABORER_FILE_WATCHER_BACKEND = original
        }
      }
    })
  )

  it.effect('uses the native backend subscription when available', () =>
    Effect.gen(function* () {
      const calls = { fs: 0, native: 0 }
      let closed = false
      const watcher = makeFileWatcher('native', {
        fs: () =>
          Effect.sync(() => {
            calls.fs += 1
            return { close: () => undefined } satisfies WatchSubscription
          }),
        native: () =>
          Effect.sync(() => {
            calls.native += 1
            return {
              close: () => {
                closed = true
              },
            } satisfies WatchSubscription
          }),
      })

      const subscription = yield* watcher.subscribe(
        '/repo',
        () => undefined,
        () => undefined,
        undefined
      )

      assert.isNotNull(subscription)
      subscription.close()

      assert.deepStrictEqual(calls, { fs: 0, native: 1 })
      assert.isTrue(closed)
    })
  )

  it.effect('falls back to fs when the native backend fails', () =>
    Effect.gen(function* () {
      const calls = { fs: 0, native: 0 }
      const watcher = makeFileWatcher('native', {
        fs: () =>
          Effect.sync(() => {
            calls.fs += 1
            return { close: () => undefined } satisfies WatchSubscription
          }),
        native: () =>
          Effect.sync(() => {
            calls.native += 1
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new FileWatcherError({
                  message: 'native backend unavailable',
                })
              )
            )
          ),
      })

      const subscription = yield* watcher.subscribe(
        '/repo',
        () => undefined,
        () => undefined,
        undefined
      )

      assert.isNotNull(subscription)
      assert.deepStrictEqual(calls, { fs: 1, native: 1 })
    })
  )

  it.effect('allows explicitly selecting the fs fallback backend', () =>
    Effect.gen(function* () {
      const calls = { fs: 0, native: 0 }
      const watcher = makeFileWatcher('fs', {
        fs: () =>
          Effect.sync(() => {
            calls.fs += 1
            return { close: () => undefined } satisfies WatchSubscription
          }),
        native: () =>
          Effect.sync(() => {
            calls.native += 1
            return { close: () => undefined } satisfies WatchSubscription
          }),
      })

      const subscription = yield* watcher.subscribe(
        '/repo',
        () => undefined,
        () => undefined,
        undefined
      )

      assert.isNotNull(subscription)
      assert.deepStrictEqual(calls, { fs: 1, native: 0 })
    })
  )

  it.effect(
    'fs backend handles ignore option gracefully without crashing',
    () =>
      Effect.gen(function* () {
        let receivedOptions: { ignore?: readonly string[] } | undefined
        const watcher = makeFileWatcher('fs', {
          fs: (_path, _onChange, _onError, options) =>
            Effect.sync(() => {
              receivedOptions = options
              return { close: () => undefined } satisfies WatchSubscription
            }),
          native: () =>
            Effect.fail(
              new FileWatcherError({ message: 'should not be called' })
            ),
        })

        const subscription = yield* watcher.subscribe(
          '/repo',
          () => undefined,
          () => undefined,
          { recursive: true, ignore: ['node_modules/**', '.git/**', 'dist/**'] }
        )

        assert.isNotNull(subscription)
        // The fs driver receives the options but silently ignores the
        // `ignore` field — filtering happens downstream. The key assertion
        // is that it does not crash.
        assert.isDefined(receivedOptions)
      })
  )

  it.effect(
    'resolves fs backend when LABORER_FILE_WATCHER_BACKEND env var is set to fs',
    () =>
      Effect.sync(() => {
        const original = process.env.LABORER_FILE_WATCHER_BACKEND
        process.env.LABORER_FILE_WATCHER_BACKEND = 'fs'

        try {
          assert.strictEqual(resolveFileWatcherBackendPreference(), 'fs')
        } finally {
          if (original === undefined) {
            Reflect.deleteProperty(process.env, 'LABORER_FILE_WATCHER_BACKEND')
          } else {
            process.env.LABORER_FILE_WATCHER_BACKEND = original
          }
        }
      })
  )
})
