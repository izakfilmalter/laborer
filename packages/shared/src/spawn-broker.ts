/**
 * Child-process broker that keeps `spawn` off the daemon's main thread.
 *
 * Node's `child_process.spawn`/`execFile` block the calling thread until the
 * kernel has finished `posix_spawn`. For a ~200MB Node process on macOS that
 * is 2–3ms typically and hundreds of milliseconds under load — and the daemon
 * spawns git, gh, and ps several times a second for housekeeping. Every one of
 * those stalls sat in front of terminal input, terminal output, and every
 * other RPC, which is what made typing feel bursty.
 *
 * The broker runs every child process from a dedicated `worker_threads`
 * Worker. The Worker has its own event loop, so the spawn syscall blocks the
 * worker and never the main thread. The main thread only exchanges messages:
 * spawn requests, stdin chunks, kill signals, and stdout/stderr/close events.
 *
 * The worker's source is inlined and started with `eval: true` so the daemon
 * bundle stays a single self-contained file (no sidecar asset to package).
 *
 * Interactive paths are the hot path; housekeeping must never block them.
 */

import { SHARE_ENV, Worker } from 'node:worker_threads'

type StdioMode = 'pipe' | 'ignore'

export interface BrokerSpawnOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly stderr?: StdioMode
  readonly stdin?: 'pipe' | 'ignore'
  readonly stdout?: StdioMode
}

export interface BrokerChild {
  readonly endStdin: () => void
  /** Resolves with the exit code once the child has closed all stdio. */
  readonly exited: Promise<number>
  readonly kill: (signal?: NodeJS.Signals) => boolean
  /** Rejects with the spawn error if the process could not be started. */
  readonly spawned: Promise<number | undefined>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly writeStdin: (chunk: Uint8Array) => void
}

type WorkerMessage =
  | {
      readonly type: 'spawned'
      readonly id: number
      readonly pid: number | undefined
    }
  | { readonly type: 'stdout'; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: 'stderr'; readonly id: number; readonly chunk: Uint8Array }
  | {
      readonly type: 'error'
      readonly id: number
      readonly message: string
      readonly code?: string
    }
  | {
      readonly type: 'close'
      readonly id: number
      readonly code: number | null
      readonly signal: string | null
    }

const WORKER_SOURCE = `
'use strict'
const { parentPort } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const children = new Map()

const send = (message, transfer) => parentPort.postMessage(message, transfer)

parentPort.on('message', (message) => {
  if (message.type === 'spawn') {
    const { id, command, args, cwd, env, stdio } = message
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio })
    } catch (error) {
      send({ type: 'error', id, message: String(error && error.message || error), code: error && error.code })
      send({ type: 'close', id, code: 1, signal: null })
      return
    }
    children.set(id, child)
    child.once('spawn', () => send({ type: 'spawned', id, pid: child.pid }))
    child.on('error', (error) => {
      send({ type: 'error', id, message: String(error && error.message || error), code: error && error.code })
    })
    const forward = (stream, type) => {
      if (stream === null) return
      stream.on('data', (chunk) => {
        const copy = new Uint8Array(chunk.byteLength)
        copy.set(chunk)
        send({ type, id, chunk: copy }, [copy.buffer])
      })
    }
    forward(child.stdout, 'stdout')
    forward(child.stderr, 'stderr')
    child.on('close', (code, signal) => {
      children.delete(id)
      send({ type: 'close', id, code, signal })
    })
    return
  }
  const child = children.get(message.id)
  if (child === undefined) return
  if (message.type === 'stdin') {
    if (child.stdin) child.stdin.write(message.chunk)
  } else if (message.type === 'stdin-end') {
    if (child.stdin) child.stdin.end()
  } else if (message.type === 'kill') {
    child.kill(message.signal)
  }
})
`

