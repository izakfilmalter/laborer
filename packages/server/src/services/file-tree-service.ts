/**
 * FileTreeService — Effect Service
 *
 * Provides a live file tree listing for a workspace's worktree directory.
 * Runs `git ls-files -z --others --exclude-standard` to produce the full
 * list of tracked and untracked files (respecting .gitignore), and
 * `git status -z --porcelain=v2` for git status decorations, then streams
 * snapshots to subscribers via Effect Stream.
 *
 * Both git commands run in parallel for each snapshot. The stream emits
 * an initial snapshot on subscribe, then pushes updated snapshots whenever
 * files change on disk. File change detection uses `FileWatcherClient`:
 * the service subscribes a recursive file watcher on the worktree path
 * and listens for events via `onFileEvent`. Events are debounced at 300ms
 * to coalesce rapid changes (e.g., build output) into a single git
 * invocation.
 *
 * Stream deduplication: each subscription maintains a fingerprint of the
 * last emitted snapshot (file count + status count + content hash). When
 * a debounced refresh produces a snapshot identical to the previous one,
 * the emission is suppressed. This prevents redundant renders when a file
 * watcher fires but git state hasn't changed (e.g., a .gitignore'd file
 * was modified, or a log file was appended to).
 *
 * Lifecycle: each call to `subscribe` creates an independent stream with
 * its own file watcher subscription, debounce timer, and dedup state.
 * Closing and reopening the panel creates a fresh stream — no stale data.
 * The `Effect.addFinalizer` in `Stream.asyncPush` ensures all resources
 * (watcher, timer, event subscription) are torn down on disconnect.
 *
 * Follows the `Context.Tag + Layer.scoped` pattern from DiffService.
 *
 * @see PRD: Live File Tree with Git Status Decorations
 * @see Issue #1: Streaming RPC contract + FileTreeService with git ls-files
 * @see Issue #4: Wire git status into FileTreeService and TreePane
 * @see Issue #5: FileWatcher subscription + debounced refresh
 * @see Issue #6: Stream deduplication + lifecycle management
 */

import type { FileTreeSnapshot } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Order,
  pipe,
  Runtime,
  Stream,
} from 'effect'
import { parseGitStatusV2 } from '../lib/parse-git-status-v2.js'
import { spawn } from '../lib/spawn.js'
import { FileWatcherClient } from './file-watcher-client.js'
import { LaborerStore } from './laborer-store.js'

/** Debounce interval for file watcher events (ms). */
const FILE_EVENT_DEBOUNCE_MS = 300

/**
 * Compute a fingerprint string for a FileTreeSnapshot.
 *
 * Used for deduplication: if the fingerprint matches the previous emission,
 * the new snapshot is suppressed to avoid redundant client renders.
 *
 * The fingerprint encodes file count, status count, and content.
 * We use JSON.stringify since both arrays are already sorted (files by
 * `parseLsFilesOutput`, gitStatus by `parseGitStatusV2`), so identical
 * content always produces identical strings.
 *
 * For very large repos, a content hash would be more memory-efficient,
 * but since snapshots are already held in memory for emission this
 * approach adds negligible overhead and is simpler.
 */
const snapshotFingerprint = (snapshot: FileTreeSnapshot): string =>
  `${snapshot.files.length}:${snapshot.gitStatus.length}:${JSON.stringify(snapshot.files)}:${JSON.stringify(snapshot.gitStatus)}`

/**
 * Helper: spawn a git command in a worktree and capture stdout/stderr.
 * Uses `GIT_OPTIONAL_LOCKS=0` to avoid lock contention with concurrent
 * git operations (same technique VS Code uses).
 */
