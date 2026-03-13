/**
 * Ghostty Host — Isolated helper process for the Ghostty terminal runtime.
 *
 * This script runs as a standalone Node.js subprocess, completely isolated
 * from the Electron main process. It communicates via newline-delimited
 * JSON over stdin (commands) and stdout (events). stderr is used for debug
 * logging.
 *
 * Why isolated process: Ghostty requires native AppKit/Metal surfaces
 * (NSWindow, NSView, CAMetalLayer) for rendering. Running this in a
 * dedicated process keeps the Electron main process free from native
 * rendering work, provides crash isolation, and follows the existing
 * sidecar pattern used by the terminal/PTY host.
 *
 * Architecture:
 * - Loads the native @laborer/ghostty addon on startup
 * - Initializes the Ghostty runtime and creates the app
 * - Runs a periodic tick timer to process Ghostty events
 * - Accepts commands to create/destroy/resize/focus surfaces
 * - Reports surface lifecycle and action events back to the parent
 *
 * IPC Protocol:
 *
 * Commands (stdin, parent -> Ghostty Host):
 *   { type: "create_surface", id: string, options?: CreateSurfaceOptions }
 *   { type: "destroy_surface", id: string, surfaceId: number }
 *   { type: "set_size", id: string, surfaceId: number, width: number, height: number }
 *   { type: "set_focus", id: string, surfaceId: number, focused: boolean }
 *   { type: "get_iosurface", id: string, surfaceId: number }
 *   { type: "get_size", id: string, surfaceId: number }
 *   { type: "list_surfaces" }
 *
 * Events (stdout, Ghostty Host -> parent):
 *   { type: "ready" }
 *   { type: "surface_created", id: string, surfaceId: number }
 *   { type: "surface_destroyed", id: string, surfaceId: number }
 *   { type: "size_result", id: string, surfaceId: number, size: SurfaceSize }
 *   { type: "iosurface_result", id: string, surfaceId: number, info: IOSurfaceInfo }
 *   { type: "surfaces_list", surfaces: number[] }
 *   { type: "error", id?: string, message: string }
 *   { type: "ok", id: string }
 */

import type {
  CreateSurfaceOptions,
  IOSurfaceInfo,
  SurfaceSize,
} from './index.ts'
import {
  appTick,
  createApp,
  createSurface,
  destroyApp,
  destroySurface,
  getInfo,
  getSurfaceIOSurfaceId,
  getSurfaceSize,
  init,
  listSurfaces,
  setSurfaceFocus,
  setSurfaceSize,
} from './index.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between Ghostty runtime ticks (ms). */
const TICK_INTERVAL_MS = 16 // ~60fps

// ---------------------------------------------------------------------------
// Types — Commands
// ---------------------------------------------------------------------------

interface CreateSurfaceCommand {
  readonly id: string
  readonly options?: CreateSurfaceOptions
  readonly type: 'create_surface'
}

interface DestroySurfaceCommand {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'destroy_surface'
}

interface SetSizeCommand {
  readonly height: number
  readonly id: string
  readonly surfaceId: number
  readonly type: 'set_size'
  readonly width: number
}

interface SetFocusCommand {
  readonly focused: boolean
  readonly id: string
  readonly surfaceId: number
  readonly type: 'set_focus'
}

interface GetIOSurfaceCommand {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'get_iosurface'
}

interface GetSizeCommand {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'get_size'
}

interface ListSurfacesCommand {
  readonly type: 'list_surfaces'
}

type Command =
  | CreateSurfaceCommand
  | DestroySurfaceCommand
  | SetSizeCommand
  | SetFocusCommand
  | GetIOSurfaceCommand
  | GetSizeCommand
  | ListSurfacesCommand

// ---------------------------------------------------------------------------
// Types — Events
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON event to stdout (one line per event). */
function emit(event: GhosttyEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** Log to stderr for debugging (not part of IPC protocol). */
function debug(message: string, ...args: unknown[]): void {
  console.error(`[ghostty-host] ${message}`, ...args)
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function handleCreateSurface(cmd: CreateSurfaceCommand): void {
  try {
    const handle = createSurface(cmd.options)
    emit({
      type: 'surface_created',
      id: cmd.id,
      surfaceId: handle.id,
    })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to create surface: ${String(error)}`,
    })
  }
}

function handleDestroySurface(cmd: DestroySurfaceCommand): void {
  try {
    destroySurface(cmd.surfaceId)
    emit({
      type: 'surface_destroyed',
      id: cmd.id,
      surfaceId: cmd.surfaceId,
    })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to destroy surface ${cmd.surfaceId}: ${String(error)}`,
    })
  }
}

function handleSetSize(cmd: SetSizeCommand): void {
  try {
    setSurfaceSize(cmd.surfaceId, cmd.width, cmd.height)
    emit({ type: 'ok', id: cmd.id })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to set size for surface ${cmd.surfaceId}: ${String(error)}`,
    })
  }
}

function handleSetFocus(cmd: SetFocusCommand): void {
  try {
    setSurfaceFocus(cmd.surfaceId, cmd.focused)
    emit({ type: 'ok', id: cmd.id })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to set focus for surface ${cmd.surfaceId}: ${String(error)}`,
    })
  }
}

function handleGetIOSurface(cmd: GetIOSurfaceCommand): void {
  try {
    const info = getSurfaceIOSurfaceId(cmd.surfaceId)
    emit({
      type: 'iosurface_result',
      id: cmd.id,
      surfaceId: cmd.surfaceId,
      info,
    })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to get IOSurface for surface ${cmd.surfaceId}: ${String(error)}`,
    })
  }
}

function handleGetSize(cmd: GetSizeCommand): void {
  try {
    const size = getSurfaceSize(cmd.surfaceId)
    emit({
      type: 'size_result',
      id: cmd.id,
      surfaceId: cmd.surfaceId,
      size,
    })
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to get size for surface ${cmd.surfaceId}: ${String(error)}`,
    })
  }
}

