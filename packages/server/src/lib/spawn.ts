/**
 * Process spawn utilities for the daemon.
 *
 * `spawn` keeps Bun.spawn()-compatible ergonomics (the ~40 call sites that
 * came from the Bun era use `new Response(proc.stdout).text()`), and
 * `execFile` mirrors the callback shape of `node:child_process.execFile` for
 * the git wrappers that were written against it.
 *
 * Both are backed by the spawn broker so the actual `spawn` syscall runs on a
 * worker thread. Nothing in the daemon should call `node:child_process`
 * directly for short-lived commands: the blocking spawn call would sit in
 * front of terminal input and every RPC (see spawn-broker.ts).
 *
 * @see PRD-migrate-to-electron.md — "Process spawn utility" architectural decision
 */

import { type BrokerChild, brokerSpawn } from '@laborer/shared/spawn-broker'

interface SpawnOptions {
  /** Working directory for the child process. */
  readonly cwd?: string
  /** Environment variables. If omitted, inherits from `process.env`. */
  readonly env?: Record<string, string | undefined>
  /**
   * stderr disposition.
   * - `'pipe'` (default): capture stderr as a ReadableStream
   * - `'ignore'`: discard stderr
   */
  readonly stderr?: 'pipe' | 'ignore'
  /**
   * stdin source for the child process.
   * - `undefined` / `'pipe'`: no stdin (stdin is closed immediately unless piped)
   * - `ReadableStream<Uint8Array>`: pipe the stream into the child's stdin
   */
  readonly stdin?: ReadableStream<Uint8Array> | 'pipe'
  /**
   * stdout disposition.
   * - `'pipe'` (default): capture stdout as a ReadableStream
   * - `'ignore'`: discard stdout
   */
  readonly stdout?: 'pipe' | 'ignore'
}

interface SpawnResult {
  /** Promise that resolves with the exit code when the process exits. */
  readonly exited: Promise<number>
  /** Send a signal to the child process. Defaults to SIGTERM. */
  readonly kill: (signal?: NodeJS.Signals) => boolean
  /**
   * Resolves with the child's pid once the broker thread has started it;
   * rejects if the process could not be spawned (e.g. ENOENT).
   */
  readonly spawned: Promise<number | undefined>
  /**
   * stderr as a Web ReadableStream.
   * Empty stream if stderr was set to 'ignore'.
   */
  readonly stderr: ReadableStream<Uint8Array>
  /**
   * stdout as a Web ReadableStream.
   * Empty stream if stdout was set to 'ignore'.
   */
  readonly stdout: ReadableStream<Uint8Array>
}

/**
 * Pump a Web ReadableStream into the child's stdin, ending stdin when the
 * source is exhausted or errors.
 */
const pipeWebStreamToStdin = (
  webStream: ReadableStream<Uint8Array>,
  child: BrokerChild
): void => {
  const reader = webStream.getReader()
  const pump = (): void => {
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          child.endStdin()
          return
        }
        child.writeStdin(value)
        pump()
      })
      .catch(() => {
        child.endStdin()
      })
  }
  child.exited.then(() =>
    reader.cancel().catch(() => {
      // Intentionally swallowed — reader may already be closed
    })
  )
  pump()
}

/**
 * Spawn a child process with Bun.spawn()-compatible ergonomics.
 *
 * @example
 * ```ts
 * const proc = spawn(['git', 'status', '--porcelain'], { cwd: repoPath })
 * const exitCode = await proc.exited
 * const output = await new Response(proc.stdout).text()
 * ```
 */
const spawn = (cmd: string[], options?: SpawnOptions): SpawnResult => {
  const [command, ...args] = cmd

  if (command === undefined) {
    throw new Error('spawn: command array must not be empty')
  }

  const stdinMode = options?.stdin instanceof ReadableStream ? 'pipe' : 'ignore'

  const child = brokerSpawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    stdin: stdinMode,
    stdout: options?.stdout ?? 'pipe',
    stderr: options?.stderr ?? 'pipe',
  })

  if (options?.stdin instanceof ReadableStream) {
    pipeWebStreamToStdin(options.stdin, child)
  }

  // Surface spawn failures (ENOENT etc.) the way node's ChildProcess does:
  // as a rejection rather than a silent non-zero exit.
  const exited = child.exited.then(async (code) => {
    await child.spawned
    return code
  })

  return {
    exited,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: child.kill,
    spawned: child.spawned,
  }
}

interface ExecFileOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  /** Kill the child and fail with `killed: true` after this many ms. */
  readonly timeout?: number | undefined
}

interface ExecFileError extends Error {
  readonly code: number | string | undefined
  readonly killed: boolean
  readonly signal: NodeJS.Signals | undefined
}

type ExecFileCallback = (
  error: ExecFileError | null,
  stdout: string,
  stderr: string
) => void

const readText = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text()

/**
 * `node:child_process.execFile` lookalike (utf8, buffered stdout/stderr,
 * callback API) that runs on the broker thread.
 *
 * On a non-zero exit the error carries the numeric exit code in `code`, like
 * node's; on a spawn failure `code` is the errno string (e.g. `ENOENT`).
 */
const execFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback
): void => {
  const child = brokerSpawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let killedByTimeout = false
  const timer =
    options.timeout === undefined
      ? null
      : setTimeout(() => {
          killedByTimeout = true
          child.kill('SIGTERM')
        }, options.timeout)

  const makeError = (
    message: string,
    code: number | string | undefined
  ): ExecFileError =>
    Object.assign(new Error(message), {
      code,
      killed: killedByTimeout,
      signal: killedByTimeout ? ('SIGTERM' as const) : undefined,
    })

  Promise.all([readText(child.stdout), readText(child.stderr), child.exited])
    .then(async ([stdout, stderr, exitCode]) => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      try {
        await child.spawned
      } catch (error) {
        const spawnError = error as Error & { code?: string }
        callback(makeError(spawnError.message, spawnError.code), stdout, stderr)
        return
      }
      if (exitCode !== 0 || killedByTimeout) {
        callback(
          makeError(
            `Command failed: ${file} ${args.join(' ')}\n${stderr}`,
            exitCode
          ),
          stdout,
          stderr
        )
        return
      }
      callback(null, stdout, stderr)
    })
    .catch((error: unknown) => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      callback(makeError(String(error), undefined), '', '')
    })
}

export {
  execFile,
  spawn,
  type ExecFileError,
  type ExecFileOptions,
  type SpawnOptions,
  type SpawnResult,
}