interface PendingChild {
  readonly rejectSpawned: (error: Error) => void
  readonly resolveExited: (code: number) => void
  readonly resolveSpawned: (pid: number | undefined) => void
  spawnError: Error | null
  readonly stderr: ReadableStreamDefaultController<Uint8Array> | null
  readonly stdout: ReadableStreamDefaultController<Uint8Array> | null
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, PendingChild>()

const closeController = (
  controller: ReadableStreamDefaultController<Uint8Array> | null
): void => {
  if (controller === null) {
    return
  }
  try {
    controller.close()
  } catch {
    // already closed or cancelled
  }
}

const handleMessage = (message: WorkerMessage): void => {
  const child = pending.get(message.id)
  if (child === undefined) {
    return
  }
  switch (message.type) {
    case 'spawned':
      child.resolveSpawned(message.pid)
      return
    case 'stdout':
      try {
        child.stdout?.enqueue(message.chunk)
      } catch {
        // consumer cancelled the stream
      }
      return
    case 'stderr':
      try {
        child.stderr?.enqueue(message.chunk)
      } catch {
        // consumer cancelled the stream
      }
      return
    case 'error': {
      const error = Object.assign(new Error(message.message), {
        code: message.code,
      })
      child.spawnError = error
      child.rejectSpawned(error)
      return
    }
    case 'close':
      pending.delete(message.id)
      closeController(child.stdout)
      closeController(child.stderr)
      child.resolveSpawned(undefined)
      child.resolveExited(message.code ?? 1)
      return
    default:
      return
  }
}

const failAll = (reason: Error): void => {
  for (const [id, child] of pending) {
    pending.delete(id)
    child.spawnError = reason
    child.rejectSpawned(reason)
    closeController(child.stdout)
    closeController(child.stderr)
    child.resolveExited(1)
  }
}

const ensureWorker = (): Worker => {
  if (worker !== null) {
    return worker
  }
  const created = new Worker(WORKER_SOURCE, { env: SHARE_ENV, eval: true })
  created.unref()
  created.on('message', handleMessage)
  created.on('error', (error) => {
    if (worker === created) {
      worker = null
    }
    failAll(error instanceof Error ? error : new Error(String(error)))
  })
  created.on('exit', (code) => {
    if (worker === created) {
      worker = null
    }
    failAll(new Error(`spawn broker worker exited with code ${String(code)}`))
  })
  worker = created
  return created
}

/**
 * Spawn a child process from the broker worker.
 *
 * Semantics mirror `child_process.spawn` with piped stdio, except that the
 * process id is only known asynchronously (`spawned`).
 */
export const brokerSpawn = (
  command: string,
  args: readonly string[],
  options: BrokerSpawnOptions = {}
): BrokerChild => {
  const id = nextId++
  const stdoutMode = options.stdout ?? 'pipe'
  const stderrMode = options.stderr ?? 'pipe'
  const stdinMode = options.stdin ?? 'ignore'

  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null =
    null
  let stderrController: ReadableStreamDefaultController<Uint8Array> | null =
    null
  const makeStream = (
    mode: StdioMode,
    assign: (controller: ReadableStreamDefaultController<Uint8Array>) => void
  ): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === 'pipe') {
          assign(controller)
        } else {
          controller.close()
        }
      },
    })
  const stdout = makeStream(stdoutMode, (controller) => {
    stdoutController = controller
  })
  const stderr = makeStream(stderrMode, (controller) => {
    stderrController = controller
  })

  let resolveExited: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  let resolveSpawned: (pid: number | undefined) => void = () => undefined
  let rejectSpawned: (error: Error) => void = () => undefined
  const spawned = new Promise<number | undefined>((resolve, reject) => {
    resolveSpawned = resolve
    rejectSpawned = reject
  })
  // A failed spawn is reported through `exited`'s consumers as well; do not
  // surface it as an unhandled rejection for callers that only await `exited`.
  spawned.catch(() => undefined)

  const child: PendingChild = {
    stdout: stdoutController,
    stderr: stderrController,
    resolveExited,
    resolveSpawned,
    rejectSpawned,
    spawnError: null,
  }
  pending.set(id, child)

  const active = ensureWorker()
  active.postMessage({
    type: 'spawn',
    id,
    command,
    args: [...args],
    cwd: options.cwd,
    env: options.env,
    stdio: [stdinMode, stdoutMode, stderrMode],
  })

  return {
    exited,
    spawned,
    stdout,
    stderr,
    kill: (signal) => {
      if (!pending.has(id)) {
        return false
      }
      active.postMessage({ type: 'kill', id, signal })
      return true
    },
    writeStdin: (chunk) => {
      if (pending.has(id)) {
        active.postMessage({ type: 'stdin', id, chunk })
      }
    },
    endStdin: () => {
      if (pending.has(id)) {
        active.postMessage({ type: 'stdin-end', id })
      }
    },
  }
}

export interface BrokerExecResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Run a short command on the broker thread and collect its utf8 output.
 * Rejects only if the process could not be started; a non-zero exit is
 * reported through `exitCode`. `timeoutMs` sends SIGTERM and resolves with
 * whatever was collected.
 */
export const brokerExec = async (
  command: string,
  args: readonly string[],
  options: BrokerSpawnOptions & { readonly timeoutMs?: number } = {}
): Promise<BrokerExecResult> => {
  const { timeoutMs, ...spawnOptions } = options
  const child = brokerSpawn(command, args, spawnOptions)
  const timer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await child.spawned
    return { exitCode, stdout, stderr }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
