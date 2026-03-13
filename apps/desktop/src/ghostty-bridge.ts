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

import { lookupIOSurfaceHandleById } from '@laborer/ghostty'
import { BrowserWindow, ipcMain, sharedTexture } from 'electron'

// ---------------------------------------------------------------------------
// IPC channel constants (must match preload.ts)
// ---------------------------------------------------------------------------

export const GHOSTTY_CREATE_SURFACE_CHANNEL = 'ghostty:create-surface'
export const GHOSTTY_DESTROY_SURFACE_CHANNEL = 'ghostty:destroy-surface'
export const GHOSTTY_GET_PIXELS_CHANNEL = 'ghostty:get-pixels'
export const GHOSTTY_SET_SIZE_CHANNEL = 'ghostty:set-size'
export const GHOSTTY_SET_FOCUS_CHANNEL = 'ghostty:set-focus'
export const GHOSTTY_LIST_SURFACES_CHANNEL = 'ghostty:list-surfaces'
export const GHOSTTY_SEND_KEY_CHANNEL = 'ghostty:send-key'
export const GHOSTTY_SEND_TEXT_CHANNEL = 'ghostty:send-text'
export const GHOSTTY_SEND_MOUSE_BUTTON_CHANNEL = 'ghostty:send-mouse-button'
export const GHOSTTY_SEND_MOUSE_POS_CHANNEL = 'ghostty:send-mouse-pos'
export const GHOSTTY_SEND_MOUSE_SCROLL_CHANNEL = 'ghostty:send-mouse-scroll'
export const GHOSTTY_MOUSE_CAPTURED_CHANNEL = 'ghostty:mouse-captured'
export const GHOSTTY_GET_IOSURFACE_HANDLE_CHANNEL =
  'ghostty:get-iosurface-handle'

/** Push channel for Ghostty action events (title, pwd, bell, exit, etc.). */
export const GHOSTTY_ACTION_CHANNEL = 'ghostty:action'

/** Push channel for Ghostty shared texture frames. */
export const GHOSTTY_FRAME_CHANNEL = 'ghostty:frame'

/** Event types that are push action events (not request/response). */
const PUSH_ACTION_TYPES = new Set([
  'title_changed',
  'pwd_changed',
  'bell',
  'child_exited',
  'close_window',
  'cell_size',
  'renderer_health',
  'unsupported_action',
  'render_frame',
])

const SILENT_COMMAND_TYPES = new Set([
  'get_iosurface',
  'get_pixels',
  'send_key',
  'send_mouse_pos',
  'send_mouse_button',
  'send_mouse_scroll',
])

const SHARED_TEXTURE_POLL_INTERVAL_MS = 250
const SHARED_TEXTURE_REFRESH_INTERVAL_MS = 1000
const ENABLE_SHARED_TEXTURE_POLLING = true

type ImportedSharedTexture = ReturnType<
  typeof sharedTexture.importSharedTexture
>

interface CachedSharedTexture {
  readonly height: number
  readonly imported: ImportedSharedTexture
  readonly ioSurfaceId: number
  readonly width: number
}

function formatGhosttyStdoutLine(line: string): string {
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    if (event.type === 'pixels_result') {
      return JSON.stringify({
        type: 'pixels_result',
        id: event.id,
        surfaceId: event.surfaceId,
        width: event.width,
        height: event.height,
        pixels: '<base64 omitted>',
      })
    }
    if (event.type === 'iosurface_handle_result') {
      return JSON.stringify({
        type: 'iosurface_handle_result',
        id: event.id,
        surfaceId: event.surfaceId,
        width: event.width,
        height: event.height,
        ioSurfaceHandle: '<base64 omitted>',
      })
    }
  } catch {
    // Fall through to raw line logging.
  }

  return line
}

