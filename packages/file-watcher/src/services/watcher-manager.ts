/**
 * WatcherManager — Effect Service
 *
 * Manages the lifecycle of filesystem watch subscriptions. Each
 * subscription wraps a FileWatcher instance and normalizes its raw
 * events into the stable add/change/delete model before publishing
 * them through a PubSub for RPC streaming.
 *
 * Responsibilities:
 * - Create/destroy watch subscriptions with unique IDs
 * - Normalize raw watcher events (fs.watch rename/change → add/change/delete)
 * - Apply ignore-prefix filtering before publishing
 * - Expose a PubSub for the RPC streaming endpoint
 * - Track active subscriptions for listing
 *
 */

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { Context, Effect, Layer, PubSub, Ref } from 'effect'
import {
  FileWatcher,
  type WatchEvent,
  type WatchSubscription,
} from './file-watcher.js'

// ── Ignore Rules ────────────────────────────────────────────────

/**
 * Default directory and file patterns to ignore. These suppress
 * events from noisy directories that would flood downstream services
 * with irrelevant refresh work.
 */
const DEFAULT_IGNORED_PREFIXES: readonly string[] = [
  // Git internals
  '.git',
  // Dependencies
  'node_modules',
  // Build output
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  // Package manager caches
  '.yarn',
  '.pnpm-store',
  // IDE / editor
  '.idea',
  '.vscode',
  // OS metadata
  '.DS_Store',
  'Thumbs.db',
  // Coverage / test artifacts
  'coverage',
  '.nyc_output',
  // Laborer's own per-worktree dev state (sqlite, pty-host socket, logs)
  '.laborer-state',
]

/**
 * Prefixes that must only be ignored at the root of the watched path.
 *
 * `.git` is watched directly by the git-dir subscriptions (their watch path
 * is `<repo>/.git` itself), so a nested glob for `.git` would silence them.
 */
const ROOT_ONLY_IGNORED_PREFIXES: ReadonlySet<string> = new Set(['.git'])

/**
 * Determine whether a relative path should be ignored: any path segment
 * matching an ignored name silences the event, so nested monorepo
 * `packages/x/node_modules` and `apps/y/dist` are ignored like root ones.
 */
const shouldIgnore = (
  relativePath: string,
  ignoredPrefixes: readonly string[]
): boolean => {
  if (relativePath === '') {
    return true
  }
  const segments = relativePath.split('/')
  return ignoredPrefixes.some((prefix) => {
    if (segments[0] === prefix || relativePath === prefix) {
      return true
    }
    if (ROOT_ONLY_IGNORED_PREFIXES.has(prefix)) {
      return false
    }
    return segments.includes(prefix)
  })
}

/**
 * Ignore entries handed to `@parcel/watcher` so noisy trees are dropped in
 * the native watcher instead of being delivered, decoded, and published on
 * the daemon's main thread. Plain names are resolved against the watch path
 * (root-level); nested-occurrence globs cover monorepo subpackages.
 */
const toNativeIgnoreEntries = (
  prefixes: readonly string[],
  callerGlobs: readonly string[]
): string[] => {
  const entries = new Set<string>(callerGlobs)
  for (const prefix of prefixes) {
    entries.add(prefix)
    if (!ROOT_ONLY_IGNORED_PREFIXES.has(prefix)) {
      entries.add(`**/${prefix}/**`)
    }
  }
  return [...entries]
}

/**
 * Convert first-segment ignore prefixes into glob patterns suitable
 * for passing to `@parcel/watcher`'s `ignore` option.
 */
const toWatcherIgnoreGlobs = (prefixes: readonly string[]): string[] =>
  prefixes.map((prefix) => `${prefix}/**`)

/**
 * Merge the default ignore prefixes with additional prefixes,
 * deduplicating entries.
 */
const mergeIgnorePrefixes = (
  additional: readonly string[]
): readonly string[] => {
  if (additional.length === 0) {
    return DEFAULT_IGNORED_PREFIXES
  }
  const combined = new Set([...DEFAULT_IGNORED_PREFIXES, ...additional])
  return [...combined]
}

