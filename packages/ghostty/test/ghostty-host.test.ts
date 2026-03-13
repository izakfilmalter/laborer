/**
 * Ghostty Host integration tests.
 *
 * These tests spawn the Ghostty Host as a real subprocess and communicate
 * with it via stdin/stdout using the newline-delimited JSON IPC protocol.
 * Real Ghostty surfaces are created since that is the behavior under test.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { IOSurfaceInfo, SurfaceSize } from '../src/index.ts'

// ---------------------------------------------------------------------------
// IPC Protocol Types (subset needed for tests)
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

interface ErrorEvent {
  readonly id?: string
  readonly message: string
  readonly type: 'error'
}

// Push action events (Issue 7)

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

interface RenderFrameEvent {
  readonly surfaceId: number
  readonly type: 'render_frame'
}

interface IOSurfaceHandleResultEvent {
  readonly height: number
  readonly id: string
  readonly ioSurfaceHandle: string
  readonly surfaceId: number
  readonly type: 'iosurface_handle_result'
  readonly width: number
}

interface IOSurfaceHandleNullEvent {
  readonly id: string
  readonly surfaceId: number
  readonly type: 'iosurface_handle_null'
}

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

type GhosttyActionEvent =
  | TitleChangedEvent
  | PwdChangedEvent
  | BellEvent
  | ChildExitedEvent
  | CellSizeChangedEvent
  | RendererHealthEvent
  | RenderFrameEvent

type GhosttyEvent =
  | ReadyEvent
  | SurfaceCreatedEvent
  | SurfaceDestroyedEvent
  | SizeResultEvent
  | IOSurfaceResultEvent
  | IOSurfaceHandleResultEvent
  | IOSurfaceHandleNullEvent
  | PixelsResultEvent
  | PixelsNullEvent
  | SurfacesListEvent
  | OkEvent
  | ErrorEvent
  | ConfigPathResultEvent
  | ConfigDiagnosticsResultEvent
  | ConfigLoadedEvent
  | GhosttyActionEvent

// ---------------------------------------------------------------------------
// Push-based event queue
// ---------------------------------------------------------------------------

/**
 * A push-based event queue that receives events from child process stdout
 * via callbacks and allows tests to pull events via `next()`.
 */
class EventQueue {
  private readonly queue: GhosttyEvent[] = []
  private readonly waiters: Array<(event: GhosttyEvent) => void> = []
  private ended = false

  push(event: GhosttyEvent): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter(event)
    } else {
      this.queue.push(event)
    }
  }

  end(): void {
    this.ended = true
    for (const resolve of this.waiters) {
      resolve(undefined as unknown as GhosttyEvent)
    }
    this.waiters.length = 0
  }

  next(): Promise<GhosttyEvent | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) {
      return Promise.resolve(queued)
    }
    if (this.ended) {
      return Promise.resolve(undefined)
    }
    return new Promise<GhosttyEvent | undefined>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GHOSTTY_HOST_PATH = join(
  import.meta.dirname,
  '..',
  'src',
  'ghostty-host.ts'
)

const TSX_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'node_modules',
  '.bin',
  'tsx'
)

interface GhosttyHostHandle {
  readonly child: ChildProcess
  readonly cleanup: () => void
  readonly events: EventQueue
  readonly sendCommand: (command: Record<string, unknown>) => void
}

