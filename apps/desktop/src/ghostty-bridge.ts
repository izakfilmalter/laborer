/**
 * GhosttyBridge — Relays Ghostty surface commands from the Electron renderer
 * to the Ghostty Host sidecar process via stdin/stdout JSON IPC.
 *
 * The renderer cannot communicate directly with the Ghostty Host process
 * because it runs in a sandboxed context with `contextIsolation: true` and
 * `nodeIntegration: false`. This bridge sits in the main process, registers
 * ipcMain.handle() handlers for Ghostty channels, and forwards commands
 * to the sidecar's stdin. Responses are correlated by request ID and
 * returned to the renderer.
 *
 * The bridge attaches to the sidecar's stdout stream to parse JSON events.
 * When the sidecar restarts (via HealthMonitor), the bridge must be
 * re-attached to the new process via `attach()`.
 *
 * @see packages/ghostty/src/ghostty-host.ts — IPC protocol spec
 * @see apps/desktop/src/sidecar.ts — SidecarManager
 */

import type { ChildProcess } from 'node:child_process'
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline'

import { ipcMain } from 'electron'

// ---------------------------------------------------------------------------
// IPC channel constants (must match preload.ts)
// ---------------------------------------------------------------------------

export const GHOSTTY_CREATE_SURFACE_CHANNEL = 'ghostty:create-surface'
export const GHOSTTY_DESTROY_SURFACE_CHANNEL = 'ghostty:destroy-surface'
export const GHOSTTY_SET_SIZE_CHANNEL = 'ghostty:set-size'
export const GHOSTTY_SET_FOCUS_CHANNEL = 'ghostty:set-focus'
export const GHOSTTY_LIST_SURFACES_CHANNEL = 'ghostty:list-surfaces'
export const GHOSTTY_SEND_KEY_CHANNEL = 'ghostty:send-key'
export const GHOSTTY_SEND_TEXT_CHANNEL = 'ghostty:send-text'

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly reject: (reason: Error) => void
  readonly resolve: (value: unknown) => void
}

// ---------------------------------------------------------------------------
// GhosttyBridge
// ---------------------------------------------------------------------------

/**
 * Bridges Ghostty surface lifecycle commands from renderer IPC to the
 * Ghostty Host sidecar process.
 */
export class GhosttyBridge {
  private child: ChildProcess | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private nextId = 1
  private stdoutRl: ReadlineInterface | null = null
  private ready = false

  /**
   * Attach to a Ghostty Host sidecar process.
   * Reads JSON events from stdout and correlates them with pending requests.
   * Call this after the sidecar is spawned or restarted.
   */
  attach(child: ChildProcess): void {
    this.detach()
    this.child = child
    this.ready = false

    if (child.stdout) {
      this.stdoutRl = createInterface({ input: child.stdout })
      this.stdoutRl.on('line', (line: string) => {
        this.processLine(line)
      })
    }

    // Reject all pending requests if the process exits.
    child.once('exit', () => {
      this.rejectAll(new Error('Ghostty Host process exited'))
      this.child = null
      this.ready = false
    })
  }

  /** Detach from the current sidecar process. */
  detach(): void {
    this.stdoutRl?.close()
    this.stdoutRl = null
    this.rejectAll(new Error('GhosttyBridge detached'))
    this.child = null
    this.ready = false
  }

  /** Whether the bridge is connected and the Ghostty Host has sent `ready`. */
  get isReady(): boolean {
    return this.ready && this.child !== null
  }