function shouldLogGhosttyStdoutLine(line: string): boolean {
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    return !new Set([
      'iosurface_result',
      'ok',
      'pixels_null',
      'pixels_result',
    ]).has(event.type as string)
  } catch {
    return true
  }
}

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
  private readonly activeSurfaceIds = new Set<number>()
  private readonly cachedSharedTextures = new Map<number, CachedSharedTexture>()
  private readonly lastSharedTextureCheckAt = new Map<number, number>()
  private readonly sharedTextureInFlight = new Set<number>()
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private nextId = 1
  private sharedTexturePollTimer: ReturnType<typeof setInterval> | null = null
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

    console.info(
      `[GhosttyBridge] attach() called, pid=${child.pid}, stdout=${child.stdout !== null}, stdin=${child.stdin !== null}`
    )

    if (child.stdout) {
      this.stdoutRl = createInterface({ input: child.stdout })
      this.stdoutRl.on('line', (line: string) => {
        // Log for debugging (replaces SidecarManager stdout logging which
        // is skipped for ghostty to avoid dual-consumer stream contention).
        if (shouldLogGhosttyStdoutLine(line)) {
          console.info(`[ghostty:stdout] ${formatGhosttyStdoutLine(line)}`)
        }
        this.processLine(line)
      })
    } else {
      console.warn('[GhosttyBridge] child.stdout is null — cannot read IPC')
    }

    // Reject all pending requests if the process exits.
    child.once('exit', () => {
      console.warn('[GhosttyBridge] child process exited')
      this.releaseAllCachedSharedTextures()
      this.lastSharedTextureCheckAt.clear()
      this.rejectAll(new Error('Ghostty Host process exited'))
      this.child = null
      this.ready = false
    })
  }

  /** Detach from the current sidecar process. */
  detach(): void {
    this.stdoutRl?.close()
    this.stdoutRl = null
    this.stopSharedTexturePolling()
    this.activeSurfaceIds.clear()
    this.releaseAllCachedSharedTextures()
    this.lastSharedTextureCheckAt.clear()
    this.sharedTextureInFlight.clear()
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

    ipcMain.removeHandler(GHOSTTY_GET_PIXELS_CHANNEL)
    ipcMain.handle(
      GHOSTTY_GET_PIXELS_CHANNEL,
      async (_event, surfaceId: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        return await this.getPixels(surfaceId)
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

    ipcMain.removeHandler(GHOSTTY_SEND_MOUSE_BUTTON_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SEND_MOUSE_BUTTON_CHANNEL,
      async (_event, surfaceId: unknown, mouseEvent: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        if (typeof mouseEvent !== 'object' || mouseEvent === null) {
          throw new Error('mouseEvent must be an object')
        }
        return await this.sendMouseButton(
          surfaceId,
          mouseEvent as Record<string, unknown>
        )
      }
    )

    ipcMain.removeHandler(GHOSTTY_SEND_MOUSE_POS_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SEND_MOUSE_POS_CHANNEL,
      async (_event, surfaceId: unknown, mouseEvent: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        if (typeof mouseEvent !== 'object' || mouseEvent === null) {
          throw new Error('mouseEvent must be an object')
        }
        return await this.sendMousePos(
          surfaceId,
          mouseEvent as Record<string, unknown>
        )
      }
    )

    ipcMain.removeHandler(GHOSTTY_SEND_MOUSE_SCROLL_CHANNEL)
    ipcMain.handle(
      GHOSTTY_SEND_MOUSE_SCROLL_CHANNEL,
      async (_event, surfaceId: unknown, mouseEvent: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        if (typeof mouseEvent !== 'object' || mouseEvent === null) {
          throw new Error('mouseEvent must be an object')
        }
        return await this.sendMouseScroll(
          surfaceId,
          mouseEvent as Record<string, unknown>
        )
      }
    )

    ipcMain.removeHandler(GHOSTTY_MOUSE_CAPTURED_CHANNEL)
    ipcMain.handle(
      GHOSTTY_MOUSE_CAPTURED_CHANNEL,
      async (_event, surfaceId: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        return await this.mouseCaptured(surfaceId)
      }
    )

    ipcMain.removeHandler(GHOSTTY_GET_IOSURFACE_HANDLE_CHANNEL)
    ipcMain.handle(
      GHOSTTY_GET_IOSURFACE_HANDLE_CHANNEL,
      async (_event, surfaceId: unknown) => {
        if (typeof surfaceId !== 'number') {
          throw new Error('surfaceId must be a number')
        }
        return await this.getIOSurfaceHandle(surfaceId)
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
    const surfaceId = await this.sendRequest<number>({
      type: 'create_surface',
      id,
      options,
    })
    this.activeSurfaceIds.add(surfaceId)
    this.ensureSharedTexturePolling()
    return surfaceId
  }

  async getPixels(surfaceId: number): Promise<{
    readonly height: number
    readonly pixels: string
    readonly width: number
  } | null> {
    this.ensureReady()
    const id = this.generateId()
    const result = await this.sendRequest<Record<string, unknown>>({
      type: 'get_pixels',
      id,
      surfaceId,
    })
    if (result.type === 'pixels_null') {
      return null
    }
    return {
      height: result.height as number,
      pixels: result.pixels as string,
      width: result.width as number,
    }
  }

  async destroySurface(surfaceId: number): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({ type: 'destroy_surface', id, surfaceId })
    this.activeSurfaceIds.delete(surfaceId)
    this.releaseCachedSharedTexture(surfaceId)
    this.lastSharedTextureCheckAt.delete(surfaceId)
    this.sharedTextureInFlight.delete(surfaceId)
    if (this.activeSurfaceIds.size === 0) {
      this.stopSharedTexturePolling()
    }
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

  async sendMouseButton(
    surfaceId: number,
    mouseEvent: Record<string, unknown>
  ): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({
      type: 'send_mouse_button',
      id,
      surfaceId,
      mouseEvent,
    })
  }

  async sendMousePos(
    surfaceId: number,
    mouseEvent: Record<string, unknown>
  ): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({
      type: 'send_mouse_pos',
      id,
      surfaceId,
      mouseEvent,
    })
  }

  async sendMouseScroll(
    surfaceId: number,
    mouseEvent: Record<string, unknown>
  ): Promise<void> {
    this.ensureReady()
    const id = this.generateId()
    await this.sendRequest<void>({
      type: 'send_mouse_scroll',
      id,
      surfaceId,
      mouseEvent,
    })
  }

  async mouseCaptured(surfaceId: number): Promise<boolean> {
    this.ensureReady()
    const id = this.generateId()
    return await this.sendRequest<boolean>({
      type: 'mouse_captured',
      id,
      surfaceId,
    })
  }

  async getIOSurfaceHandle(surfaceId: number): Promise<{
    readonly height: number
    readonly ioSurfaceHandle: string
    readonly width: number
  } | null> {
    this.ensureReady()
    const id = this.generateId()
    const result = await this.sendRequest<Record<string, unknown>>({
      type: 'get_iosurface_handle',
      id,
      surfaceId,
    })
    if (result.type === 'iosurface_handle_null') {
      return null
    }
    return {
      height: result.height as number,
      ioSurfaceHandle: result.ioSurfaceHandle as string,
      width: result.width as number,
    }
  }

  async getIOSurfaceInfo(surfaceId: number): Promise<{
    readonly hasLayer: boolean
    readonly ioSurfaceId: number | null
  }> {
    this.ensureReady()
    const id = this.generateId()
    const result = await this.sendRequest<Record<string, unknown>>({
      type: 'get_iosurface',
      id,
      surfaceId,
    })
    return {
      hasLayer: result.info
        ? Boolean((result.info as Record<string, unknown>).hasLayer)
        : false,
      ioSurfaceId: result.info
        ? (((result.info as Record<string, unknown>).ioSurfaceId as
            | number
            | null
            | undefined) ?? null)
        : null,
    }
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
      console.warn(
        '[GhosttyBridge] ensureReady failed: not attached to sidecar'
      )
      throw new Error('GhosttyBridge: not attached to a sidecar process')
    }
    if (!this.ready) {
      console.warn(
        '[GhosttyBridge] ensureReady failed: Ghostty Host not ready yet'
      )
      throw new Error('GhosttyBridge: Ghostty Host not ready yet')
    }
  }

  private sendCommand(command: Record<string, unknown>): void {
    const line = `${JSON.stringify(command)}\n`
    const hasStdin =
      this.child?.stdin !== null && this.child?.stdin !== undefined
    if (!SILENT_COMMAND_TYPES.has(command.type as string)) {
      console.info(
        `[GhosttyBridge] sendCommand: type=${command.type as string} id=${command.id as string} hasStdin=${hasStdin}`
      )
    }
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
      console.info('[GhosttyBridge] Received "ready" — bridge is now ready')
      return
    }

    this.routeEvent(event)
  }

  private routeEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string

    // Check if this is a push action event (no request ID).
    // Forward to all renderer windows via webContents.send().
    if (PUSH_ACTION_TYPES.has(eventType)) {
      this.forwardPushAction(eventType, event)
      return
    }

    const id = event.id as string | undefined

    switch (eventType) {
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
      case 'mouse_captured_result':
        if (id) {
          this.resolveRequest(id, event.captured)
        }
        break
      case 'error':
        if (id) {
          this.rejectRequest(id, new Error(event.message as string))
        }
        break
      default:
        // Other events (size_result, iosurface_result, iosurface_handle_result,
        // iosurface_handle_null, etc.) are resolved to their pending request.
        if (id && typeof id === 'string') {
          this.resolveRequest(id, event)
        }
        break
    }
  }

  private forwardPushAction(
    eventType: string,
    event: Record<string, unknown>
  ): void {
    const surfaceId =
      typeof event.surfaceId === 'number' ? event.surfaceId : undefined

    if (
      surfaceId !== undefined &&
      surfaceId > 0 &&
      eventType === 'render_frame'
    ) {
      this.presentSharedTexture(surfaceId).catch((error: unknown) => {
        console.warn(
          `[GhosttyBridge] presentSharedTexture failed: ${String(error)}`
        )
      })
    } else if (
      surfaceId !== undefined &&
      surfaceId > 0 &&
      eventType === 'cell_size'
    ) {
      this.presentSharedTexture(surfaceId).catch(() => {
        // Best effort bootstrap on first layout or resize
      })
    }

    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.webContents.send(GHOSTTY_ACTION_CHANNEL, event)
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

  private async ensureImportedSharedTexture(
    surfaceId: number
  ): Promise<CachedSharedTexture | null> {
    this.lastSharedTextureCheckAt.set(surfaceId, Date.now())

    const surfaceInfo = await this.getIOSurfaceInfo(surfaceId)
    if (!(surfaceInfo.hasLayer && surfaceInfo.ioSurfaceId !== null)) {
      return null
    }

    const cached = this.cachedSharedTextures.get(surfaceId)
    if (cached?.ioSurfaceId === surfaceInfo.ioSurfaceId) {
      return cached
    }

    const handleResult = lookupIOSurfaceHandleById(surfaceInfo.ioSurfaceId)
    if (handleResult === null) {
      return null
    }

    const ioSurfaceBuffer = handleResult.ioSurfaceHandle

    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: {
            width: handleResult.width,
            height: handleResult.height,
          },
          handle: {
            ioSurface: ioSurfaceBuffer,
          },
        },
      })

      this.releaseCachedSharedTexture(surfaceId)

      const nextCached = {
        height: handleResult.height,
        imported,
        ioSurfaceId: surfaceInfo.ioSurfaceId,
        width: handleResult.width,
      } satisfies CachedSharedTexture
      this.cachedSharedTextures.set(surfaceId, nextCached)
      return nextCached
    } catch (importError: unknown) {
      console.warn(
        `[GhosttyBridge] sharedTexture import failed: ${String(importError)}`
      )
      return null
    }
  }

  private async presentSharedTexture(surfaceId: number): Promise<void> {
    if (this.sharedTextureInFlight.has(surfaceId)) {
      return
    }

    this.sharedTextureInFlight.add(surfaceId)
    try {
      const cached = await this.ensureImportedSharedTexture(surfaceId)
      if (cached === null) {
        return
      }

      const windows = BrowserWindow.getAllWindows()
      const sendPromises = windows.map(async (window) => {
        try {
          await sharedTexture.sendSharedTexture(
            {
              frame: window.webContents.mainFrame,
              importedSharedTexture: cached.imported,
            },
            surfaceId
          )
        } catch (sendError: unknown) {
          console.warn(
            `[GhosttyBridge] sendSharedTexture to window ${window.id} failed: ${String(sendError)}`
          )
        }
      })

      await Promise.all(sendPromises)
    } finally {
      this.sharedTextureInFlight.delete(surfaceId)
    }
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private ensureSharedTexturePolling(): void {
    if (!ENABLE_SHARED_TEXTURE_POLLING) {
      return
    }

    if (this.sharedTexturePollTimer !== null) {
      return
    }

    this.sharedTexturePollTimer = setInterval(() => {
      this.pollSharedTextures().catch(() => {
        // Best effort polling
      })
    }, SHARED_TEXTURE_POLL_INTERVAL_MS)
  }

  private stopSharedTexturePolling(): void {
    if (this.sharedTexturePollTimer !== null) {
      clearInterval(this.sharedTexturePollTimer)
      this.sharedTexturePollTimer = null
    }
  }

  private async pollSharedTextures(): Promise<void> {
    if (!this.ready || this.activeSurfaceIds.size === 0) {
      return
    }

    const now = Date.now()
    const surfaceIds = [...this.activeSurfaceIds]
    await Promise.all(
      surfaceIds.map(async (surfaceId) => {
        const cached = this.cachedSharedTextures.get(surfaceId)
        const lastCheckedAt = this.lastSharedTextureCheckAt.get(surfaceId) ?? 0
        if (
          cached !== undefined &&
          now - lastCheckedAt < SHARED_TEXTURE_REFRESH_INTERVAL_MS
        ) {
          return
        }

        try {
          await this.presentSharedTexture(surfaceId)
        } catch {
          // Best effort polling
        }
      })
    )
  }

  private releaseCachedSharedTexture(surfaceId: number): void {
    const cached = this.cachedSharedTextures.get(surfaceId)
    if (cached === undefined) {
      return
    }

    cached.imported.release()
    this.cachedSharedTextures.delete(surfaceId)
  }

  private releaseAllCachedSharedTextures(): void {
    for (const surfaceId of this.cachedSharedTextures.keys()) {
      this.releaseCachedSharedTexture(surfaceId)
    }
  }
}
