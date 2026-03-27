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
 * Error handling: the service handles unhappy paths gracefully:
 * - Workspace not found -> stream fails with NOT_FOUND
 * - Workspace in non-active state (destroyed/errored/stopped) -> stream
 *   fails with INVALID_STATE
 * - Worktree directory doesn't exist -> retries with backoff up to a
 *   maximum number of attempts before failing with WORKTREE_NOT_READY
 * - Git command failures -> logged as warnings, stream continues with
 *   last known good snapshot (for debounced refreshes) or fails for
 *   initial snapshot
 * - In-flight git processes are killed on stream unsubscribe via the
 *   `AbortController` pattern, preventing orphaned child processes
 *
 * Follows the `Context.Tag + Layer.scoped` pattern from DiffService.
 *
 * @see PRD: Live File Tree with Git Status Decorations
 * @see Issue #1: Streaming RPC contract + FileTreeService with git ls-files
 * @see Issue #4: Wire git status into FileTreeService and TreePane
 * @see Issue #5: FileWatcher subscription + debounced refresh
 * @see Issue #6: Stream deduplication + lifecycle management
 * @see Issue #7: Error states + cancellation + cleanup
 */

import { existsSync } from 'node:fs'
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

/** Maximum number of retry attempts when waiting for worktree directory to exist. */
const WORKTREE_WAIT_MAX_RETRIES = 10

/** Delay between worktree existence checks (ms). */
const WORKTREE_WAIT_DELAY_MS = 1000

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
 *
 * Returns a promise that resolves with the exit code, stdout, and stderr,
 * plus a `kill` function to terminate the process early. The optional
 * `signal` parameter allows external abort via `AbortController`.
 */
