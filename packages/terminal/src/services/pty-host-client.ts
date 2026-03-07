/**
 * PtyHostClient — Effect Service
 *
 * Manages communication with the PTY Host child process. The PTY Host is
 * a standalone script (pty-host.ts) that runs node-pty in an isolated
 * Node.js process to avoid SIGHUP issues in the main HTTP server.
 *
 * The PTY Host runs under Node.js (not Bun) because Bun's tty.ReadStream
 * implementation does not fire data events for PTY master file descriptors,
 * which prevents node-pty's onData from working.
 *
 * Responsibilities:
 * - Spawning the PTY Host as a Node.js child process during layer construction
 * - Waiting for the `ready` event before accepting commands
 * - Sending JSON commands to the PTY Host via stdin
 * - Parsing JSON events from the PTY Host via stdout (line-based)
 * - Routing `data` and `exit` events to per-terminal callbacks
 * - Notifying crash callbacks when the PTY Host process exits
 * - Killing the PTY Host and all PTY children on layer teardown
 *
 * IPC Protocol: Newline-delimited JSON over stdin (commands) and stdout (events).
 * See pty-host.ts for the full protocol specification.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const client = yield* PtyHostClient
 *   client.spawn({ id, shell, args, cwd, env, cols, rows }, onData, onExit)
 *   client.write(id, "echo hello\n")
 *   client.resize(id, 120, 40)
 *   client.kill(id)
 * })
 * ```
 */

import { spawn as spawnChild } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Deferred, Effect, Layer, Runtime } from 'effect'

// ---------------------------------------------------------------------------
// IPC Protocol Types (mirrored from pty-host.ts)
// ---------------------------------------------------------------------------

interface SpawnParams {
  readonly args: readonly string[]
  readonly cols: number
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  readonly rows: number
  readonly shell: string
}

interface DataEvent {
  readonly data: string // raw UTF-8
  readonly id: string
  readonly type: 'data'
}

interface ExitEvent {
  readonly exitCode: number
  readonly id: string
  readonly signal: number
  readonly type: 'exit'
}

interface ErrorEvent {
  readonly id?: string
  readonly message: string
  readonly type: 'error'
}

interface ReadyEvent {
  readonly type: 'ready'
}

type PtyEvent = ReadyEvent | DataEvent | ExitEvent | ErrorEvent

/** Callback invoked when a PTY produces output (raw UTF-8). */
type DataCallback = (data: string) => void

/** Callback invoked when a PTY process exits. */
type ExitCallback = (exitCode: number, signal: number) => void

/** Callback invoked when the PTY Host process crashes. */
type CrashCallback = () => void

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class PtyHostClient extends Context.Tag('@laborer/PtyHostClient')<
  PtyHostClient,
  {
    /**
     * Spawn a new PTY in the PTY Host.
     * Sends a `spawn` command and registers data/exit callbacks.
     */
    readonly spawn: (
      params: SpawnParams,
      onData: DataCallback,
      onExit: ExitCallback
    ) => void

    /** Write data to a PTY's stdin. */
    readonly write: (id: string, data: string) => void

    /** Resize a PTY's dimensions. */
    readonly resize: (id: string, cols: number, rows: number) => void

    /** Kill a PTY process. */
    readonly kill: (id: string) => void

    /**
     * Acknowledge processing of `chars` characters for a terminal.
     * Used for flow control: the PTY host decrements its
     * `unacknowledgedCharCount` and resumes the PTY if below
     * the low watermark (Issue #141).
     */
    readonly ack: (id: string, chars: number) => void

    /**
     * Register a callback that is invoked when the PTY Host process
     * crashes or exits unexpectedly.
     */
    readonly onCrash: (callback: CrashCallback) => void
  }
