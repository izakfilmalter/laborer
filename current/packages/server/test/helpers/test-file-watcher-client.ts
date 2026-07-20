/**
 * TestFileWatcherClient — Test mock for the FileWatcherClient service.
 *
 * Provides a simple in-process mock that tracks subscribe/unsubscribe
 * calls and allows tests to inject file events programmatically via
 * `emitEvent`. No real RPC connection is made — everything runs
 * in-memory within the test process.
 *
 * Three layers are exported:
 *
 * - `TestFileWatcherClientLayer` — a no-op stub that satisfies the
 *   `FileWatcherClient` dependency. Subscribe always succeeds, events
 *   are silently discarded. Use this when the test doesn't care about
 *   file watching behavior.
 *
 * - `TestFileWatcherClientRecordingLayer` — a recording mock that
 *   tracks `subscribedPaths`, `unsubscribedIds`, `updatedIgnores`,
 *   and allows tests to fire events via `emitEvent`. Use this when
 *   the test needs to verify watcher interactions or inject events.
 *
 * - `TestFileWatcherClientRealLayer` — a `FileWatcherClient` backed
 *   by the real `FileWatcher` + `WatcherManager` from
 *   `@laborer/file-watcher`, running in-process (no RPC). Provides
 *   real filesystem event delivery for integration tests that need
 *   actual FS watcher events to trigger coordinator reconciliation.
 */