const spawnGit = (
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal
): {
  kill: () => void
  result: Promise<{ exitCode: number; stdout: string; stderr: string }>
} => {
  const proc = spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  })

  // If an abort signal is provided, kill the process when it fires
  const onAbort = () => {
    proc.kill()
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      proc.kill()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  const result = (async () => {
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    // Clean up the abort listener once the process has exited
    if (signal !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
    return { exitCode, stdout, stderr }
  })()

  return {
    kill: () => proc.kill(),
    result,
  }
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
 *
 * The optional `signal` parameter enables cancellation of the git process
 * when the stream subscription ends.
 */
const getFileList = Effect.fn('FileTreeService.getFileList')(function* (
  worktreePath: string,
  signal?: AbortSignal
) {
  const { result } = spawnGit(
    ['ls-files', '-z', '--others', '--exclude-standard', '--cached'],
    worktreePath,
    signal
  )

  const output = yield* Effect.tryPromise({
    try: () => result,
    catch: (error) =>
      new RpcError({
        message: `Failed to spawn git ls-files: ${String(error)}`,
        code: 'GIT_LS_FILES_FAILED',
      }),
  })

  if (output.exitCode !== 0) {
    return yield* new RpcError({
      message: `git ls-files failed (exit ${output.exitCode}): ${output.stderr.trim()}`,
      code: 'GIT_LS_FILES_FAILED',
    })
  }

  return parseLsFilesOutput(output.stdout)
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
 *
 * The optional `signal` parameter enables cancellation of the git process
 * when the stream subscription ends.
 */
const getGitStatus = Effect.fn('FileTreeService.getGitStatus')(function* (
  worktreePath: string,
  signal?: AbortSignal
) {
  const { result } = spawnGit(
    ['status', '-z', '--porcelain=v2'],
    worktreePath,
    signal
  )

  const output = yield* Effect.tryPromise({
    try: () => result,
    catch: (error) =>
      new RpcError({
        message: `Failed to spawn git status: ${String(error)}`,
        code: 'GIT_STATUS_FAILED',
      }),
  })

  if (output.exitCode !== 0) {
    return yield* new RpcError({
      message: `git status failed (exit ${output.exitCode}): ${output.stderr.trim()}`,
      code: 'GIT_STATUS_FAILED',
    })
  }

  return parseGitStatusV2(output.stdout)
})

/**
 * Compute a fresh FileTreeSnapshot by running git ls-files and git status
 * in parallel.
 *
 * The optional `signal` parameter is forwarded to both git commands,
 * enabling cancellation of in-flight processes when the stream is torn down.
 */
const computeSnapshot = Effect.fn('FileTreeService.computeSnapshot')(function* (
  worktreePath: string,
  signal?: AbortSignal
) {
  const [files, gitStatus] = yield* Effect.all(
    [getFileList(worktreePath, signal), getGitStatus(worktreePath, signal)],
    { concurrency: 'unbounded' }
  )
  return { files, gitStatus } satisfies FileTreeSnapshot
})

/**
 * Wait for a worktree directory to exist, with retries and backoff.
 * Returns the path if it exists, or fails with WORKTREE_NOT_READY if
 * the maximum number of retries is exceeded.
 *
 * This handles the case where a workspace is still being created and
 * the worktree directory doesn't exist yet.
 */
const waitForWorktree = Effect.fn('FileTreeService.waitForWorktree')(function* (
  worktreePath: string,
  workspaceId: string
) {
  for (let attempt = 0; attempt < WORKTREE_WAIT_MAX_RETRIES; attempt++) {
    if (existsSync(worktreePath)) {
      return worktreePath
    }

    yield* Effect.logDebug(
      `[FileTreeService] workspace=${workspaceId} worktree not ready (attempt ${attempt + 1}/${WORKTREE_WAIT_MAX_RETRIES}), retrying in ${WORKTREE_WAIT_DELAY_MS}ms`
    )

    yield* Effect.sleep(WORKTREE_WAIT_DELAY_MS)
  }

  // Final check after all retries
  if (existsSync(worktreePath)) {
    return worktreePath
  }

  return yield* new RpcError({
    message: `Worktree directory does not exist after ${WORKTREE_WAIT_MAX_RETRIES} retries: ${worktreePath}`,
    code: 'WORKTREE_NOT_READY',
  })
})

/**
 * Clean up all resources held by a file tree stream subscription.
 *
 * Extracted from the addFinalizer closure to reduce cognitive complexity
 * of the subscribe method.
 */
const cleanupStreamResources = (opts: {
  refreshAbortController: AbortController | undefined
  abortController: AbortController
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  eventSubscription: { unsubscribe: () => void }
  watchSubscription:
    | {
        readonly id: string
        readonly ignoreGlobs: readonly string[]
        readonly path: string
        readonly recursive: boolean
      }
    | undefined
  workspaceId: string
  fileWatcherClient: {
    unsubscribe: (id: string) => Effect.Effect<void, { message: string }>
  }
}) =>
  Effect.gen(function* () {
    // Abort any in-flight git processes immediately.
    // This prevents orphaned child processes when the
    // stream is torn down (panel close, workspace destroy).
    if (opts.refreshAbortController !== undefined) {
      opts.refreshAbortController.abort()
    }
    opts.abortController.abort()

    // Clear pending debounce timer
    if (opts.debounceTimer !== undefined) {
      clearTimeout(opts.debounceTimer)
    }

    // Unsubscribe from file events
    opts.eventSubscription.unsubscribe()

    // Unsubscribe the file watcher for this worktree
    if (opts.watchSubscription !== undefined) {
      yield* opts.fileWatcherClient
        .unsubscribe(opts.watchSubscription.id)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[FileTreeService] workspace=${opts.workspaceId} failed to unsubscribe file watcher: ${error.message}`
            )
          )
        )
    }

    yield* Effect.logDebug(
      `[FileTreeService] workspace=${opts.workspaceId} stream cleaned up (git processes aborted, watcher unsubscribed)`
    )
  })

/**
 * Build an Effect that computes a new snapshot, deduplicates against the
 * previous emission, and pushes to the stream emitter if changed.
 *
 * Extracted from the subscribe closure to reduce cognitive complexity of
 * the stream setup code.
 */
const makeRefreshEffect = (opts: {
  worktreePath: string
  workspaceId: string
  signal: AbortSignal
  emit: { single: (snapshot: FileTreeSnapshot) => void }
  getPreviousFingerprint: () => string
  setPreviousFingerprint: (fp: string) => void
}) =>
  computeSnapshot(opts.worktreePath, opts.signal).pipe(
    Effect.flatMap((snapshot) => {
      const fingerprint = snapshotFingerprint(snapshot)
      if (fingerprint === opts.getPreviousFingerprint()) {
        return Effect.logDebug(
          `[FileTreeService] workspace=${opts.workspaceId} SKIPPED — snapshot unchanged (files=${snapshot.files.length} gitStatus=${snapshot.gitStatus.length})`
        )
      }
      opts.setPreviousFingerprint(fingerprint)
      opts.emit.single(snapshot)
      return Effect.logDebug(
        `[FileTreeService] workspace=${opts.workspaceId} emitted snapshot (files=${snapshot.files.length} gitStatus=${snapshot.gitStatus.length})`
      )
    }),
    Effect.tapErrorCause((cause) =>
      Effect.logWarning(
        `[FileTreeService] workspace=${opts.workspaceId} refresh failed`,
        cause
      )
    ),
    Effect.catchAll(() => Effect.void)
  )

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
     * The stream cleans up file watcher subscriptions, debounce timers,
     * and in-flight git processes when the subscriber disconnects
     * (panel close / unmount).
     *
     * Error handling:
     * - Workspace not found: stream fails with NOT_FOUND
     * - Workspace destroyed/errored/stopped: stream fails with INVALID_STATE
     * - Worktree not ready: waits with retries, then fails with WORKTREE_NOT_READY
     * - Git failures during refresh: logged as warnings, stream continues
     * - Git failures on initial snapshot: stream fails with the git error
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

            // Reject subscriptions for workspaces in non-active states.
            // Only 'running' and 'creating' workspaces should have their
            // file tree streamed. 'creating' is allowed because we wait
            // for the worktree directory to appear.
            if (
              workspace.status !== 'running' &&
              workspace.status !== 'creating'
            ) {
              return Stream.fail(
                new RpcError({
                  message: `Workspace ${workspaceId} is in "${workspace.status}" state`,
                  code: 'INVALID_STATE',
                })
              )
            }

            const worktreePath = workspace.worktreePath

            yield* Effect.logDebug(
              `[FileTreeService] subscribing to file tree for workspace=${workspaceId} worktreePath=${worktreePath} status=${workspace.status}`
            )

            // Wait for the worktree directory to exist. This handles
            // 'creating' workspaces where the directory may not be ready yet.
            yield* waitForWorktree(worktreePath, workspaceId)

            // AbortController for cancelling in-flight git processes on
            // stream teardown (unsubscribe / panel close).
            const abortController = new AbortController()

            // Per-refresh AbortController: cancels the previous refresh's
            // in-flight git processes when a new debounced refresh starts.
            // This prevents stale results from a slow git command overwriting
            // results from a newer, faster one.
            let refreshAbortController: AbortController | undefined

            // Compute the initial snapshot before creating the stream
            // so the first emission is immediate.
            const initialSnapshot = yield* computeSnapshot(
              worktreePath,
              abortController.signal
            )

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

                        // Guard: if aborted (stream torn down), don't
                        // start new git processes.
                        if (abortController.signal.aborted) {
                          return
                        }

                        // Cancel any previous in-flight refresh. This
                        // prevents stale results from a slow git command
                        // overwriting results from a newer, faster one.
                        if (refreshAbortController !== undefined) {
                          refreshAbortController.abort()
                        }
                        refreshAbortController = new AbortController()
                        const refreshSignal = refreshAbortController.signal

                        runPromise(
                          makeRefreshEffect({
                            worktreePath,
                            workspaceId,
                            signal: refreshSignal,
                            emit,
                            getPreviousFingerprint: () => previousFingerprint,
                            setPreviousFingerprint: (fp) => {
                              previousFingerprint = fp
                            },
                          })
                        ).catch(() => undefined)
                      }, FILE_EVENT_DEBOUNCE_MS)
                    }
                  )

                  // Register cleanup: abort in-flight git processes, clear
                  // debounce timer, unsubscribe from file events, and tear
                  // down file watcher.
                  yield* Effect.addFinalizer(() =>
                    cleanupStreamResources({
                      refreshAbortController,
                      abortController,
                      debounceTimer,
                      eventSubscription,
                      watchSubscription,
                      workspaceId,
                      fileWatcherClient,
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