>() {
  static readonly layer = Layer.scoped(
    PtyHostClient,
    Effect.gen(function* () {
      // Resolve the PTY Host script path relative to this file.
      // This file: packages/server/src/services/pty-host-client.ts
      // PTY Host:  packages/server/src/pty-host.ts
      // Uses fileURLToPath for Node.js compatibility (import.meta.dir is Bun-only).
      const currentDir = dirname(fileURLToPath(import.meta.url))
      const ptyHostPath = join(currentDir, '..', 'pty-host.ts')

      // Per-terminal callbacks
      const dataCallbacks = new Map<string, DataCallback>()
      const exitCallbacks = new Map<string, ExitCallback>()
      const crashCallbacks: CrashCallback[] = []

      // Deferred that resolves when the PTY Host sends the `ready` event
      const readyDeferred = yield* Deferred.make<void, Error>()

      // Extract the runtime so we can run Effects from plain JS callbacks
      // (async readers and process monitors). This avoids Effect.runFork
      // which uses the default runtime instead of our scoped runtime.
      const runtime = yield* Effect.runtime<never>()
      const runFork = Runtime.runFork(runtime)

      // Spawn the PTY Host as a Node.js child process via node:child_process.
      // Uses Node.js instead of Bun because Bun's tty.ReadStream does
      // not fire data events for PTY master file descriptors, preventing
      // node-pty's onData callback from working.
      // Uses node:child_process (not Bun.spawn) for cross-runtime compatibility
      // so that vitest tests (which run under Node.js) can construct this layer.
      const child = spawnChild('node', [ptyHostPath], {
        stdio: ['pipe', 'pipe', 'inherit'], // PTY Host debug logs go to our stderr
      })

      /** Send a JSON command to the PTY Host via stdin. */
      const sendCommand = (command: Record<string, unknown>): void => {
        const line = `${JSON.stringify(command)}\n`
        child.stdin?.write(line)
      }

      /** Route a `data` event to the registered callback. */
      const handleDataEvent = (event: DataEvent): void => {
        const cb = dataCallbacks.get(event.id)
        if (cb !== undefined) {
          cb(event.data)
        }
      }

      /** Route an `exit` event to the registered callback and clean up. */
      const handleExitEvent = (event: ExitEvent): void => {
        const exitCb = exitCallbacks.get(event.id)
        if (exitCb !== undefined) {
          exitCb(event.exitCode, event.signal)
        }
        dataCallbacks.delete(event.id)
        exitCallbacks.delete(event.id)
      }

      /** Log an error event from the PTY Host. */
      const handleErrorEvent = (event: ErrorEvent): void => {
        const prefix =
          event.id !== undefined ? `PTY error id=${event.id}` : 'Host error'
        console.error(`[PtyHostClient] ${prefix}: ${event.message}`)
      }

      /** Route an incoming event to the appropriate handler. */
      const routeEvent = (event: PtyEvent): void => {
        switch (event.type) {
          case 'ready':
            break
          case 'data':
            handleDataEvent(event)
            break
          case 'exit':
            handleExitEvent(event)
            break
          case 'error':
            handleErrorEvent(event)
            break
          default:
            console.error(
              `[PtyHostClient] Unknown event type: ${(event as Record<string, unknown>).type}`
            )
            break
        }
      }

      /** Parse a single line of JSON into a PtyEvent and route it. */
      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (trimmed === '') {
          return
        }
        try {
          const event = JSON.parse(trimmed) as PtyEvent
          if (event.type === 'ready') {
            // Resolve the ready deferred from outside Effect context
            runFork(Deferred.succeed(readyDeferred, undefined))
            return
          }
          routeEvent(event)
        } catch {
          console.error(
            `[PtyHostClient] Failed to parse event: ${trimmed.slice(0, 200)}`
          )
        }
      }

      /**
       * Read stdout from the PTY Host as newline-delimited text.
       * Uses Node.js Readable stream callbacks for cross-runtime compatibility.
       *
       * Uses an array-based accumulator to avoid O(n²) string copying from
       * repeated `buffer += chunk` concatenation under high throughput (Issue #136).
       * Chunks are pushed onto an array and only joined when scanning for newlines.
       */
      const stdoutChunks: string[] = []

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString('utf-8'))
        drainLines()
      })

      child.stdout?.on('end', () => {
        // Process any remaining data
        const remaining = stdoutChunks.join('').trim()
        stdoutChunks.length = 0
        if (remaining !== '') {
          processLine(remaining)
        }
      })

      child.stdout?.on('error', (error: Error) => {
        console.error(`[PtyHostClient] stdout reader error: ${String(error)}`)
      })

      /**
       * Join accumulated chunks, extract complete lines, and keep
       * the remainder (after the last newline) for the next chunk.
       */
      const drainLines = (): void => {
        const joined = stdoutChunks.join('')
        stdoutChunks.length = 0

        let searchStart = 0
        let idx = joined.indexOf('\n', searchStart)
        while (idx !== -1) {
          const line = joined.slice(searchStart, idx)
          processLine(line)
          searchStart = idx + 1
          idx = joined.indexOf('\n', searchStart)
        }

        // Keep the remainder for the next chunk
        if (searchStart < joined.length) {
          stdoutChunks.push(joined.slice(searchStart))
        }
      }

      // Monitor PTY Host process for crashes via the 'exit' event.
      child.on('exit', (exitCode) => {
        console.error(
          `[PtyHostClient] PTY Host process exited with code ${exitCode}`
        )
        // Signal ready failure if the process dies before becoming ready
        runFork(
          Deferred.fail(
            readyDeferred,
            new Error(`PTY Host exited with code ${exitCode} before ready`)
          )
        )
        for (const cb of crashCallbacks) {
          try {
            cb()
          } catch (error) {
            console.error(
              `[PtyHostClient] Crash callback error: ${String(error)}`
            )
          }
        }
      })

      // Wait for the PTY Host to emit the `ready` event
      yield* Deferred.await(readyDeferred).pipe(
        Effect.catchAll((error) =>
          Effect.die(
            new Error(`PtyHostClient failed to start: ${error.message}`)
          )
        )
      )

      // Register teardown: kill the PTY Host when the layer is destroyed
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            child.kill()
          } catch {
            // Best effort — process may have already exited
          }
        })
      )

      return PtyHostClient.of({
        spawn: (params, onData, onExit) => {
          // Register callbacks before sending the command to avoid races
          dataCallbacks.set(params.id, onData)
          exitCallbacks.set(params.id, onExit)

          sendCommand({
            type: 'spawn',
            id: params.id,
            shell: params.shell,
            args: params.args,
            cwd: params.cwd,
            env: params.env,
            cols: params.cols,
            rows: params.rows,
          })
        },

        write: (id, data) => {
          sendCommand({ type: 'write', id, data })
        },

        resize: (id, cols, rows) => {
          sendCommand({ type: 'resize', id, cols, rows })
        },

        kill: (id) => {
          sendCommand({ type: 'kill', id })
        },

        ack: (id, chars) => {
          sendCommand({ type: 'ack', id, chars })
        },

        onCrash: (callback) => {
          crashCallbacks.push(callback)
        },
      })
    })
  )
}

export { PtyHostClient }
export type { CrashCallback, DataCallback, ExitCallback, SpawnParams }
