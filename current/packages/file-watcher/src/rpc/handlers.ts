/**
 * File Watcher RPC Handlers
 *
 * Implements handler logic for the FileWatcherRpcs group defined in
 * `@laborer/shared/rpc`. Each handler delegates to the WatcherManager
 * Effect service for the actual watcher operations.
 *
 * The handler layer (`FileWatcherRpcsLive`) is wired into the
 * file-watcher service's `main.ts` via `RpcServer.layer(FileWatcherRpcs)`
 * at `POST /rpc`.
 *
 * @see PRD-file-watcher-extraction.md
 */

import { FileWatcherRpcs, type WatchFileEvent } from '@laborer/shared/rpc'
import { Effect, PubSub, Queue, Stream } from 'effect'
import { WatcherManager } from '../services/watcher-manager.js'

/**
 * Bridge watcher events into the RPC stream without imposing a bounded buffer.
 * File events are authoritative invalidation signals, so dropping or sliding
 * them under load would leave consumers with stale filesystem state.
 *
 * Effect 3's `Stream.asyncPush` defaulted to an unbounded queue. Effect 4's
 * `Stream.callback` has the same default when no buffer options are supplied.
 */
const fileEventsStream = (fileEvents: PubSub.PubSub<WatchFileEvent>) =>
  Stream.callback<WatchFileEvent>((queue) =>
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(fileEvents)
      yield* PubSub.take(subscription).pipe(
        Effect.tap((event) =>
          Effect.sync(() => Queue.offerUnsafe(queue, event))
        ),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true })
      )
    })
  )

export const FileWatcherRpcsLive = FileWatcherRpcs.toLayer(
  Effect.gen(function* () {
    const wm = yield* WatcherManager

    return {
      // -------------------------------------------------------------------
      // watcher.subscribe — start watching a directory
      // -------------------------------------------------------------------
      'watcher.subscribe': ({ path, recursive, ignoreGlobs }) =>
        wm.subscribe(path, recursive, ignoreGlobs).pipe(
          Effect.map((sub) => ({
            id: sub.id,
            path: sub.path,
            recursive: sub.recursive,
            ignoreGlobs: [...sub.ignoreGlobs],
          }))
        ),

      // -------------------------------------------------------------------
      // watcher.unsubscribe — stop watching by subscription ID
      // -------------------------------------------------------------------
      'watcher.unsubscribe': ({ id }) => wm.unsubscribe(id),

      // -------------------------------------------------------------------
      // watcher.updateIgnore — update ignore patterns
      // -------------------------------------------------------------------
      'watcher.updateIgnore': ({ id, ignoreGlobs }) =>
        wm.updateIgnore(id, ignoreGlobs),

      // -------------------------------------------------------------------
      // watcher.list — list all active subscriptions
      // -------------------------------------------------------------------
      'watcher.list': () =>
        wm.list().pipe(
          Effect.map((subs) =>
            subs.map((sub) => ({
              id: sub.id,
              path: sub.path,
              recursive: sub.recursive,
              ignoreGlobs: [...sub.ignoreGlobs],
            }))
          )
        ),

      // -------------------------------------------------------------------
      // watcher.events — streaming file change events
      // -------------------------------------------------------------------
      'watcher.events': () => fileEventsStream(wm.fileEvents),
    }
  })
)

export { fileEventsStream }