import { FileWatcher } from '@laborer/file-watcher/services/file-watcher'
import { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect'
import {
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherClient,
} from '../../src/services/file-watcher-client.js'

// ── Recording mock types ─────────────────────────────────────────

interface RecordedSubscription {
  readonly id: string
  readonly ignoreGlobs: readonly string[]
  readonly path: string
  readonly recursive: boolean
}

interface RecordedIgnoreUpdate {
  readonly id: string
  readonly ignoreGlobs: readonly string[]
}

/**
 * Recorder tag for accessing the recording mock's internal state
 * from test assertions. Provides refs for subscribe/unsubscribe
 * calls and a function to emit synthetic file events.
 */
class TestFileWatcherClientRecorder extends Context.Tag(
  '@laborer/test/TestFileWatcherClientRecorder'
)<
  TestFileWatcherClientRecorder,
  {
    /** All subscribe calls made to the mock. */
    readonly subscribedPaths: Ref.Ref<readonly RecordedSubscription[]>
    /** All unsubscribe calls (subscription IDs). */
    readonly unsubscribedIds: Ref.Ref<readonly string[]>
    /** All updateIgnore calls. */
    readonly updatedIgnores: Ref.Ref<readonly RecordedIgnoreUpdate[]>
    /**
     * Emit a synthetic file event to all registered handlers.
     * Use this to simulate events from the file-watcher service.
     */
    readonly emitEvent: (event: WatchFileEvent) => void
    /**
     * All currently registered file event handlers.
     * Useful for verifying handler registration/unregistration.
     */
    readonly handlers: FileEventHandler[]
  }
>() {}

// ── No-op stub layer ────────────────────────────────────────────

let stubCounter = 0

/**
 * A minimal no-op stub that satisfies the `FileWatcherClient`
 * dependency. Subscribe always succeeds, events are silently
 * discarded. Use this when the test doesn't need to verify
 * file watcher interactions.
 */
const TestFileWatcherClientLayer = Layer.succeed(
  FileWatcherClient,
  FileWatcherClient.of({
    subscribe: (path, options) =>
      Effect.sync(() => {
        stubCounter += 1
        return {
          id: `stub-${stubCounter}`,
          path,
          recursive: options?.recursive ?? false,
          ignoreGlobs: options?.ignoreGlobs ?? [],
        }
      }),
    unsubscribe: () => Effect.void,
    updateIgnore: () => Effect.void,
    onFileEvent: (): FileEventSubscription => ({
      unsubscribe: () => undefined,
    }),
    listSubscriptions: () => Effect.succeed([]),
  })
)

// ── Recording mock layer ────────────────────────────────────────

const TestFileWatcherClientRecordingLayer = Layer.effect(
  FileWatcherClient,
  Effect.gen(function* () {
    const recorder = yield* TestFileWatcherClientRecorder
    let subCounter = 0

    const subscribe: FileWatcherClient['Type']['subscribe'] = (path, options) =>
      Effect.gen(function* () {
        subCounter += 1
        const sub: RecordedSubscription = {
          id: `test-sub-${subCounter}`,
          path,
          recursive: options?.recursive ?? false,
          ignoreGlobs: options?.ignoreGlobs ?? [],
        }
        yield* Ref.update(recorder.subscribedPaths, (subs) => [...subs, sub])
        return sub
      })

    const unsubscribe: FileWatcherClient['Type']['unsubscribe'] = (id) =>
      Ref.update(recorder.unsubscribedIds, (ids) => [...ids, id]).pipe(
        Effect.asVoid
      )

    const updateIgnore: FileWatcherClient['Type']['updateIgnore'] = (
      id,
      ignoreGlobs
    ) =>
      Ref.update(recorder.updatedIgnores, (updates) => [
        ...updates,
        { id, ignoreGlobs },
      ]).pipe(Effect.asVoid)

    const onFileEvent = (handler: FileEventHandler): FileEventSubscription => {
      recorder.handlers.push(handler)
      return {
        unsubscribe: () => {
          const idx = recorder.handlers.indexOf(handler)
          if (idx !== -1) {
            recorder.handlers.splice(idx, 1)
          }
        },
      }
    }

    const listSubscriptions: FileWatcherClient['Type']['listSubscriptions'] =
      () =>
        Ref.get(recorder.subscribedPaths).pipe(Effect.map((subs) => [...subs]))

    return FileWatcherClient.of({
      subscribe,
      unsubscribe,
      updateIgnore,
      onFileEvent,
      listSubscriptions,
    })
  })
)

const TestFileWatcherClientRecorderLayer = Layer.effect(
  TestFileWatcherClientRecorder,
  Effect.gen(function* () {
    const handlers: FileEventHandler[] = []
    return TestFileWatcherClientRecorder.of({
      subscribedPaths: yield* Ref.make<readonly RecordedSubscription[]>([]),
      unsubscribedIds: yield* Ref.make<readonly string[]>([]),
      updatedIgnores: yield* Ref.make<readonly RecordedIgnoreUpdate[]>([]),
      emitEvent: (event: WatchFileEvent) => {
        for (const handler of [...handlers]) {
          handler(event)
        }
      },
      handlers,
    })
  })
)

/**
 * Combined layer that provides both `FileWatcherClient` (recording mock)
 * and `TestFileWatcherClientRecorder` for test assertions.
 */
const TestFileWatcherClientRecordingWithRecorderLayer =
  TestFileWatcherClientRecordingLayer.pipe(
    Layer.provideMerge(TestFileWatcherClientRecorderLayer)
  )

// ── Real in-process layer ───────────────────────────────────────

/**
 * A `FileWatcherClient` backed by the real `FileWatcher` +
 * `WatcherManager` from `@laborer/file-watcher`, running
 * in-process (no RPC). A background fiber drains the
 * `WatcherManager.fileEvents` PubSub and dispatches events to
 * all registered `onFileEvent` handlers.
 *
 * Use this when integration tests need real filesystem events
 * to trigger coordinator reconciliation / branch refresh.
 */
const TestFileWatcherClientRealLayer = Layer.scoped(
  FileWatcherClient,
  Effect.gen(function* () {
    const watcherManager = yield* WatcherManager

    // In-memory handler list — same pattern as production FileWatcherClient
    const handlers: FileEventHandler[] = []

    // Background fiber: drain PubSub and dispatch to handlers
    yield* PubSub.subscribe(watcherManager.fileEvents).pipe(
      Effect.flatMap((dequeue) =>
        Stream.fromQueue(dequeue).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              for (const handler of [...handlers]) {
                handler(event)
              }
            })
          ),
          Stream.runDrain
        )
      ),
      Effect.forkScoped
    )

    const subscribe: FileWatcherClient['Type']['subscribe'] = (path, options) =>
      watcherManager.subscribe(
        path,
        options?.recursive,
        options?.ignoreGlobs !== undefined
          ? [...options.ignoreGlobs]
          : undefined
      )

    const unsubscribe: FileWatcherClient['Type']['unsubscribe'] = (id) =>
      watcherManager.unsubscribe(id)

    const updateIgnore: FileWatcherClient['Type']['updateIgnore'] = (
      id,
      ignoreGlobs
    ) => watcherManager.updateIgnore(id, ignoreGlobs)

    const onFileEvent = (handler: FileEventHandler): FileEventSubscription => {
      handlers.push(handler)
      return {
        unsubscribe: () => {
          const idx = handlers.indexOf(handler)
          if (idx !== -1) {
            handlers.splice(idx, 1)
          }
        },
      }
    }

    const listSubscriptions: FileWatcherClient['Type']['listSubscriptions'] =
      () => watcherManager.list()

    return FileWatcherClient.of({
      subscribe,
      unsubscribe,
      updateIgnore,
      onFileEvent,
      listSubscriptions,
    })
  })
).pipe(Layer.provide(WatcherManager.layer), Layer.provide(FileWatcher.layer))

export {
  type RecordedIgnoreUpdate,
  type RecordedSubscription,
  TestFileWatcherClientLayer,
  TestFileWatcherClientRealLayer,
  TestFileWatcherClientRecorder,
  TestFileWatcherClientRecordingLayer,
  TestFileWatcherClientRecorderLayer,
  TestFileWatcherClientRecordingWithRecorderLayer,
}
