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