/**
 * Extract ignore prefixes from glob patterns. Reverse of
 * toWatcherIgnoreGlobs — strips trailing `/**` suffix.
 */
const fromWatcherIgnoreGlobs = (globs: readonly string[]): string[] =>
  globs.map((glob) => (glob.endsWith('/**') ? glob.slice(0, -3) : glob))

// ── Event Resolution ────────────────────────────────────────────

/**
 * Map a raw WatchEvent to a normalized event type.
 *
 * When the native watcher provides nativeKind (create/update/delete),
 * the mapping is direct. Otherwise, falls back to existsSync inference.
 */
const resolveEventType = (
  event: WatchEvent,
  watchPath: string
): 'add' | 'change' | 'delete' => {
  if (event.nativeKind !== undefined) {
    switch (event.nativeKind) {
      case 'create':
        return 'add'
      case 'update':
        return 'change'
      case 'delete':
        return 'delete'
      default:
        break
    }
  }

  if (event.type === 'rename') {
    const absolutePath = join(watchPath, event.fileName ?? '')
    return existsSync(absolutePath) ? 'add' : 'delete'
  }
  return 'change'
}

// ── Per-subscription state ──────────────────────────────────────

interface ManagedSubscription {
  readonly id: string
  ignoreGlobs: readonly string[]
  ignorePrefixes: readonly string[]
  readonly path: string
  readonly recursive: boolean
  watchSubscription: WatchSubscription | null
}

interface WatcherManagerService {
  /**
   * PubSub for streaming file events to RPC clients.
   */
  readonly fileEvents: PubSub.PubSub<WatchFileEvent>

  /**
   * List all active subscriptions.
   */
  readonly list: () => Effect.Effect<
    ReadonlyArray<{
      readonly id: string
      readonly ignoreGlobs: readonly string[]
      readonly path: string
      readonly recursive: boolean
    }>
  >
  /**
   * Start watching a directory. Returns the subscription info.
   */
  readonly subscribe: (
    path: string,
    recursive?: boolean,
    ignoreGlobs?: readonly string[]
  ) => Effect.Effect<{
    readonly id: string
    readonly ignoreGlobs: readonly string[]
    readonly path: string
    readonly recursive: boolean
  }>

  /**
   * Stop watching by subscription ID.
   */
  readonly unsubscribe: (id: string) => Effect.Effect<void>

  /**
   * Update ignore patterns for an active subscription.
   * Tears down and re-creates the underlying watcher.
   */
  readonly updateIgnore: (
    id: string,
    ignoreGlobs: readonly string[]
  ) => Effect.Effect<void>
}

class WatcherManager extends Context.Service<
  WatcherManager,
  WatcherManagerService