const spawnGit = async (
  args: readonly string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

/**
 * Parse null-delimited `git ls-files` output into a sorted array of
 * relative file paths. Empty entries (from trailing null bytes) are
 * filtered out.
 */
const parseLsFilesOutput = (output: string): string[] =>
  pipe(
    output.split('\0'),
    Arr.filter((entry) => entry.length > 0),
    Arr.sort(Order.string)
  )

/**
 * Run `git ls-files` to get the full list of tracked + untracked files
 * in a worktree directory.
 *
 * Uses `-z` for null-delimited output (safe parsing of paths with spaces
 * and unicode), `--others --exclude-standard` to include untracked files
 * while respecting .gitignore.
 */
const getFileList = Effect.fn('FileTreeService.getFileList')(function* (
  worktreePath: string
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      spawnGit(
        ['ls-files', '-z', '--others', '--exclude-standard', '--cached'],
        worktreePath
      ),
    catch: (error) =>
      new RpcError({
        message: `Failed to spawn git ls-files: ${String(error)}`,
        code: 'GIT_LS_FILES_FAILED',
      }),
  })

  if (result.exitCode !== 0) {
    return yield* new RpcError({
      message: `git ls-files failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      code: 'GIT_LS_FILES_FAILED',
    })
  }

  return parseLsFilesOutput(result.stdout)
})

/**
 * Run `git status -z --porcelain=v2` to get the change metadata for
 * a worktree directory.
 *
 * Uses `-z` for null-delimited output (safe parsing of paths with spaces
 * and unicode) and `--porcelain=v2` for structured status output with
 * two-character status codes.
 *
 * Returns `GitStatusEntry[]` compatible with `@pierre/trees`' `gitStatus` prop.
 */
const getGitStatus = Effect.fn('FileTreeService.getGitStatus')(function* (
  worktreePath: string
) {
  const result = yield* Effect.tryPromise({
    try: () => spawnGit(['status', '-z', '--porcelain=v2'], worktreePath),
    catch: (error) =>
      new RpcError({
        message: `Failed to spawn git status: ${String(error)}`,
        code: 'GIT_STATUS_FAILED',
      }),
  })

  if (result.exitCode !== 0) {
    return yield* new RpcError({
      message: `git status failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      code: 'GIT_STATUS_FAILED',
    })
  }

  return parseGitStatusV2(result.stdout)
})

/**
 * Compute a fresh FileTreeSnapshot by running git ls-files and git status
 * in parallel.
 */
const computeSnapshot = Effect.fn('FileTreeService.computeSnapshot')(function* (
  worktreePath: string
) {
  const [files, gitStatus] = yield* Effect.all(
    [getFileList(worktreePath), getGitStatus(worktreePath)],
    { concurrency: 'unbounded' }
  )
  return { files, gitStatus } satisfies FileTreeSnapshot
})