function handleListSurfaces(): void {
  try {
    const surfaces = listSurfaces()
    emit({ type: 'surfaces_list', surfaces })
  } catch (error) {
    emit({
      type: 'error',
      message: `Failed to list surfaces: ${String(error)}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Command validation and dispatch
// ---------------------------------------------------------------------------

function isValidCommand(parsed: unknown): parsed is Command {
  if (typeof parsed !== 'object' || parsed === null) {
    return false
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') {
    return false
  }

  switch (obj.type) {
    case 'create_surface':
      return typeof obj.id === 'string'
    case 'destroy_surface':
      return typeof obj.id === 'string' && typeof obj.surfaceId === 'number'
    case 'set_size':
      return (
        typeof obj.id === 'string' &&
        typeof obj.surfaceId === 'number' &&
        typeof obj.width === 'number' &&
        typeof obj.height === 'number'
      )
    case 'set_focus':
      return (
        typeof obj.id === 'string' &&
        typeof obj.surfaceId === 'number' &&
        typeof obj.focused === 'boolean'
      )
    case 'get_iosurface':
      return typeof obj.id === 'string' && typeof obj.surfaceId === 'number'
    case 'get_size':
      return typeof obj.id === 'string' && typeof obj.surfaceId === 'number'
    case 'list_surfaces':
      return true
    default:
      return false
  }
}

function processLine(line: string): void {
  const trimmed = line.trim()
  if (trimmed === '') {
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    emit({
      type: 'error',
      message: `Invalid JSON: ${trimmed.slice(0, 100)}`,
    })
    return
  }

  if (!isValidCommand(parsed)) {
    emit({
      type: 'error',
      message: `Invalid command: ${trimmed.slice(0, 100)}`,
    })
    return
  }

  switch (parsed.type) {
    case 'create_surface':
      handleCreateSurface(parsed)
      break
    case 'destroy_surface':
      handleDestroySurface(parsed)
      break
    case 'set_size':
      handleSetSize(parsed)
      break
    case 'set_focus':
      handleSetFocus(parsed)
      break
    case 'get_iosurface':
      handleGetIOSurface(parsed)
      break
    case 'get_size':
      handleGetSize(parsed)
      break
    case 'list_surfaces':
      handleListSurfaces()
      break
    default:
      emit({
        type: 'error',
        message: `Unknown command type: ${(parsed as Record<string, unknown>).type}`,
      })
      break
  }
}

// ---------------------------------------------------------------------------
// Stdin line reader
// ---------------------------------------------------------------------------

/**
 * Read stdin as newline-delimited text and process each line as a command.
 *
 * Uses an array-based accumulator to avoid O(n^2) string copying from
 * repeated `buffer += chunk` concatenation under high throughput.
 */
async function readStdin(): Promise<void> {
  const bufferChunks: string[] = []

  for await (const chunk of process.stdin) {
    bufferChunks.push(
      typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8')
    )

    const joined = bufferChunks.join('')
    bufferChunks.length = 0

    let searchStart = 0
    let newlineIdx = joined.indexOf('\n', searchStart)
    while (newlineIdx !== -1) {
      const line = joined.slice(searchStart, newlineIdx)
      processLine(line)
      searchStart = newlineIdx + 1
      newlineIdx = joined.indexOf('\n', searchStart)
    }

    if (searchStart < joined.length) {
      bufferChunks.push(joined.slice(searchStart))
    }
  }

  // Process any remaining data after stdin closes
  const remaining = bufferChunks.join('').trim()
  if (remaining !== '') {
    processLine(remaining)
  }

  debug('stdin closed, shutting down')
  shutdown()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(): void {
  debug('Shutting down')

  // Stop the tick timer
  if (tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }

  // Destroy all surfaces and the app
  try {
    destroyApp()
    debug('App destroyed')
  } catch {
    // Best effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  debug('Starting Ghostty Host (pid=%d)', process.pid)

  // Initialize the Ghostty runtime
  try {
    init()
    debug('Ghostty runtime initialized')
  } catch (error) {
    emit({
      type: 'error',
      message: `Failed to initialize Ghostty runtime: ${String(error)}`,
    })
    process.exit(1)
  }

  // Get version info for the ready event
  const info = getInfo()
  debug('Ghostty version: %s (%s)', info.version, info.buildMode)

  // Create the Ghostty app runtime
  try {
    createApp()
    debug('Ghostty app created')
  } catch (error) {
    emit({
      type: 'error',
      message: `Failed to create Ghostty app: ${String(error)}`,
    })
    process.exit(1)
  }

  // Start the periodic tick timer for Ghostty event processing
  tickTimer = setInterval(() => {
    try {
      appTick()
    } catch (error) {
      debug('Tick error: %s', String(error))
    }
  }, TICK_INTERVAL_MS)
  tickTimer.unref()

  // Signal readiness to the parent process
  emit({ type: 'ready', version: info.version })
  debug('Ready')

  // Start reading commands from stdin
  await readStdin()
}

// Handle graceful shutdown signals
process.on('SIGTERM', () => {
  debug('Received SIGTERM')
  shutdown()
  process.exit(0)
})

process.on('SIGINT', () => {
  debug('Received SIGINT')
  shutdown()
  process.exit(0)
})

main().catch((error) => {
  debug('Fatal error: %s', String(error))
  emit({
    type: 'error',
    message: `Ghostty Host fatal error: ${String(error)}`,
  })
  process.exit(1)
})