>()('@laborer/WatcherManager') {
  static readonly layer = Layer.effect(
    WatcherManager,
    Effect.gen(function* () {
      const fileWatcher = yield* FileWatcher
      const subscriptionsRef = yield* Ref.make(
        new Map<string, ManagedSubscription>()
      )
      const fileEvents = yield* PubSub.unbounded<WatchFileEvent>()

      let nextId = 0
      const generateId = (): string => {
        nextId += 1
        return `sub_${nextId}`
      }

      const context = yield* Effect.context<never>()
      const runSync = Effect.runSyncWith(context)

      const createWatchSubscription = (
        managed: ManagedSubscription
      ): Effect.Effect<WatchSubscription | null> =>
        fileWatcher
          .subscribe(
            managed.path,
            (event) => {
              const eventType = resolveEventType(event, managed.path)
              const fileName = event.fileName

              // Compute relative path for ignore checking
              const relPath =
                fileName !== null
                  ? relative(managed.path, `${managed.path}/${fileName}`)
                  : null

              // Apply ignore rules
              if (
                relPath !== null &&
                shouldIgnore(relPath, managed.ignorePrefixes)
              ) {
                return
              }

              const fileEvent: WatchFileEvent = {
                subscriptionId: managed.id,
                type: eventType,
                fileName,
                absolutePath:
                  fileName !== null
                    ? `${managed.path}/${fileName}`
                    : managed.path,
              }

              // Publish via runtime — synchronous publish into unbounded PubSub
              runSync(PubSub.publish(fileEvents, fileEvent))
            },
            (error) => {
              runSync(
                Effect.logWarning(
                  `Watcher error for subscription ${managed.id} at ${managed.path}: ${error.message}`
                )
              )
            },
            {
              recursive: managed.recursive,
              ignore: toNativeIgnoreEntries(
                managed.ignorePrefixes,
                managed.ignoreGlobs
              ),
            }
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Failed to create watcher for ${managed.path}: ${error.message}`
              ).pipe(Effect.as(null))
            )
          )

      const subscribe = Effect.fn('WatcherManager.subscribe')(function* (
        path: string,
        recursive?: boolean,
        ignoreGlobs?: readonly string[]
      ) {
        const id = generateId()
        const globs = ignoreGlobs ?? []
        const prefixes = mergeIgnorePrefixes(fromWatcherIgnoreGlobs(globs))

        const managed: ManagedSubscription = {
          id,
          path,
          recursive: recursive ?? true,
          ignoreGlobs: globs,
          ignorePrefixes: prefixes,
          watchSubscription: null,
        }

        const watchSub = yield* createWatchSubscription(managed)
        managed.watchSubscription = watchSub

        yield* Ref.update(subscriptionsRef, (subs) => {
          const next = new Map(subs)
          next.set(id, managed)
          return next
        })

        return {
          id,
          path,
          recursive: managed.recursive,
          ignoreGlobs: [...globs],
        }
      })

      const unsubscribe = Effect.fn('WatcherManager.unsubscribe')(function* (
        id: string
      ) {
        yield* Ref.update(subscriptionsRef, (subs) => {
          const next = new Map(subs)
          const existing = next.get(id)
          if (existing !== undefined) {
            if (existing.watchSubscription !== null) {
              existing.watchSubscription.close()
            }
            next.delete(id)
          }
          return next
        })
      })

      const updateIgnore = Effect.fn('WatcherManager.updateIgnore')(function* (
        id: string,
        ignoreGlobs: readonly string[]
      ) {
        const subs = yield* Ref.get(subscriptionsRef)
        const existing = subs.get(id)
        if (existing === undefined) {
          return
        }

        // Close existing watcher
        if (existing.watchSubscription !== null) {
          existing.watchSubscription.close()
        }

        // Update ignore patterns
        existing.ignoreGlobs = ignoreGlobs
        existing.ignorePrefixes = mergeIgnorePrefixes(
          fromWatcherIgnoreGlobs(ignoreGlobs)
        )

        // Re-create watcher with new patterns
        const watchSub = yield* createWatchSubscription(existing)
        existing.watchSubscription = watchSub

        yield* Ref.update(subscriptionsRef, (s) => {
          const next = new Map(s)
          next.set(id, existing)
          return next
        })
      })

      const list = Effect.fn('WatcherManager.list')(function* () {
        const subs = yield* Ref.get(subscriptionsRef)
        return [...subs.values()].map((sub) => ({
          id: sub.id,
          path: sub.path,
          recursive: sub.recursive,
          ignoreGlobs: [...sub.ignoreGlobs],
        }))
      })

      // Cleanup all subscriptions on shutdown
      yield* Effect.addFinalizer(() =>
        Ref.get(subscriptionsRef).pipe(
          Effect.flatMap((subs) =>
            Effect.sync(() => {
              for (const sub of subs.values()) {
                if (sub.watchSubscription !== null) {
                  sub.watchSubscription.close()
                }
              }
            })
          )
        )
      )

      return WatcherManager.of({
        subscribe,
        unsubscribe,
        updateIgnore,
        list,
        fileEvents,
      })
    })
  )
}

export {
  DEFAULT_IGNORED_PREFIXES,
  fromWatcherIgnoreGlobs,
  mergeIgnorePrefixes,
  shouldIgnore,
  toNativeIgnoreEntries,
  toWatcherIgnoreGlobs,
  WatcherManager,
}
