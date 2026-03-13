/**
 * GhosttyHostClient — Effect Service
 *
 * Manages communication with the Ghostty Host child process. The Ghostty
 * Host is a standalone script (ghostty-host.ts) that runs the native Ghostty
 * terminal runtime in an isolated Node.js process with AppKit/Metal access.
 *
 * Responsibilities:
 * - Spawning the Ghostty Host as a Node.js child process during layer construction
 * - Waiting for the `ready` event before accepting commands
 * - Sending JSON commands to the Ghostty Host via stdin
 * - Parsing JSON events from the Ghostty Host via stdout (line-based)
 * - Providing request/response APIs for surface lifecycle and queries
 * - Notifying crash callbacks when the Ghostty Host process exits
 * - Killing the Ghostty Host on layer teardown
 *
 * IPC Protocol: Newline-delimited JSON over stdin (commands) and stdout (events).
 * See ghostty-host.ts for the full protocol specification.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const client = yield* GhosttyHostClient
 *   const surfaceId = yield* client.createSurface({ width: 800, height: 600 })
 *   yield* client.setSurfaceSize(surfaceId, 1024, 768)
 *   yield* client.setSurfaceFocus(surfaceId, true)
 *   const ioInfo = yield* client.getIOSurfaceId(surfaceId)
 *   yield* client.destroySurface(surfaceId)
 * })
 * ```
 */

import { spawn as spawnChild } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Deferred, Effect, Layer, Runtime } from 'effect'
import type {
  CreateSurfaceOptions,
  IOSurfaceInfo,
  SurfaceSize,
} from './index.ts'

// ---------------------------------------------------------------------------
// IPC Protocol Types (mirrored from ghostty-host.ts)
// ---------------------------------------------------------------------------

/** Events emitted by the Ghostty Host process. */
interface ReadyEvent {
  readonly type: 'ready'
  readonly version: string
}

interface SurfaceCreatedEvent {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'surface_created'
}

interface SurfaceDestroyedEvent {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'surface_destroyed'
}

interface SizeResultEvent {
  readonly id: string
  readonly size: SurfaceSize
  readonly surfaceId: number
  readonly type: 'size_result'
}

interface IOSurfaceResultEvent {
  readonly id: string
  readonly info: IOSurfaceInfo
  readonly surfaceId: number
  readonly type: 'iosurface_result'
}

interface SurfacesListEvent {
  readonly surfaces: number[]
  readonly type: 'surfaces_list'
}

interface OkEvent {
  readonly id: string
  readonly type: 'ok'
}

interface ErrorEvent {
  readonly id?: string
  readonly message: string
  readonly type: 'error'
}

type GhosttyEvent =
  | ReadyEvent
  | SurfaceCreatedEvent
  | SurfaceDestroyedEvent
  | SizeResultEvent
  | IOSurfaceResultEvent
  | SurfacesListEvent
  | OkEvent
  | ErrorEvent

/** Callback invoked when the Ghostty Host process crashes. */
type CrashCallback = () => void

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

/**
 * A pending request waiting for a response from the Ghostty Host.
 * The resolve/reject callbacks correspond to a Promise that the caller
 * is awaiting.
 */
interface PendingRequest {
  readonly reject: (reason: Error) => void
  readonly resolve: (value: unknown) => void
}

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class GhosttyHostClient extends Context.Tag('@laborer/GhosttyHostClient')<
  GhosttyHostClient,
  {
    /**
     * Create a new Ghostty terminal surface in the host process.
     * Returns the numeric surface ID assigned by the native runtime.
     */
    readonly createSurface: (
      options?: CreateSurfaceOptions
    ) => Effect.Effect<number, Error>

    /**
     * Destroy a Ghostty terminal surface by its ID.
     * Frees native resources in the host process.
     */
    readonly destroySurface: (surfaceId: number) => Effect.Effect<void, Error>

    /**
     * Get the IOSurface information for a surface.
     * Used for zero-copy texture sharing with the Electron renderer.
     */
    readonly getIOSurfaceId: (
      surfaceId: number
    ) => Effect.Effect<IOSurfaceInfo, Error>

    /**
     * Get the current size of a surface including grid dimensions.
     */
    readonly getSurfaceSize: (
      surfaceId: number
    ) => Effect.Effect<SurfaceSize, Error>

    /**
     * List all active surface IDs in the host process.
     */
    readonly listSurfaces: () => Effect.Effect<readonly number[], Error>

    /**
     * Register a callback invoked when the Ghostty Host process crashes.
     */
    readonly onCrash: (callback: CrashCallback) => void

    /**
     * Set the focus state of a surface.
     */
    readonly setSurfaceFocus: (
      surfaceId: number,
      focused: boolean
    ) => Effect.Effect<void, Error>

    /**
     * Set the pixel size of a surface.
     */
    readonly setSurfaceSize: (
      surfaceId: number,
      width: number,
      height: number
    ) => Effect.Effect<void, Error>

    /**
     * The Ghostty version reported by the host process at startup.
     */
    readonly version: string
  }
