/**
 * Node.js spawn utility that provides Bun.spawn()-compatible ergonomics.
 *
 * Designed as a drop-in replacement for all ~40 `Bun.spawn()` call sites
 * in the server package. Returns Web ReadableStreams for stdout/stderr
 * so that the existing `new Response(proc.stdout).text()` pattern works
 * unchanged.
 *
 * @see PRD-migrate-to-electron.md — "Process spawn utility" architectural decision
 */

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { Readable } from 'node:stream'

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
  /** The child process PID. Undefined if the process failed to spawn. */
  readonly pid: number | undefined
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

/** Convert a Node.js Readable stream to a Web ReadableStream, or return an empty stream. */
const toWebStream = (
  nodeStream: Readable | null
): ReadableStream<Uint8Array> => {
  if (nodeStream === null) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  }
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
}

/**
 * Pipe a Web ReadableStream into a Node.js Writable (the child's stdin).
 * Closes the writable when the readable is exhausted.
 */
const pipeWebStreamToNodeWritable = (
  webStream: ReadableStream<Uint8Array>,
  child: ChildProcess
): void => {
  const writable = child.stdin
  if (writable === null) {
    return
  }

  const reader = webStream.getReader()

  const pump = (): void => {
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          writable.end()
          return
        }
        const canContinue = writable.write(value)
        if (canContinue) {
          pump()
        } else {
          writable.once('drain', pump)
        }
      })
      .catch(() => {
        // Source stream errored — close stdin
        writable.end()
      })
  }

  // If the child process exits or stdin errors, cancel the reader
  writable.on('error', () => {
    reader.cancel().catch(() => {
      // Intentionally swallowed — reader may already be closed
    })
  })
  child.on('exit', () => {
    reader.cancel().catch(() => {
      // Intentionally swallowed — reader may already be closed
    })
  })

  pump()
}

/**
 * Spawn a child process with Bun.spawn()-compatible ergonomics.
 *
 * @example
 * ```ts
 * // Simple command execution
 * const proc = spawn(['git', 'status', '--porcelain'], { cwd: repoPath })
 * const exitCode = await proc.exited
 * const output = await new Response(proc.stdout).text()
 *
 * // Pipe between processes
 * const tarProc = spawn(['docker', 'exec', name, 'tar', 'cf', '-', '.'], { stdout: 'pipe' })
 * const extractProc = spawn(['tar', 'xf', '-', '-C', dest], { stdin: tarProc.stdout })
 * await Promise.all([tarProc.exited, extractProc.exited])
 * ```
 */
const spawn = (cmd: string[], options?: SpawnOptions): SpawnResult => {
  const [command, ...args] = cmd

  if (command === undefined) {
    throw new Error('spawn: command array must not be empty')
  }

  const stdoutMode = options?.stdout ?? 'pipe'
  const stderrMode = options?.stderr ?? 'pipe'
  const stdinMode = options?.stdin instanceof ReadableStream ? 'pipe' : 'ignore'

  const child = nodeSpawn(command, args, {
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv | undefined,
    stdio: [stdinMode, stdoutMode, stderrMode],
  })

  // Pipe the Web ReadableStream into the child's stdin if provided
  if (options?.stdin instanceof ReadableStream) {
    pipeWebStreamToNodeWritable(options.stdin, child)
  }

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })

  return {
    exited,
    stdout: toWebStream(child.stdout),
    stderr: toWebStream(child.stderr),
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    pid: child.pid,
  }
}

export { spawn, type SpawnOptions, type SpawnResult }