class FileTreeService extends Context.Tag('@laborer/FileTreeService')<
  FileTreeService,
  {
    /**
     * Subscribe to the file tree for a workspace.
     *
     * Returns a Stream that emits an initial FileTreeSnapshot on subscribe
     * and pushes updated snapshots reactively when files change on disk.
     * File change events are debounced at 300ms.
     *
     * The stream cleans up file watcher subscriptions and debounce timers
     * when the subscriber disconnects (panel close / unmount).
     *
     * @param workspaceId - ID of the workspace whose worktree to list
     */
    readonly subscribe: (
      workspaceId: string
    ) => Stream.Stream<FileTreeSnapshot, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    FileTreeService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const fileWatcherClient = yield* FileWatcherClient
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)

      const subscribe = (
        workspaceId: string
      ): Stream.Stream<FileTreeSnapshot, RpcError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Look up the workspace to get the worktree path
            const allWorkspaces = store.query(tables.workspaces)
            const workspaceOpt = pipe(
              allWorkspaces,
              Arr.findFirst((w) => w.id === workspaceId)
            )

            if (workspaceOpt._tag === 'None') {
              return Stream.fail(
                new RpcError({
                  message: `Workspace not found: ${workspaceId}`,
                  code: 'NOT_FOUND',
                })
              )
            }

            const workspace = workspaceOpt.value
            const worktreePath = workspace.worktreePath

            yield* Effect.logDebug(
              `[FileTreeService] subscribing to file tree for workspace=${workspaceId} worktreePath=${worktreePath}`
            )

            // Compute the initial snapshot before creating the stream
            // so the first emission is immediate.
            const initialSnapshot = yield* computeSnapshot(worktreePath)

            yield* Effect.logDebug(
              `[FileTreeService] workspace=${workspaceId} initial file count=${initialSnapshot.files.length} gitStatus count=${initialSnapshot.gitStatus.length}`
            )

            // Build a push-based stream: emit the initial snapshot, then
            // push new snapshots when the file watcher fires.
            // Deduplication state: tracks the fingerprint of the last
            // emitted snapshot so redundant emissions are suppressed.
            let previousFingerprint = snapshotFingerprint(initialSnapshot)

            const reactiveStream = Stream.asyncPush<FileTreeSnapshot, RpcError>(
              (emit) =>
                Effect.gen(function* () {
                  // Emit the initial snapshot immediately
                  emit.single(initialSnapshot)

                  // Subscribe a recursive file watcher on the worktree.
                  // This may fail if the file-watcher service is not yet
                  // ready — treat as non-fatal (the initial snapshot is
                  // already emitted, reactivity just won't work).
                  const watchSubscription = yield* fileWatcherClient
                    .subscribe(worktreePath, { recursive: true })
                    .pipe(
                      Effect.map((sub) => sub as typeof sub | undefined),
                      Effect.catchAll((error) =>
                        Effect.gen(function* () {
                          yield* Effect.logWarning(
                            `[FileTreeService] workspace=${workspaceId} failed to subscribe file watcher: ${error.message} — reactivity disabled`
                          )
                          return undefined as
                            | {
                                readonly id: string
                                readonly ignoreGlobs: readonly string[]
                                readonly path: string
                                readonly recursive: boolean
                              }
                            | undefined
                        })
                      )
                    )

                  // Debounce timer handle
                  let debounceTimer: ReturnType<typeof setTimeout> | undefined

                  // Event handler: debounce file changes, then re-compute
                  // and push a new snapshot.
                  const eventSubscription = fileWatcherClient.onFileEvent(
                    (event) => {
                      // Only react to events from our subscription
                      if (
                        watchSubscription === undefined ||
                        event.subscriptionId !== watchSubscription.id
                      ) {
                        return
                      }

                      // Clear any pending debounce
                      if (debounceTimer !== undefined) {
                        clearTimeout(debounceTimer)
                      }

                      debounceTimer = setTimeout(() => {
                        debounceTimer = undefined
                        runPromise(
                          computeSnapshot(worktreePath).pipe(
                            Effect.flatMap((snapshot) => {
                              // Deduplication: compare fingerprint with
                              // the previous emission to suppress redundant
                              // pushes when git state hasn't changed.
                              const fingerprint = snapshotFingerprint(snapshot)
                              if (fingerprint === previousFingerprint) {
                                return Effect.logDebug(
                                  `[FileTreeService] workspace=${workspaceId} SKIPPED — snapshot unchanged (files=${snapshot.files.length} gitStatus=${snapshot.gitStatus.length})`
                                )
                              }
                              previousFingerprint = fingerprint
                              emit.single(snapshot)
                              return Effect.logDebug(
                                `[FileTreeService] workspace=${workspaceId} emitted snapshot (files=${snapshot.files.length} gitStatus=${snapshot.gitStatus.length})`
                              )
                            }),
                            Effect.tapErrorCause((cause) =>
                              Effect.logWarning(
                                `[FileTreeService] workspace=${workspaceId} refresh failed`,
                                cause
                              )
                            ),
                            Effect.catchAll(() => Effect.void)
                          )
                        ).catch(() => undefined)
                      }, FILE_EVENT_DEBOUNCE_MS)
                    }
                  )

                  // Register cleanup: clear debounce timer, unsubscribe
                  // from file events, and tear down file watcher.
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      // Clear pending debounce timer
                      if (debounceTimer !== undefined) {
                        clearTimeout(debounceTimer)
                        debounceTimer = undefined
                      }

                      // Unsubscribe from file events
                      eventSubscription.unsubscribe()

                      // Unsubscribe the file watcher for this worktree
                      if (watchSubscription !== undefined) {
                        yield* fileWatcherClient
                          .unsubscribe(watchSubscription.id)
                          .pipe(
                            Effect.catchAll((error) =>
                              Effect.logWarning(
                                `[FileTreeService] workspace=${workspaceId} failed to unsubscribe file watcher: ${error.message}`
                              )
                            )
                          )
                      }

                      yield* Effect.logDebug(
                        `[FileTreeService] workspace=${workspaceId} stream cleaned up`
                      )
                    })
                  )
                })
            )

            return reactiveStream
          })
        )

      return FileTreeService.of({
        subscribe,
      })
    })
  )
}

export { FileTreeService }
