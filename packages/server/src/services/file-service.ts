/**
 * FileService — Lazy, on-demand file operations
 *
 * Provides stateless request/response operations for file listing,
 * reading, and status. Replaces the streaming FileTreeService and
 * polling-based DiffService with lazy, per-request operations.
 *
 * Currently implements:
 * - `list(workspaceId, dir?)` — single directory level listing
 * - `watcherSubscribe(workspaceId)` — per-workspace file watcher event stream
 *
 * Future additions (Issues 3, 4):
 * - `read(workspaceId, filePath)` — file content + per-file diff
 * - `status(workspaceId)` — workspace-level changed file summary
 *
 * @see PRD: Lazy File Service
 * @see Issue 1: file.list — Lazy per-directory listing (tracer bullet)
 * @see Issue 5: file.watcher.subscribe — Per-workspace watcher event stream
 */

import { readdir } from 'node:fs/promises'
import { join, normalize, relative, resolve } from 'node:path'
import type {
  FileNode,
  FileWatcherEvent,
  WatchFileEvent,
} from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Order,
  pipe,
  Stream,
} from 'effect'
import { FileWatcherClient } from './file-watcher-client.js'
import { LaborerStore } from './laborer-store.js'

// ── Directory ignore rules ──────────────────────────────────────
// Directories that are skipped entirely during listing. These are
// the same noisy directories the file watcher ignores.

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.yarn',
  '.pnpm-store',
  '.idea',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.cache',
  '.history',
  '.gradle',
  'target',
  'bin',
  'obj',
])

/** Individual file names to skip (OS metadata files that are noise). */
const IGNORED_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db'])

/**
 * Sort order for FileNode: directories first, then alphabetical by name.
 */
const fileNodeOrder: Order.Order<FileNode> = Order.make((a, b) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1
  }
  const cmp = a.name.localeCompare(b.name)
  if (cmp < 0) {
    return -1
  }
  if (cmp > 0) {
    return 1
  }
  return 0
})

/**
 * Look up a workspace by ID and validate it is usable.
 * Returns the workspace record or fails with an RpcError.
 */
const lookupWorkspace = (
  store: LaborerStore['Type']['store'],
  workspaceId: string
) =>
  Effect.gen(function* () {
    const workspaceOpt = pipe(
      store.query(tables.workspaces),
      Arr.findFirst((w) => w.id === workspaceId)
    )

    if (workspaceOpt._tag === 'None') {
      return yield* new RpcError({
        message: `Workspace not found: ${workspaceId}`,
        code: 'NOT_FOUND',
      })
    }

    const workspace = workspaceOpt.value

    if (workspace.status === 'destroyed') {
      return yield* new RpcError({
        message: `Workspace ${workspaceId} has been destroyed`,
        code: 'INVALID_STATE',
      })
    }

    return workspace
  })

/**
 * Validate that a resolved path does not escape the worktree root.
 */
const validatePathContainment = (
  targetDir: string,
  worktreeRoot: string,
  dir: string | undefined
) =>
  Effect.gen(function* () {
    const normalizedTarget = normalize(targetDir)
    const normalizedRoot = normalize(worktreeRoot)
    if (
      !normalizedTarget.startsWith(`${normalizedRoot}/`) &&
      normalizedTarget !== normalizedRoot
    ) {
      return yield* new RpcError({
        message: `Path escapes worktree root: ${dir}`,
        code: 'PATH_TRAVERSAL',
      })
    }
  })

/**
 * Read directory entries and build FileNode array, filtering ignored entries.
 */
const readAndBuildNodes = (targetDir: string, worktreeRoot: string) =>
  Effect.gen(function* () {
    const rawEntries = yield* Effect.tryPromise({
      try: () => readdir(targetDir, { withFileTypes: true }),
      catch: (error) =>
        new RpcError({
          message: `Failed to read directory: ${String(error)}`,
          code: 'READDIR_FAILED',
        }),
    })

    const nodes: FileNode[] = []

    for (const entry of rawEntries) {
      const name = String(entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(name)) {
          continue
        }
        const absolute = join(targetDir, name)
        nodes.push({
          name,
          path: relative(worktreeRoot, absolute),
          absolute,
          type: 'directory',
          ignored: false, // Issue 2 adds gitignore marking
        })
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (IGNORED_FILES.has(name)) {
          continue
        }
        const absolute = join(targetDir, name)
        nodes.push({
          name,
          path: relative(worktreeRoot, absolute),
          absolute,
          type: 'file',
          ignored: false, // Issue 2 adds gitignore marking
        })
      }
    }

    return pipe(nodes, Arr.sort(fileNodeOrder))
  })