  /**
   * Register ipcMain.handle() handlers for all Ghostty channels.
   * Should be called once during app bootstrap.
   */
  registerIpcHandlers(): void {
    ipcMain.removeHandler(GHOSTTY_CREATE_SURFACE_CHANNEL)
    ipcMain.handle(
      GHOSTTY_CREATE_SURFACE_CHANNEL,
      async (
        _event,
        options?: {
          width?: number
          height?: number
          workingDirectory?: string
          command?: string
        }
      ) => {
        return await this.createSurface(options)
      }
    )

    ipcMain.removeHandler(GHOSTTY_DESTROY_SURFACE_CHANNEL)
    ipcMain.handle(
      GHOSTTY_DESTROY_SURFACE_CHANNEL,
      async (_event, surfaceId: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        return await this.destroySurface(surfaceId)
      }
    )

    ipcMain.removeHandler(GHOSTTY_SET_SIZE_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SET_SIZE_CHANNEL,
      async (_event, surfaceId: unknown, width: unknown, height: unknown) => {
        if (
          typeof surfaceId !== 'number' ||
          typeof width !== 'number' ||
          typeof height !== 'number'
        ) {
          throw new Error('surfaceId, width, and height must be numbers')
        }
        return await this.setSurfaceSize(surfaceId, width, height)
      }
    )

    ipcMain.removeHandler(GHOSTTY_SET_FOCUS_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SET_FOCUS_CHANNEL,
      async (_event, surfaceId: unknown, focused: unknown) => {
        if (typeof surfaceId !== 'number' || typeof focused !== 'boolean') {
          throw new Error(
            'surfaceId must be a number and focused must be a boolean'
          )
        }
        return await this.setSurfaceFocus(surfaceId, focused)
      }
    )

    ipcMain.removeHandler(GHOSTTY_LIST_SURFACES_CHANNEL)
    ipcMain.handle(GHOSTTY_LIST_SURFACES_CHANNEL, async () => {
      return await this.listSurfaces()
    })

    ipcMain.removeHandler(GHOSTTY_SEND_KEY_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SEND_KEY_CHANNEL,
      async (_event, surfaceId: unknown, keyEvent: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        if (typeof keyEvent !== 'object' || keyEvent === null) {
          throw new Error('keyEvent must be an object')
        }
        return await this.sendKey(
          surfaceId,
          keyEvent as Record<string, unknown>
        )
      }
    )

    ipcMain.removeHandler(GHOSTTY_SEND_TEXT_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SEND_TEXT_CHANNEL,
      async (_event, surfaceId: unknown, text: unknown) => {
        if (typeof surfaceId !== 'number' || typeof text !== 'string') {
          throw new Error(
            'surfaceId must be a number and text must be a string'
          )
        }
        return await this.sendText(surfaceId, text)
      }
    )
  }

  // -----------------------------------------------------------------------
  // Public API — called by ipcMain handlers
  // -----------------------------------------------------------------------

  async createSurface(options?: {
    width?: number
    height?: number
    workingDirectory?: string
    command?: string
  }): Promise<number> {
    this.ensureReady()
    const id = this.generateId()
    return await this.sendRequest<number>({
      type: 'create_surface',
      id,
      options,
    })
  }

  async destroySurface(surfaceId: number): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({ type: 'destroy_surface', id, surfaceId })
  }

  async setSurfaceSize(
    surfaceId: number,
    width: number,
    height: number
  ): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({
      type: 'set_size',
      id,
      surfaceId,
      width,
      height,
    })
  }

  async setSurfaceFocus(surfaceId: number, focused: boolean): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({ type: 'set_focus', id, surfaceId, focused })
  }

  async sendKey(
    surfaceId: number,
    keyEvent: Record<string, unknown>
  ): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({
      type: 'send_key',
      id,
      surfaceId,
      keyEvent,
    })
  }

  async sendText(surfaceId: number, text: string): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({ type: 'send_text', id, surfaceId, text })
  }

  async listSurfaces(): Promise<readonly number[]> {
    this.ensureReady()
    return await this.sendRequest<readonly number[]>({
      type: 'list_surfaces',
      id: 'list',
    })
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private generateId(): string {
    const id = `bridge-${this.nextId}`
    this.nextId += 1
    return id
  }

  private ensureReady(): void {
    if (!this.child) {
      throw new Error('GhosttyBridge: not attached to a sidecar process')
    }
    if (!this.ready) {
      throw new Error('GhosttyBridge: Ghostty Host not ready yet')
    }
  }

  private sendCommand(command: Record<string, unknown>): void {
    const line = `${JSON.stringify(command)}\n`
    this.child?.stdin?.write(line)
  }

  private sendRequest<T>(command: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = command.id as string
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.sendCommand(command)
    })
  }

  private processLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') {
      return
    }

    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }

    if (event.type === 'ready') {
      this.ready = true
      return
    }

    this.routeEvent(event)
  }

  private routeEvent(event: Record<string, unknown>): void {
    const id = event.id as string | undefined

    switch (event.type) {
      case 'surface_created':
        if (id) {
          this.resolveRequest(id, event.surfaceId)
        }
        break
      case 'surface_destroyed':
        if (id) {
          this.resolveRequest(id, undefined)
        }
        break
      case 'ok':
        if (id) {
          this.resolveRequest(id, undefined)
        }
        break
      case 'surfaces_list':
        this.resolveRequest('list', event.surfaces)
        break
      case 'error':
        if (id) {
          this.rejectRequest(id, new Error(event.message as string))
        }
        break
      default:
        // Other events (size_result, iosurface_result, etc.) are not used
        // by the renderer bridge currently.
        if (id && typeof id === 'string') {
          this.resolveRequest(id, event)
        }
        break
    }
  }

  private resolveRequest(id: string, value: unknown): void {
    const pending = this.pendingRequests.get(id)
    if (pending) {
      this.pendingRequests.delete(id)
      pending.resolve(value)
    }
  }

  private rejectRequest(id: string, error: Error): void {
    const pending = this.pendingRequests.get(id)
    if (pending) {
      this.pendingRequests.delete(id)
      pending.reject(error)
    }
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }
}
