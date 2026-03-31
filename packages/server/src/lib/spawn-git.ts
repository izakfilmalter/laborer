/**
 * Git-specific process spawn helper.
 *
 * Wraps the low-level `spawn()` utility with git-specific concerns:
 * - `GIT_OPTIONAL_LOCKS=0` for read-only commands (avoids index lock contention)
 * - Concurrent stdout/stderr reading (prevents pipe buffer deadlocks)
 * - Configurable timeout with automatic process kill
 *
 * Inspired by VS Code's git process handling patterns:
 * @see .reference/vscode/extensions/git/src/git.ts
 * @see packages/server/src/lib/spawn.ts (low-level spawn)
 */

import { type SpawnResult, spawn } from './spawn.js'

interface SpawnGitOptions {
  /** Working directory for the git command. */
  readonly cwd: string
  /** Additional environment variables. */
  readonly env?: Record<string, string | undefined>
  /**
   * Whether this is a read-only git command (status, diff, log, rev-parse, etc.).
   * When true, sets `GIT_OPTIONAL_LOCKS=0` to avoid index lock contention.
   * @default false
   */
  readonly readOnly?: boolean
  /**
   * AbortSignal for external cancellation. When the signal fires, the git
   * process is killed with SIGTERM and the promise rejects. This enables
   * callers (e.g. FileTreeService stream cleanup) to cancel in-flight git
   * processes without waiting for the timeout.
   */
  readonly signal?: AbortSignal
  /**
   * Timeout in milliseconds. If the git process does not exit within this
   * time, it is killed with SIGTERM and the result reflects the killed state.
   * @default 30_000
   */
  readonly timeoutMs?: number
}

interface SpawnGitResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Build the environment for a git command.
 *
 * Exported for testing — allows verifying that `GIT_OPTIONAL_LOCKS=0`
 * is set correctly without spawning a real process.
 */
const buildEnv = (
  options: Pick<SpawnGitOptions, 'cwd' | 'env' | 'readOnly'>
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  }

  // GIT_OPTIONAL_LOCKS=0 tells git to skip optional lock acquisition
  // for read-only operations. This prevents lock contention when
  // concurrent write operations hold the index lock.
  // @see https://git-scm.com/docs/git#Documentation/git.txt-codeGITOPTIONALLOCKScode
  if (options.readOnly) {
    env.GIT_OPTIONAL_LOCKS = '0'
  }

  return env
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Apply a timeout and optional AbortSignal to a spawned process.
 *
 * Reads stdout, stderr, and exit code concurrently (preventing pipe buffer
 * deadlocks). If the process does not exit within `timeoutMs`, it is killed
 * with SIGTERM and the promise rejects with a timeout error. If `signal`
 * fires, the process is killed immediately and the promise rejects.
 *
 * Exported for testing — allows verifying timeout and abort behavior
 * without needing to spawn a real git process.
 */
const withTimeout = (
  proc: SpawnResult,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SpawnGitResult> =>
  new Promise<SpawnGitResult>((resolve, reject) => {
    let settled = false

    const settle = () => {
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settle()
        proc.kill()
        reject(new Error(`Git process timed out after ${String(timeoutMs)}ms`))
      }
    }, timeoutMs)

    // AbortSignal handler: kill the process immediately when the
    // signal fires. This enables callers like FileTreeService to
    // cancel in-flight git processes on stream teardown.
    const onAbort = () => {
      if (!settled) {
        settle()
        proc.kill()
        reject(new Error('Git process aborted'))
      }
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        // Already aborted — kill immediately
        settle()
        proc.kill()
        reject(new Error('Git process aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // Read stdout, stderr, and exit code concurrently.
    // This prevents pipe buffer deadlocks: if we awaited proc.exited first
    // and the process wrote enough to fill the pipe buffer, it would block
    // on write and never exit.
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(
      ([stdout, stderr, exitCode]) => {
        if (!settled) {
          settle()
          resolve({ exitCode, stdout, stderr })
        }
      },
      (error: unknown) => {
        if (!settled) {
          settle()
          reject(error)
        }
      }
    )
  })

/**
 * Spawn a git command with safety defaults.
 *
 * - Reads stdout and stderr concurrently with process exit to avoid
 *   pipe buffer deadlocks (the process blocks writing to a full pipe
 *   while the caller waits for exit).
 * - Optionally sets `GIT_OPTIONAL_LOCKS=0` for read-only commands
 *   to prevent lock contention with concurrent write operations.
 * - Enforces a timeout to prevent indefinite hangs.
 */
const spawnGit = (
  args: readonly string[],
  options: SpawnGitOptions
): Promise<SpawnGitResult> => {
  const env = buildEnv(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const proc = spawn(['git', ...args], {
    cwd: options.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return withTimeout(proc, timeoutMs, options.signal)
}

export {
  buildEnv,
  spawnGit,
  withTimeout,
  type SpawnGitOptions,
  type SpawnGitResult,
}
