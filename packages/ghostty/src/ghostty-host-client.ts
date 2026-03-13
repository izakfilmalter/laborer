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
  KeyEvent,
  MouseButtonEvent,
  MousePosEvent,
  MouseScrollEvent,
  SurfacePixels,
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

interface PixelsResultEvent {
  readonly height: number
  readonly id: string
  readonly pixels: string
  readonly surfaceId: number
  readonly type: 'pixels_result'
  readonly width: number
}

interface PixelsNullEvent {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'pixels_null'
}

interface SurfacesListEvent {
  readonly surfaces: number[]
  readonly type: 'surfaces_list'
}

interface MouseCapturedResultEvent {
  readonly captured: boolean
  readonly id: string
  readonly surfaceId: number
  readonly type: 'mouse_captured_result'
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

// Push events — unsolicited events from Ghostty action callbacks

interface TitleChangedEvent {
  readonly surfaceId: number
  readonly title: string
  readonly type: 'title_changed'
}

interface PwdChangedEvent {
  readonly pwd: string
  readonly surfaceId: number
  readonly type: 'pwd_changed'
}

interface BellEvent {
  readonly surfaceId: number
  readonly type: 'bell'
}

interface ChildExitedEvent {
  readonly exitCode: number
  readonly surfaceId: number
  readonly type: 'child_exited'
}

interface CloseWindowEvent {
  readonly surfaceId: number
  readonly type: 'close_window'
}

interface CellSizeChangedEvent {
  readonly height: number
  readonly surfaceId: number
  readonly type: 'cell_size'
  readonly width: number
}

interface RendererHealthEvent {
  readonly healthy: boolean
  readonly surfaceId: number
  readonly type: 'renderer_health'
}

interface UnsupportedActionEvent {
  /** The unsupported action name (e.g., "mouse_shape", "new_split"). */
  readonly action: string
  /** Running count of this action since process start. */
  readonly count: number
  readonly surfaceId: number
  readonly type: 'unsupported_action'
}

// Config events

interface ConfigPathResultEvent {
  readonly configPath: string | null
  readonly id: string
  readonly type: 'config_path_result'
}

interface ConfigDiagnosticsResultEvent {
  readonly diagnostics: readonly string[]
  readonly diagnosticsCount: number
  readonly id: string
  readonly type: 'config_diagnostics_result'
}

interface ConfigLoadedEvent {
  readonly configPath: string | null
  readonly diagnostics: readonly string[]
  readonly diagnosticsCount: number
  readonly type: 'config_loaded'
}

/**
 * Config info received during Ghostty Host startup.
 */
interface GhosttyConfigInfo {
  readonly configPath: string | null
  readonly diagnostics: readonly string[]
  readonly diagnosticsCount: number
}

/**
 * Union of all push action events emitted by the Ghostty Host.
 * These are unsolicited (not in response to a command) and are forwarded
 * to registered action listeners.
 */
type GhosttyActionEvent =
  | TitleChangedEvent
  | PwdChangedEvent
  | BellEvent
  | ChildExitedEvent
  | CloseWindowEvent
  | CellSizeChangedEvent
  | RendererHealthEvent
  | UnsupportedActionEvent

type GhosttyEvent =
  | ReadyEvent
  | SurfaceCreatedEvent
  | SurfaceDestroyedEvent
  | SizeResultEvent
  | IOSurfaceResultEvent
  | PixelsResultEvent
  | PixelsNullEvent
  | MouseCapturedResultEvent
  | SurfacesListEvent
  | OkEvent
  | ErrorEvent
  | ConfigPathResultEvent
  | ConfigDiagnosticsResultEvent
  | ConfigLoadedEvent
  | GhosttyActionEvent

/** Callback invoked when the Ghostty Host process crashes. */
type CrashCallback = () => void

/** Callback invoked when the Ghostty Host emits an action event. */
type ActionCallback = (event: GhosttyActionEvent) => void

/** Set of action event type strings used for push event detection. */
const ACTION_EVENT_TYPES = new Set([
  'title_changed',
  'pwd_changed',
  'bell',
  'child_exited',
  'close_window',
  'cell_size',
  'renderer_health',
  'unsupported_action',
])

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
     * Read pixel data from a surface's IOSurface.
     * Returns null if Ghostty hasn't rendered a frame yet.
     * This is the tracer-bullet rendering path; Issue 3 replaces it
     * with zero-copy shared-texture display via WebGPU.
     */
    readonly getSurfacePixels: (
      surfaceId: number
    ) => Effect.Effect<SurfacePixels | null, Error>

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
     * Check whether the terminal has captured the mouse.
     * When captured, mouse events should be forwarded to the terminal.
     */
    readonly mouseCaptured: (surfaceId: number) => Effect.Effect<boolean, Error>

    /**
     * Register a callback invoked when the Ghostty Host emits an
     * action event (title change, pwd update, bell, child exit, etc.).
     * Multiple callbacks can be registered. All are invoked for each event.
     */
    readonly onAction: (callback: ActionCallback) => void

    /**
     * Register a callback invoked when the Ghostty Host process crashes.
     */
    readonly onCrash: (callback: CrashCallback) => void

    /**
     * Send a key event to a surface.
     */
    readonly sendKey: (
      surfaceId: number,
      keyEvent: KeyEvent
    ) => Effect.Effect<void, Error>