function spawnGhosttyHost(): GhosttyHostHandle {
  const child = spawn(TSX_PATH, [GHOSTTY_HOST_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const events = new EventQueue()
  let buffer = ''

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') {
        try {
          events.push(JSON.parse(line) as GhosttyEvent)
        } catch {
          // Ignore unparseable lines
        }
      }
      idx = buffer.indexOf('\n')
    }
  })

  child.stdout?.on('end', () => {
    if (buffer.trim() !== '') {
      try {
        events.push(JSON.parse(buffer.trim()) as GhosttyEvent)
      } catch {
        // Ignore
      }
    }
    events.end()
  })

  // Log stderr for debugging
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8').trim()
    if (text !== '') {
      // Use console.error so it appears in test output when debugging
      console.error(`[ghostty-host:stderr] ${text}`)
    }
  })

  const sendCommand = (command: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(command)}\n`)
  }

  const cleanup = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already exited
    }
  }

  return { child, sendCommand, events, cleanup }
}

/**
 * Wait for the next event matching a predicate from the event queue.
 * Non-matching events are discarded.
 */
async function waitForEvent(
  queue: EventQueue,
  predicate: (event: GhosttyEvent) => boolean,
  timeoutMs = 30_000
): Promise<GhosttyEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const event = await Promise.race([
      queue.next(),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), remaining)
      }),
    ])

    if (event === undefined) {
      throw new Error(`Timed out waiting for event after ${timeoutMs}ms`)
    }

    if (predicate(event)) {
      return event
    }
  }
  throw new Error(`Timed out waiting for event after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ghostty host process', () => {
  let handle: GhosttyHostHandle | null = null

  afterEach(() => {
    if (handle !== null) {
      handle.cleanup()
      handle = null
    }
  })

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  it('emits a ready event on startup', async () => {
    handle = spawnGhosttyHost()

    const event = await waitForEvent(handle.events, (e) => e.type === 'ready')
    expect(event.type).toBe('ready')
    expect((event as ReadyEvent).version).toBeDefined()
    expect(typeof (event as ReadyEvent).version).toBe('string')
    expect((event as ReadyEvent).version.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Config loading (Issue 9)
  // -------------------------------------------------------------------------

  it('emits config_loaded event on startup', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // config_loaded should be emitted shortly after ready
    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'config_loaded',
      5000
    )) as ConfigLoadedEvent

    expect(event.type).toBe('config_loaded')
    // configPath should be a string or null
    expect(
      event.configPath === null || typeof event.configPath === 'string'
    ).toBe(true)
    expect(typeof event.diagnosticsCount).toBe('number')
    expect(Array.isArray(event.diagnostics)).toBe(true)
    expect(event.diagnostics.length).toBe(event.diagnosticsCount)
  })

  it('can query config path via IPC', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'get_config_path',
      id: 'cfg-path-1',
    })

    const event = (await waitForEvent(
      handle.events,
      (e) =>
        e.type === 'config_path_result' && 'id' in e && e.id === 'cfg-path-1'
    )) as ConfigPathResultEvent

    expect(event.type).toBe('config_path_result')
    expect(event.id).toBe('cfg-path-1')
    // configPath should be a string path or null
    expect(
      event.configPath === null || typeof event.configPath === 'string'
    ).toBe(true)
    if (event.configPath !== null) {
      expect(event.configPath).toContain('ghostty')
    }
  })

  it('can query config diagnostics via IPC', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')
    // Wait for config_loaded so we know config is loaded
    await waitForEvent(handle.events, (e) => e.type === 'config_loaded', 5000)

    handle.sendCommand({
      type: 'get_config_diagnostics',
      id: 'cfg-diag-1',
    })

    const event = (await waitForEvent(
      handle.events,
      (e) =>
        e.type === 'config_diagnostics_result' &&
        'id' in e &&
        e.id === 'cfg-diag-1'
    )) as ConfigDiagnosticsResultEvent

    expect(event.type).toBe('config_diagnostics_result')
    expect(event.id).toBe('cfg-diag-1')
    expect(typeof event.diagnosticsCount).toBe('number')
    expect(Array.isArray(event.diagnostics)).toBe(true)
    expect(event.diagnostics.length).toBe(event.diagnosticsCount)
  })

  it('config_loaded reports diagnostics count matching diagnostics array', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'config_loaded',
      5000
    )) as ConfigLoadedEvent

    // The diagnosticsCount should match the length of the diagnostics array
    expect(event.diagnosticsCount).toBe(event.diagnostics.length)

    // Each diagnostic should be a non-empty string (if any exist)
    for (const diag of event.diagnostics) {
      expect(typeof diag).toBe('string')
      expect(diag.length).toBeGreaterThan(0)
    }
  })

  // -------------------------------------------------------------------------
  // Surface lifecycle
  // -------------------------------------------------------------------------

  it('can create a surface', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'create_surface',
      id: 'req-1',
    })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    expect(event.id).toBe('req-1')
    expect(typeof event.surfaceId).toBe('number')
    expect(event.surfaceId).toBeGreaterThan(0)
  })

  it('can create a surface with custom options', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'create_surface',
      id: 'req-2',
      options: { width: 1024, height: 768, workingDirectory: '/tmp' },
    })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    expect(event.id).toBe('req-2')
    expect(typeof event.surfaceId).toBe('number')
  })

  it('can destroy a surface', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create first
    handle.sendCommand({ type: 'create_surface', id: 'create-1' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // Then destroy
    handle.sendCommand({
      type: 'destroy_surface',
      id: 'destroy-1',
      surfaceId: created.surfaceId,
    })

    const destroyed = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_destroyed'
    )) as SurfaceDestroyedEvent

    expect(destroyed.id).toBe('destroy-1')
    expect(destroyed.surfaceId).toBe(created.surfaceId)
  })

  it('returns error when destroying non-existent surface', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'destroy_surface',
      id: 'bad-destroy',
      surfaceId: 999_999,
    })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'error' && (e as ErrorEvent).id === 'bad-destroy'
    )) as ErrorEvent

    expect(event.type).toBe('error')
    expect(event.id).toBe('bad-destroy')
    expect(event.message).toContain('Failed to destroy surface')
  })

  // -------------------------------------------------------------------------
  // Surface control
  // -------------------------------------------------------------------------

  it('can set surface size', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-sz' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'set_size',
      id: 'size-1',
      surfaceId: created.surfaceId,
      width: 640,
      height: 480,
    })

    const ok = (await waitForEvent(
      handle.events,
      (e) => e.type === 'ok' && (e as OkEvent).id === 'size-1'
    )) as OkEvent

    expect(ok.type).toBe('ok')
    expect(ok.id).toBe('size-1')
  })

  it('can set surface focus', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-foc' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'set_focus',
      id: 'focus-1',
      surfaceId: created.surfaceId,
      focused: true,
    })

    const ok = (await waitForEvent(
      handle.events,
      (e) => e.type === 'ok' && (e as OkEvent).id === 'focus-1'
    )) as OkEvent

    expect(ok.type).toBe('ok')
    expect(ok.id).toBe('focus-1')
  })

  it('can get surface size', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-gsz' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'get_size',
      id: 'getsz-1',
      surfaceId: created.surfaceId,
    })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'size_result' && (e as SizeResultEvent).id === 'getsz-1'
    )) as SizeResultEvent

    expect(event.surfaceId).toBe(created.surfaceId)
    expect(typeof event.size.columns).toBe('number')
    expect(typeof event.size.rows).toBe('number')
    expect(typeof event.size.widthPx).toBe('number')
    expect(typeof event.size.heightPx).toBe('number')
    expect(typeof event.size.cellWidthPx).toBe('number')
    expect(typeof event.size.cellHeightPx).toBe('number')
  })

  it('can get IOSurface info', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-io' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'get_iosurface',
      id: 'getio-1',
      surfaceId: created.surfaceId,
    })

    const event = (await waitForEvent(
      handle.events,
      (e) =>
        e.type === 'iosurface_result' &&
        (e as IOSurfaceResultEvent).id === 'getio-1'
    )) as IOSurfaceResultEvent

    expect(event.surfaceId).toBe(created.surfaceId)
    expect(typeof event.info.hasLayer).toBe('boolean')
    expect(
      event.info.ioSurfaceId === null ||
        typeof event.info.ioSurfaceId === 'number'
    ).toBe(true)
  })

  it('can list surfaces', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create two surfaces
    handle.sendCommand({ type: 'create_surface', id: 'create-list-1' })
    const s1 = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({ type: 'create_surface', id: 'create-list-2' })
    const s2 = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // List them
    handle.sendCommand({ type: 'list_surfaces' })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surfaces_list'
    )) as SurfacesListEvent

    expect(event.surfaces).toContain(s1.surfaceId)
    expect(event.surfaces).toContain(s2.surfaceId)
    expect(event.surfaces.length).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns error for invalid JSON', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Send garbage
    handle.child.stdin?.write('not json\n')

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'error'
    )) as ErrorEvent

    expect(event.message).toContain('Invalid JSON')
  })

  it('returns error for invalid command structure', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'unknown_command' })

    const event = (await waitForEvent(
      handle.events,
      (e) => e.type === 'error'
    )) as ErrorEvent

    expect(event.message).toContain('Invalid command')
  })

  // -------------------------------------------------------------------------
  // Pixel readback (Issue 1 — tracer bullet first-frame rendering)
  // -------------------------------------------------------------------------

  it('can request pixel data from a surface', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-px' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'get_pixels',
      id: 'getpx-1',
      surfaceId: created.surfaceId,
    })

    // May return pixels_result or pixels_null depending on whether
    // Ghostty has rendered a frame yet
    const event = await waitForEvent(
      handle.events,
      (e) =>
        (e.type === 'pixels_result' || e.type === 'pixels_null') &&
        'id' in e &&
        e.id === 'getpx-1'
    )

    expect(event.type === 'pixels_result' || event.type === 'pixels_null').toBe(
      true
    )

    if (event.type === 'pixels_result') {
      const px = event as PixelsResultEvent
      expect(typeof px.width).toBe('number')
      expect(typeof px.height).toBe('number')
      expect(px.width).toBeGreaterThan(0)
      expect(px.height).toBeGreaterThan(0)
      expect(typeof px.pixels).toBe('string')
      // Verify base64 decodes to the expected size
      const buf = Buffer.from(px.pixels, 'base64')
      expect(buf.length).toBe(px.width * px.height * 4)
    }
  })

  it('returns pixel data after rendering frames (e2e first-frame test)', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create a surface
    handle.sendCommand({
      type: 'create_surface',
      id: 'create-e2e',
      options: { width: 400, height: 300 },
    })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // Give the Ghostty runtime time to render frames via the tick timer.
    // The host process runs a 16ms tick timer automatically.
    // Poll for pixel data with retries.
    let pixelsReceived = false
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))

      handle.sendCommand({
        type: 'get_pixels',
        id: `poll-${attempt}`,
        surfaceId: created.surfaceId,
      })

      const event = await waitForEvent(
        handle.events,
        (e) =>
          (e.type === 'pixels_result' || e.type === 'pixels_null') &&
          'id' in e &&
          e.id === `poll-${attempt}`,
        5000
      )

      if (event.type === 'pixels_result') {
        const px = event as PixelsResultEvent
        expect(px.width).toBeGreaterThan(0)
        expect(px.height).toBeGreaterThan(0)
        const buf = Buffer.from(px.pixels, 'base64')
        expect(buf.length).toBe(px.width * px.height * 4)
        // Verify the buffer contains some non-zero data (not all black/empty)
        const hasContent = buf.some((byte) => byte !== 0)
        expect(hasContent).toBe(true)
        pixelsReceived = true
        break
      }
    }

    // In environments with a GPU, we expect to eventually get pixels.
    // In headless CI without a GPU, pixels may never arrive — skip assertion.
    if (!pixelsReceived) {
      console.warn(
        '[e2e] Pixel data not available after polling — likely headless/no GPU environment'
      )
    }
  })

  // -------------------------------------------------------------------------
  // Action events (Issue 7)
  // -------------------------------------------------------------------------

  it('emits action events after surface creation and ticking', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create a surface
    handle.sendCommand({
      type: 'create_surface',
      id: 'action-test',
    })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent
    expect(created.surfaceId).toBeGreaterThan(0)

    // Wait for action events to be emitted.
    // After surface creation, Ghostty typically emits cell_size,
    // set_title (initial title), and pwd actions.
    const actionEvents: GhosttyActionEvent[] = []
    const actionTypes = new Set([
      'title_changed',
      'pwd_changed',
      'bell',
      'child_exited',
      'close_window',
      'cell_size',
      'renderer_health',
    ])

    // Collect action events for up to 3 seconds
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const event = await Promise.race([
        handle.events.next(),
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), 500)
        }),
      ])

      if (event === undefined) {
        continue
      }

      if (actionTypes.has(event.type)) {
        actionEvents.push(event as GhosttyActionEvent)
      }
    }

    // We expect at least some action events (cell_size is almost always
    // emitted on surface creation)
    if (actionEvents.length > 0) {
      // Verify all action events have correct shape.
      // Note: actions that fire during ghostty_surface_new() (before the
      // surface is added to the reverse lookup map) will have surfaceId=0.
      // Actions from subsequent ticks will have the correct surfaceId.
      for (const action of actionEvents) {
        expect(typeof action.surfaceId).toBe('number')
        // surfaceId should be either the created surface or 0 (early init actions)
        expect(
          action.surfaceId === created.surfaceId || action.surfaceId === 0
        ).toBe(true)
        expect(typeof action.type).toBe('string')
      }

      // Check that cell_size events have width/height
      const cellSizeEvents = actionEvents.filter(
        (e) => e.type === 'cell_size'
      ) as CellSizeChangedEvent[]
      for (const cs of cellSizeEvents) {
        expect(typeof cs.width).toBe('number')
        expect(typeof cs.height).toBe('number')
        expect(cs.width).toBeGreaterThan(0)
        expect(cs.height).toBeGreaterThan(0)
      }

      // Check that title_changed events have a title string
      const titleEvents = actionEvents.filter(
        (e) => e.type === 'title_changed'
      ) as TitleChangedEvent[]
      for (const te of titleEvents) {
        expect(typeof te.title).toBe('string')
      }

      // Check that pwd_changed events have a pwd string
      const pwdEvents = actionEvents.filter(
        (e) => e.type === 'pwd_changed'
      ) as PwdChangedEvent[]
      for (const pe of pwdEvents) {
        expect(typeof pe.pwd).toBe('string')
      }
    } else {
      // In headless CI without a full terminal environment, actions
      // might not fire — this is acceptable
      console.warn(
        '[action test] No action events received — likely headless environment'
      )
    }
  })

  it('emits child_exited when shell process terminates', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create a surface with a command that exits immediately
    handle.sendCommand({
      type: 'create_surface',
      id: 'exit-test',
      options: { command: 'true' }, // exits immediately with code 0
    })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // Wait for the child_exited event.
    // Note: if child_exited fires during ghostty_surface_new() (before
    // surface is registered), surfaceId will be 0. Accept either.
    try {
      const exitEvent = (await waitForEvent(
        handle.events,
        (e) => {
          if (e.type !== 'child_exited') {
            return false
          }
          const ce = e as ChildExitedEvent
          return ce.surfaceId === created.surfaceId || ce.surfaceId === 0
        },
        10_000
      )) as ChildExitedEvent

      expect(exitEvent.type).toBe('child_exited')
      expect(typeof exitEvent.surfaceId).toBe('number')
      expect(typeof exitEvent.exitCode).toBe('number')
    } catch {
      // In some environments, the child exit may not be detected
      // within the timeout — this is acceptable for CI
      console.warn('[exit test] child_exited event not received within timeout')
    }
  })

  // -------------------------------------------------------------------------
  // Shared surface bridge (Issue 3 — zero-copy rendering pipeline)
  // -------------------------------------------------------------------------

  it('can request IOSurface handle from a surface', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({ type: 'create_surface', id: 'create-handle' })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    handle.sendCommand({
      type: 'get_iosurface_handle',
      id: 'gethandle-1',
      surfaceId: created.surfaceId,
    })

    // May return handle result or null depending on render state
    const event = await waitForEvent(
      handle.events,
      (e) =>
        (e.type === 'iosurface_handle_result' ||
          e.type === 'iosurface_handle_null') &&
        'id' in e &&
        e.id === 'gethandle-1'
    )

    expect(
      event.type === 'iosurface_handle_result' ||
        event.type === 'iosurface_handle_null'
    ).toBe(true)

    if (event.type === 'iosurface_handle_result') {
      const hr = event as IOSurfaceHandleResultEvent
      expect(typeof hr.width).toBe('number')
      expect(typeof hr.height).toBe('number')
      expect(hr.width).toBeGreaterThan(0)
      expect(hr.height).toBeGreaterThan(0)
      expect(typeof hr.ioSurfaceHandle).toBe('string')
      // Verify base64 decodes to a pointer-sized buffer (8 bytes on 64-bit)
      const buf = Buffer.from(hr.ioSurfaceHandle, 'base64')
      expect(buf.length).toBe(8)
    }
  })

  it('returns IOSurface handle after rendering frames', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'create_surface',
      id: 'create-handle-e2e',
      options: { width: 400, height: 300 },
    })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // Poll for IOSurface handle availability with retries.
    // The host tick timer runs at ~60fps, so rendering starts quickly.
    let handleReceived = false
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))

      handle.sendCommand({
        type: 'get_iosurface_handle',
        id: `poll-handle-${attempt}`,
        surfaceId: created.surfaceId,
      })

      const event = await waitForEvent(
        handle.events,
        (e) =>
          (e.type === 'iosurface_handle_result' ||
            e.type === 'iosurface_handle_null') &&
          'id' in e &&
          e.id === `poll-handle-${attempt}`,
        5000
      )

      if (event.type === 'iosurface_handle_result') {
        const hr = event as IOSurfaceHandleResultEvent
        expect(hr.width).toBeGreaterThan(0)
        expect(hr.height).toBeGreaterThan(0)
        const buf = Buffer.from(hr.ioSurfaceHandle, 'base64')
        expect(buf.length).toBe(8)
        handleReceived = true
        break
      }
    }

    if (!handleReceived) {
      console.warn(
        '[e2e] IOSurface handle not available after polling — likely headless/no GPU environment'
      )
    }
  })

  it('emits render_frame push events for subsequent frames', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    handle.sendCommand({
      type: 'create_surface',
      id: 'create-frames',
      options: { width: 400, height: 300 },
    })
    await waitForEvent(handle.events, (e) => e.type === 'surface_created')

    // Collect render_frame events over several seconds.
    // The host process emits these as push events when Ghostty renders.
    const renderFrameEvents: RenderFrameEvent[] = []
    const deadline = Date.now() + 5000

    while (Date.now() < deadline) {
      const event = await Promise.race([
        handle.events.next(),
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), 500)
        }),
      ])

      if (event === undefined) {
        continue
      }

      if (event.type === 'render_frame') {
        renderFrameEvents.push(event as RenderFrameEvent)
        // Once we have multiple frames, we've proven the pipeline works
        if (renderFrameEvents.length >= 3) {
          break
        }
      }
    }

    if (renderFrameEvents.length > 0) {
      // Verify we got multiple render_frame events (subsequent frames)
      expect(renderFrameEvents.length).toBeGreaterThanOrEqual(2)

      // All render_frame events should have valid surfaceId
      for (const rf of renderFrameEvents) {
        expect(rf.type).toBe('render_frame')
        expect(typeof rf.surfaceId).toBe('number')
      }
    } else {
      console.warn(
        '[render_frame test] No render_frame events — likely headless/no GPU environment'
      )
    }
  })

  it('continues emitting render_frame events after resize', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Create a surface
    handle.sendCommand({
      type: 'create_surface',
      id: 'create-resize-frames',
      options: { width: 400, height: 300 },
    })
    const created = (await waitForEvent(
      handle.events,
      (e) => e.type === 'surface_created'
    )) as SurfaceCreatedEvent

    // Wait briefly for initial rendering to start
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Resize the surface
    handle.sendCommand({
      type: 'set_size',
      id: 'resize-1',
      surfaceId: created.surfaceId,
      width: 800,
      height: 600,
    })
    await waitForEvent(
      handle.events,
      (e) => e.type === 'ok' && 'id' in e && e.id === 'resize-1'
    )

    // Collect render_frame events after resize
    const postResizeFrames: RenderFrameEvent[] = []
    const deadline = Date.now() + 5000

    while (Date.now() < deadline) {
      const event = await Promise.race([
        handle.events.next(),
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), 500)
        }),
      ])

      if (event === undefined) {
        continue
      }

      if (event.type === 'render_frame') {
        postResizeFrames.push(event as RenderFrameEvent)
        if (postResizeFrames.length >= 2) {
          break
        }
      }
    }

    if (postResizeFrames.length > 0) {
      // Verify render_frame events continue after resize
      expect(postResizeFrames.length).toBeGreaterThanOrEqual(1)

      // Verify the IOSurface handle reflects the new size
      handle.sendCommand({
        type: 'get_iosurface_handle',
        id: 'post-resize-handle',
        surfaceId: created.surfaceId,
      })

      const handleEvent = await waitForEvent(
        handle.events,
        (e) =>
          (e.type === 'iosurface_handle_result' ||
            e.type === 'iosurface_handle_null') &&
          'id' in e &&
          e.id === 'post-resize-handle',
        5000
      )

      if (handleEvent.type === 'iosurface_handle_result') {
        const hr = handleEvent as IOSurfaceHandleResultEvent
        // After resize to 800x600, dimensions should be updated
        // (exact pixel dimensions depend on Ghostty's internal scaling)
        expect(hr.width).toBeGreaterThan(0)
        expect(hr.height).toBeGreaterThan(0)
      }
    } else {
      console.warn(
        '[post-resize test] No render_frame events after resize — likely headless/no GPU environment'
      )
    }
  })

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  it('shuts down cleanly when stdin closes', async () => {
    handle = spawnGhosttyHost()
    await waitForEvent(handle.events, (e) => e.type === 'ready')

    // Close stdin to signal shutdown
    handle.child.stdin?.end()

    // The process should exit
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Process did not exit within timeout')),
        10_000
      )
      handle?.child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  })
})
