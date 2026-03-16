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

import { FileWatcherRpcs } from '@laborer/shared/rpc'
import { Effect, Stream } from 'effect'
import { WatcherManager } from '../services/watcher-manager.js'

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
      'watcher.events': () => Stream.fromPubSub(wm.fileEvents),
    }
  })
)