    /**
     * Send a mouse button event to a surface.
     */
    readonly sendMouseButton: (
      surfaceId: number,
      mouseEvent: MouseButtonEvent
    ) => Effect.Effect<void, Error>

    /**
     * Send a mouse position update to a surface.
     */
    readonly sendMousePos: (
      surfaceId: number,
      mouseEvent: MousePosEvent
    ) => Effect.Effect<void, Error>

    /**
     * Send a mouse scroll event to a surface.
     */
    readonly sendMouseScroll: (
      surfaceId: number,
      mouseEvent: MouseScrollEvent
    ) => Effect.Effect<void, Error>

    /**
     * Send composed text input to a surface.
     */
    readonly sendText: (
      surfaceId: number,
      text: string
    ) => Effect.Effect<void, Error>

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
     * Get the Ghostty config file path from the host process.
     */
    readonly getConfigPath: () => Effect.Effect<string | null, Error>

    /**
     * Get config diagnostics from the host process.
     */
    readonly getConfigDiagnostics: () => Effect.Effect<GhosttyConfigInfo, Error>

    /**
     * Config info received during Ghostty Host startup.
     * Populated when the host process emits the config_loaded event.
     */
    readonly configInfo: GhosttyConfigInfo

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
      const actionCallbacks: ActionCallback[] = []

      // Config info received during startup (populated by config_loaded event)
      let configInfo: GhosttyConfigInfo = {
        configPath: null,
        diagnostics: [],
        diagnosticsCount: 0,
      }

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

      /** Notify all registered action callbacks. */
      const notifyActionListeners = (event: GhosttyActionEvent): void => {
        for (const cb of actionCallbacks) {
          try {
            cb(event)
          } catch (error) {
            console.error(
              `[GhosttyHostClient] Action callback error: ${String(error)}`
            )
          }
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
          case 'pixels_result': {
            // Decode base64 pixel data back into a SurfacePixels object
            const pixelData: SurfacePixels = {
              width: event.width,
              height: event.height,
              data: Buffer.from(event.pixels, 'base64'),
            }
            resolveRequest(event.id, pixelData)
            break
          }
          case 'pixels_null':
            resolveRequest(event.id, null)
            break
          case 'mouse_captured_result':
            resolveRequest(event.id, event.captured)
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

          // Config events
          case 'config_path_result':
            resolveRequest(event.id, event.configPath)
            break
          case 'config_diagnostics_result':
            resolveRequest(event.id, {
              diagnostics: event.diagnostics,
              diagnosticsCount: event.diagnosticsCount,
            })
            break
          case 'config_loaded':
            // Config loaded push event — update stored config info
            configInfo = {
              configPath: event.configPath,
              diagnostics: event.diagnostics,
              diagnosticsCount: event.diagnosticsCount,
            }
            break

          // Push action events — forward to registered action callbacks
          case 'title_changed':
          case 'pwd_changed':
          case 'bell':
          case 'child_exited':
          case 'close_window':
          case 'cell_size':
          case 'renderer_health':
          case 'unsupported_action':
            notifyActionListeners(event)
            break

          default:
            if (ACTION_EVENT_TYPES.has((event as { type: string }).type)) {
              notifyActionListeners(event as GhosttyActionEvent)
            } else {
              console.error(
                `[GhosttyHostClient] Unknown event type: ${(event as { type: string }).type}`
              )
            }
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

        get configInfo() {
          return configInfo
        },

        getConfigPath: () => {
          const id = generateId()
          return sendRequest<string | null>({
            type: 'get_config_path',
            id,
          })
        },

        getConfigDiagnostics: () => {
          const id = generateId()
          return sendRequest<GhosttyConfigInfo>({
            type: 'get_config_diagnostics',
            id,
          })
        },

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

        getSurfacePixels: (surfaceId) => {
          const id = generateId()
          return sendRequest<SurfacePixels | null>({
            type: 'get_pixels',
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

        onAction: (callback) => {
          actionCallbacks.push(callback)
        },

        onCrash: (callback) => {
          crashCallbacks.push(callback)
        },

        mouseCaptured: (surfaceId) => {
          const id = generateId()
          return sendRequest<boolean>({
            type: 'mouse_captured',
            id,
            surfaceId,
          })
        },

        sendKey: (surfaceId, keyEvent) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'send_key',
            id,
            surfaceId,
            keyEvent,
          })
        },

        sendMouseButton: (surfaceId, mouseEvent) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'send_mouse_button',
            id,
            surfaceId,
            mouseEvent,
          })
        },

        sendMousePos: (surfaceId, mouseEvent) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'send_mouse_pos',
            id,
            surfaceId,
            mouseEvent,
          })
        },

        sendMouseScroll: (surfaceId, mouseEvent) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'send_mouse_scroll',
            id,
            surfaceId,
            mouseEvent,
          })
        },

        sendText: (surfaceId, text) => {
          const id = generateId()
          return sendRequest<void>({
            type: 'send_text',
            id,
            surfaceId,
            text,
          })
        },
      })
    })
  )
}

export { GhosttyHostClient }
export type {
  ActionCallback,
  CrashCallback,
  GhosttyActionEvent,
  GhosttyConfigInfo,
}
