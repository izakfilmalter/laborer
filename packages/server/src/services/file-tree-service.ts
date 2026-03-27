/**
 * FileTreeService — Effect Service
 *
 * Provides a live file tree listing for a workspace's worktree directory.
 * Runs `git ls-files -z --others --exclude-standard` to produce the full
 * list of tracked and untracked files (respecting .gitignore), and
 * `git status -z --porcelain=v2` for git status decorations, then streams
 * snapshots to subscribers via Effect Stream.
 *
 * Both git commands run in parallel for each snapshot. The service emits
 * a single snapshot on subscribe (the initial file listing + status) and
 * keeps the stream open. No file watching or reactivity yet — those are
 * added in subsequent issues.
 *
 * Follows the `Context.Tag + Layer.scoped` pattern from DiffService.
 *
 * @see PRD: Live File Tree with Git Status Decorations
 * @see Issue #1: Streaming RPC contract + FileTreeService with git ls-files
 * @see Issue #4: Wire git status into FileTreeService and TreePane
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
  Stream,
} from 'effect'
import { parseGitStatusV2 } from '../lib/parse-git-status-v2.js'
import { spawn } from '../lib/spawn.js'
import { LaborerStore } from './laborer-store.js'

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

class FileTreeService extends Context.Tag('@laborer/FileTreeService')<
  FileTreeService,
  {
    /**
     * Subscribe to the file tree for a workspace.
     *
     * Returns a Stream that emits an initial FileTreeSnapshot on subscribe
     * and remains open for future updates (added in subsequent issues).
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

            // Get the initial file list and git status in parallel
            const [files, gitStatus] = yield* Effect.all(
              [getFileList(worktreePath), getGitStatus(worktreePath)],
              { concurrency: 'unbounded' }
            )

            yield* Effect.logDebug(
              `[FileTreeService] workspace=${workspaceId} initial file count=${files.length} gitStatus count=${gitStatus.length}`
            )

            const initialSnapshot: FileTreeSnapshot = {
              files,
              gitStatus,
            }

            // Emit the initial snapshot and keep the stream open.
            // The stream will be extended with file watcher reactivity
            // in Issue #5.
            return Stream.make(initialSnapshot).pipe(
              Stream.concat(Stream.never)
            )
          })
        )

      return FileTreeService.of({
        subscribe,
      })
    })
  )
}

export { FileTreeService }