>() {
  static readonly layer = Layer.scoped(
    GhosttyHostClient,
    Effect.gen(function* () {
      // Resolve the Ghostty Host script path.
      //
      // In source mode (running via tsx or vitest), import.meta.url points
      // to the real .ts source file. In bundled mode, it points to
      // the compiled JS file.
      const currentPath = fileURLToPath(import.meta.url)
      const IS_BUNDLED = currentPath.endsWith('.js')
      const ghosttyHostPath = IS_BUNDLED
        ? join(dirname(currentPath), 'ghostty-host.js')
        : join(dirname(currentPath), 'ghostty-host.ts')

      // Pending request map: command ID -> resolve/reject callbacks
      const pendingRequests = new Map<string, PendingRequest>()
      const crashCallbacks: CrashCallback[] = []

      // Monotonic counter for generating unique command IDs
      let nextId = 1

      // Deferred that resolves when the Ghostty Host sends the `ready` event
      const readyDeferred = yield* Deferred.make<string, Error>()

      // Extract the runtime so we can run Effects from plain JS callbacks
      const runtime = yield* Effect.runtime<never>()
      const runFork = Runtime.runFork(runtime)

      // Resolve the tsx executable for running TypeScript in dev mode
      const resolveTsxPath = (): string => {
        const repoRoot = join(dirname(currentPath), '..', '..', '..')
        return join(repoRoot, 'node_modules', '.bin', 'tsx')
      }

      // Spawn the Ghostty Host as a child process
      const spawnArgs = IS_BUNDLED
        ? { executable: 'node', args: [ghosttyHostPath] }
        : { executable: resolveTsxPath(), args: [ghosttyHostPath] }

      const child = spawnChild(spawnArgs.executable, spawnArgs.args, {
        stdio: ['pipe', 'pipe', 'inherit'], // debug logs go to our stderr
      })

      /** Generate a unique command ID. */
      const generateId = (): string => {
        const id = `cmd-${nextId}`
        nextId += 1
        return id
      }

      /** Send a JSON command to the Ghostty Host via stdin. */
      const sendCommand = (command: Record<string, unknown>): void => {
        const line = `${JSON.stringify(command)}\n`
        child.stdin?.write(line)
      }

      /**
       * Send a command and return a Promise that resolves when the
       * Ghostty Host responds with a matching event (by command ID).
       */
      const sendRequest = <T>(
        command: Record<string, unknown>
      ): Effect.Effect<T, Error> =>
        Effect.async<T, Error>((resume) => {
          const id = command.id as string
          pendingRequests.set(id, {
            resolve: (value) => resume(Effect.succeed(value as T)),
            reject: (error) => resume(Effect.fail(error)),
          })
          sendCommand(command)
        })

      /** Resolve a pending request by ID. */
      const resolveRequest = (id: string, value: unknown): void => {
        const pending = pendingRequests.get(id)
        if (pending !== undefined) {
          pendingRequests.delete(id)
          pending.resolve(value)
        }
      }

      /** Reject a pending request by ID. */
      const rejectRequest = (id: string, error: Error): void => {
        const pending = pendingRequests.get(id)
        if (pending !== undefined) {
          pendingRequests.delete(id)
          pending.reject(error)
        }
      }

      /** Route an incoming event to the appropriate handler. */
      const routeEvent = (event: GhosttyEvent): void => {
        switch (event.type) {
          case 'ready':
            // Handled separately before routing
            break
          case 'surface_created':
            resolveRequest(event.id, event.surfaceId)
            break
          case 'surface_destroyed':
            resolveRequest(event.id, undefined)
            break
          case 'size_result':
            resolveRequest(event.id, event.size)
            break
          case 'iosurface_result':
            resolveRequest(event.id, event.info)
            break
          case 'surfaces_list':
            // list_surfaces has no ID — resolve all pending list requests
            // (there should only be one at a time in practice)
            resolveRequest('list', event.surfaces)
            break
          case 'ok':
            resolveRequest(event.id, undefined)
            break
          case 'error':
            if (event.id !== undefined) {
              rejectRequest(event.id, new Error(event.message))
            } else {
              console.error(`[GhosttyHostClient] Host error: ${event.message}`)
            }
            break
          default:
            console.error(
              `[GhosttyHostClient] Unknown event type: ${(event as Record<string, unknown>).type}`
            )
            break
        }
      }

      /** Parse a single line of JSON into a GhosttyEvent and route it. */
      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (trimmed === '') {
          return
        }
        try {
          const event = JSON.parse(trimmed) as GhosttyEvent
          if (event.type === 'ready') {
            runFork(
              Deferred.succeed(readyDeferred, (event as ReadyEvent).version)
            )
            return
          }
          routeEvent(event)
        } catch {
          console.error(
            `[GhosttyHostClient] Failed to parse event: ${trimmed.slice(0, 200)}`
          )
        }
      }

      /**
       * Read stdout from the Ghostty Host as newline-delimited text.
       * Uses an array-based accumulator to avoid O(n^2) string copying.
       */
      const stdoutChunks: string[] = []

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString('utf-8'))
        drainLines()
      })

      child.stdout?.on('end', () => {
        const remaining = stdoutChunks.join('').trim()
        stdoutChunks.length = 0
        if (remaining !== '') {
          processLine(remaining)
        }
      })

      child.stdout?.on('error', (error: Error) => {
        console.error(
          `[GhosttyHostClient] stdout reader error: ${String(error)}`
        )
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

        if (searchStart < joined.length) {
          stdoutChunks.push(joined.slice(searchStart))
        }
      }

      // Monitor Ghostty Host process for crashes via the 'exit' event.
      child.on('exit', (exitCode) => {
        console.error(
          `[GhosttyHostClient] Ghostty Host process exited with code ${exitCode}`
        )

        // Signal ready failure if the process dies before becoming ready
        runFork(
          Deferred.fail(
            readyDeferred,
            new Error(`Ghostty Host exited with code ${exitCode} before ready`)
          )
        )

        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          pending.reject(
            new Error(`Ghostty Host exited while request ${id} was pending`)
          )
        }
        pendingRequests.clear()

        // Notify crash callbacks
        for (const cb of crashCallbacks) {
          try {
            cb()
          } catch (error) {
            console.error(
              `[GhosttyHostClient] Crash callback error: ${String(error)}`
            )
          }
        }
      })

      // Wait for the Ghostty Host to emit the `ready` event
      const version = yield* Deferred.await(readyDeferred).pipe(
        Effect.catchAll((error) =>
          Effect.die(
            new Error(`GhosttyHostClient failed to start: ${error.message}`)
          )
        )
      )

      // Register teardown: kill the Ghostty Host when the layer is destroyed
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            child.kill()
          } catch {
            // Best effort — process may have already exited
          }
        })
      )

      return GhosttyHostClient.of({
        version,

        createSurface: (options) => {
          const id = generateId()
          return sendRequest<number>({
            type: 'create_surface',
            id,
            options,
          })
        },

        destroySurface: (surfaceId) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'destroy_surface',
            id,
            surfaceId,
          })
        },

        setSurfaceSize: (surfaceId, width, height) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'set_size',
            id,
            surfaceId,
            width,
            height,
          })
        },

        setSurfaceFocus: (surfaceId, focused) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'set_focus',
            id,
            surfaceId,
            focused,
          })
        },

        getIOSurfaceId: (surfaceId) => {
          const id = generateId()
          return sendRequest<IOSurfaceInfo>({
            type: 'get_iosurface',
            id,
            surfaceId,
          })
        },

        getSurfaceSize: (surfaceId) => {
          const id = generateId()
          return sendRequest<SurfaceSize>({
            type: 'get_size',
            id,
            surfaceId,
          })
        },

        listSurfaces: () =>
          sendRequest<readonly number[]>({
            type: 'list_surfaces',
            id: 'list',
          }),

        onCrash: (callback) => {
          crashCallbacks.push(callback)
        },
      })
    })
  )
}

export { GhosttyHostClient }
export type { CrashCallback }