// ── Event type mapping ──────────────────────────────────────────
// Maps internal watcher event types to client-facing types.
// The file-watcher sidecar uses "delete" but the client API uses "unlink".

const mapEventType = (
  type: 'add' | 'change' | 'delete'
): FileWatcherEvent['event'] => {
  if (type === 'delete') {
    return 'unlink'
  }
  return type
}

class FileService extends Context.Tag('@laborer/FileService')<
  FileService,
  {
    /**
     * List a single directory level from a workspace's worktree.
     *
     * Returns `FileNode[]` sorted directories-first, then alphabetically.
     * Noisy directories and OS metadata files are skipped. When `dir` is
     * omitted, lists the worktree root.
     *
     * @param workspaceId - ID of the workspace
     * @param dir - Optional subdirectory relative to the worktree root
     */
    readonly list: (
      workspaceId: string,
      dir?: string
    ) => Effect.Effect<readonly FileNode[], RpcError>

    /**
     * Subscribe to file change events for a workspace's worktree.
     *
     * Returns a `Stream` of `FileWatcherEvent` objects with file paths
     * relative to the worktree root. Events are forwarded from the
     * file-watcher sidecar, filtered to this workspace's subscription.
     *
     * On stream teardown (client disconnect), the file watcher
     * subscription is automatically cleaned up.
     *
     * @param workspaceId - ID of the workspace
     */
    readonly watcherSubscribe: (
      workspaceId: string
    ) => Stream.Stream<FileWatcherEvent, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    FileService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const fileWatcherClient = yield* FileWatcherClient

      const list = (
        workspaceId: string,
        dir?: string
      ): Effect.Effect<readonly FileNode[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(store, workspaceId)
          const worktreeRoot = workspace.worktreePath

          const targetDir =
            dir !== undefined ? resolve(worktreeRoot, dir) : worktreeRoot

          yield* validatePathContainment(targetDir, worktreeRoot, dir)

          return yield* readAndBuildNodes(targetDir, worktreeRoot)
        })

      const watcherSubscribe = (
        workspaceId: string
      ): Stream.Stream<FileWatcherEvent, RpcError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const workspace = yield* lookupWorkspace(store, workspaceId)
            const worktreePath = workspace.worktreePath

            // Subscribe a recursive file watcher on the worktree
            const watchSubscription = yield* fileWatcherClient
              .subscribe(worktreePath, { recursive: true })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RpcError({
                      message: `Failed to subscribe file watcher: ${String(error.message)}`,
                      code: 'WATCHER_SUBSCRIBE_FAILED',
                    })
                )
              )

            yield* Effect.logDebug(
              '[FileService.watcherSubscribe] watcher subscribed, creating stream'
            )
            // Build a push-based stream that forwards filtered watcher
            // events. Uses acquireRelease so the event handler and watcher
            // subscription are properly cleaned up on stream teardown.
            return Stream.asyncPush<FileWatcherEvent, RpcError>((emit) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  // Register event handler filtered to this subscription
                  return fileWatcherClient.onFileEvent(
                    (watchEvent: WatchFileEvent) => {
                      if (watchEvent.subscriptionId !== watchSubscription.id) {
                        return
                      }

                      // Compute relative path from the worktree root
                      const relativePath =
                        watchEvent.fileName ??
                        relative(worktreePath, watchEvent.absolutePath)

                      emit.single({
                        file: relativePath,
                        event: mapEventType(watchEvent.type),
                      })
                    }
                  )
                }),
                (eventSubscription) =>
                  Effect.gen(function* () {
                    eventSubscription.unsubscribe()
                    yield* fileWatcherClient
                      .unsubscribe(watchSubscription.id)
                      .pipe(Effect.catchAll(() => Effect.void))
                  })
              )
            )
          })
        )

      return FileService.of({ list, watcherSubscribe })
    })
  )
}

export { FileService }
