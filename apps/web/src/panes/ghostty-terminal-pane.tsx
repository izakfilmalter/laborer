/**
 * Ghostty terminal pane — manages the lifecycle of a native Ghostty terminal
 * surface within Laborer's panel layout system.
 *
 * This component is responsible for:
 * - Creating a Ghostty surface via the DesktopBridge IPC when the pane mounts
 * - Setting focus on the surface when the pane gains/loses focus
 * - Forwarding keyboard input to the native Ghostty surface (Issue 5)
 * - Forwarding mouse input to the native Ghostty surface (Issue 6)
 * - Propagating resize events from the pane layout to the surface (Issue 5)
 * - Destroying the surface cleanly when the pane unmounts
 * - Showing loading, error, and placeholder states
 *
 * - Handling Ghostty action events (title, pwd, bell, child exit) (Issue 7)
 *
 * Rendering:
 * - Zero-copy rendering via Electron's sharedTexture API (IOSurface → VideoFrame → canvas)
 * - Falls back to pixel readback polling at ~30fps when shared texture is not available
 *
 * Keyboard input routing:
 * - The container div receives keyboard events via tabIndex={0}
 * - Events are translated from W3C KeyboardEvent.code to Ghostty's
 *   ghostty_input_key_e enum and sent via the DesktopBridge IPC
 * - Panel shortcuts (Ctrl+B prefix, Cmd+W, Cmd+Shift+Enter) bypass the
 *   terminal and bubble to the global hotkey layer
 *
 * Mouse input routing:
 * - Mouse button events (click, release) are translated to Ghostty button
 *   enums and forwarded via DesktopBridge
 * - Mouse move events are forwarded as position updates
 * - Wheel events are forwarded as scroll events
 * - Context menu is prevented within the terminal surface
 *
 * Resize routing:
 * - A ResizeObserver watches the container div and sends pixel dimensions
 *   to the native surface via DesktopBridge.ghosttySetSize
 * - Debounced at 100ms to avoid flooding during drag operations
 *
 * @see packages/ghostty/src/ghostty-host.ts — Ghostty Host IPC protocol
 * @see apps/desktop/src/ghostty-bridge.ts — Main process IPC relay
 * @see Issue 4: Ghostty terminal lifecycle and pane integration
 * @see Issue 5: Keyboard, focus, and resize routing
 * @see Issue 6: Mouse input and interactive terminal behavior
 */

import type {
  GhosttyActionEvent,
  GhosttyKeyEvent,
  GhosttyMouseButtonEvent,
  GhosttyMousePosEvent,
  GhosttyMouseScrollEvent,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { Ghost, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDesktopBridge } from '@/lib/desktop'
import {
  GHOSTTY_KEY_MAP,
  GHOSTTY_NATIVE_KEYCODE_OVERRIDES,
  RESIZE_DEBOUNCE_MS,
  translateModifiers,
} from './ghostty-keys.js'
import {
  GHOSTTY_MOUSE_PRESS,
  GHOSTTY_MOUSE_RELEASE,
  translateMouseButton,
  translateMouseModifiers,
} from './ghostty-mouse.js'
import { shouldBypassTerminal } from './terminal-keys.js'

/** Target render rate for fallback pixel polling before the first frame. */
const INITIAL_RENDER_INTERVAL_MS = 33

/** Steady-state pixel polling rate once frames are arriving. */
const ACTIVE_RENDER_INTERVAL_MS = 50

/** Focused interaction burst rate for fallback pixel polling. */
const BURST_RENDER_INTERVAL_MS = 16

/** Background polling rate for unfocused panes on pixel fallback. */
const BACKGROUND_RENDER_INTERVAL_MS = 1000

/** Burst polling window after local interaction. */
const INTERACTION_BURST_MS = 2500

/** How long to wait for shared-texture frames before falling back. */
const SHARED_TEXTURE_FALLBACK_MS = 750

/**
 * Decode base64-encoded BGRA pixel data and draw it to a canvas.
 * Converts BGRA → RGBA in-place before creating ImageData.
 * This is the fallback path when shared texture rendering is not available.
 */
function drawPixelsToCanvas(
  canvas: HTMLCanvasElement,
  base64Pixels: string,
  width: number,
  height: number
): void {
  // Resize canvas if dimensions changed
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  // Decode base64 → binary
  const binaryString = atob(base64Pixels)
  const byteLength = binaryString.length
  const rgba = new Uint8ClampedArray(byteLength)
  for (let i = 0; i < byteLength; i++) {
    rgba[i] = binaryString.charCodeAt(i)
  }

  // Convert BGRA → RGBA (swap B and R channels)
  for (let i = 0; i < byteLength; i += 4) {
    const b = rgba[i] ?? 0
    rgba[i] = rgba[i + 2] ?? 0 // R = B
    rgba[i + 2] = b // B = R
    // G and A stay in place
  }

  const imageData = new ImageData(rgba, width, height)
  const ctx = canvas.getContext('2d')
  ctx?.putImageData(imageData, 0, 0)
}

type SurfaceState =
  | { readonly status: 'idle' }
  | { readonly status: 'creating' }
  | { readonly status: 'active'; readonly surfaceId: number }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'destroyed' }
  | { readonly status: 'crashed' }

type RenderTransport = 'pending-shared' | 'shared' | 'pixels'

const CONTROL_KEY_TEXT: Readonly<Record<string, string>> = {
  Backspace: '\b',
  Enter: '\r',
  Escape: '\u001b',
  NumpadEnter: '\r',
  Tab: '\t',
}

interface GhosttyTerminalPaneProps {
  /** Whether this pane is currently focused in the panel layout. */
  readonly isFocused?: boolean | undefined
  /** Callback invoked when the terminal working directory changes. */
  readonly onPwdChange?: ((pwd: string) => void) | undefined
  /** Callback invoked when the surface exits or is destroyed. */
  readonly onSurfaceExit?: (() => void) | undefined
  /** Callback invoked when the terminal title changes. */
  readonly onTitleChange?: ((title: string) => void) | undefined
}

/**
 * Prefix mode state — when Ctrl+B is pressed, the next keypress should
 * bypass the terminal and bubble to TanStack Hotkeys for panel shortcuts.
 */
const PREFIX_TIMEOUT_MS = 1500

function GhosttyTerminalPane({
  onSurfaceExit,
  onTitleChange,
  onPwdChange,
  isFocused = false,
}: GhosttyTerminalPaneProps) {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>({
    status: 'idle',
  })
  const [title, setTitle] = useState<string>('')
  const [bellFlash, setBellFlash] = useState(false)
  const [renderTransport, setRenderTransport] =
    useState<RenderTransport>('pixels')
  const surfaceIdRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const prefixActiveRef = useRef(false)
  const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMousePosRef = useRef<GhosttyMousePosEvent | null>(null)
  const mouseFrameRef = useRef<number | null>(null)
  const interactionBurstUntilRef = useRef(0)
  const immediatePixelRenderRef = useRef<(() => void) | null>(null)
  const renderingRef = useRef(false)

  const requestInteractionBurst = useCallback(() => {
    interactionBurstUntilRef.current = Date.now() + INTERACTION_BURST_MS
    immediatePixelRenderRef.current?.()
  }, [])

  const drawVideoFrameToCanvas = useCallback((videoFrame: VideoFrame) => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }

    const width = videoFrame.displayWidth || videoFrame.codedWidth
    const height = videoFrame.displayHeight || videoFrame.codedHeight
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    const ctx = canvas.getContext('2d')
    ctx?.drawImage(videoFrame, 0, 0, width, height)
  }, [])

  // Create the Ghostty surface on mount
  useEffect(() => {
    mountedRef.current = true
    const bridge = getDesktopBridge()

    if (!bridge?.ghosttyCreateSurface) {
      console.warn(
        '[GhosttyTerminalPane] No bridge or ghosttyCreateSurface — not in Electron?'
      )
      setSurfaceState({
        status: 'error',
        message: 'Ghostty not available (not running in Electron)',
      })
      return
    }

    console.info('[GhosttyTerminalPane] Creating Ghostty surface...')
    setSurfaceState({ status: 'creating' })

    bridge
      .ghosttyCreateSurface()
      .then((surfaceId) => {
        if (!mountedRef.current) {
          console.warn(
            '[GhosttyTerminalPane] Unmounted during creation, destroying surface',
            surfaceId
          )
          bridge.ghosttyDestroySurface(surfaceId).catch(() => {
            // Best effort cleanup
          })
          return
        }
        console.info(
          `[GhosttyTerminalPane] Surface created: surfaceId=${surfaceId}`
        )
        surfaceIdRef.current = surfaceId
        setRenderTransport('pending-shared')
        setSurfaceState({ status: 'active', surfaceId })
      })
      .catch((error: unknown) => {
        console.error('[GhosttyTerminalPane] Failed to create surface:', error)
        if (!mountedRef.current) {
          return
        }
        setSurfaceState({
          status: 'error',
          message: `Failed to create Ghostty surface: ${String(error)}`,
        })
      })

    // Destroy the surface on unmount
    return () => {
      mountedRef.current = false
      const id = surfaceIdRef.current
      if (id !== null) {
        surfaceIdRef.current = null
        const currentBridge = getDesktopBridge()
        currentBridge?.ghosttyDestroySurface(id).catch(() => {
          // Best effort cleanup
        })
      }
    }
  }, [])

  // Sync focus state with the native surface
  useEffect(() => {
    if (surfaceState.status !== 'active') {
      return
    }

    const { surfaceId } = surfaceState
    const bridge = getDesktopBridge()
    if (isFocused) {
      requestInteractionBurst()
    }
    bridge?.ghosttySetFocus(surfaceId, isFocused).catch(() => {
      // Best effort — surface may have been destroyed
    })
  }, [isFocused, requestInteractionBurst, surfaceState])

  // Auto-focus the container when the pane becomes focused
  useEffect(() => {
    if (isFocused && containerRef.current) {
      containerRef.current.focus()
    }
  }, [isFocused])

  // ResizeObserver — propagate container size changes to the native surface
  useEffect(() => {
    if (surfaceState.status !== 'active') {
      return
    }

    const container = containerRef.current
    if (container === null) {
      return
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) {
        return
      }

      const { width, height } = entry.contentRect
      if (width === 0 || height === 0) {
        return
      }

      // Debounce resize to avoid flooding during drag operations
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current)
      }

      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        const id = surfaceIdRef.current
        if (id === null) {
          return
        }
        const bridge = getDesktopBridge()
        requestInteractionBurst()
        bridge
          ?.ghosttySetSize(id, Math.round(width), Math.round(height))
          .catch(() => {
            // Best effort — surface may have been destroyed
          })
      }, RESIZE_DEBOUNCE_MS)
    })

    observer.observe(container)

    return () => {
      observer.disconnect()
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
    }
  }, [requestInteractionBurst, surfaceState])

  // Rendering — prefer sharedTexture zero-copy frames when Electron exposes
  // the API, then fall back to pixel polling only if no frames arrive.
  useEffect(() => {
    if (surfaceState.status !== 'active') {
      return
    }

    const bridge = getDesktopBridge()
    if (!bridge?.onGhosttyFrame) {
      setRenderTransport('pixels')
      return
    }

    let disposed = false
    let receivedFrame = false
    const unsubscribe = bridge.onGhosttyFrame((frameSurfaceId, imported) => {
      if (disposed || frameSurfaceId !== surfaceState.surfaceId) {
        return
      }

      receivedFrame = true
      setRenderTransport('shared')

      const videoFrame = imported.getVideoFrame() as VideoFrame
      try {
        drawVideoFrameToCanvas(videoFrame)
      } catch (error) {
        console.warn(
          '[GhosttyTerminalPane] Failed to draw shared frame:',
          error
        )
      } finally {
        videoFrame.close()
        imported.release()
      }
    })

    if (unsubscribe === null) {
      setRenderTransport('pixels')
      return
    }

    setRenderTransport('pending-shared')
    const fallbackTimer = setTimeout(() => {
      if (!(disposed || receivedFrame)) {
        setRenderTransport('pixels')
      }
    }, SHARED_TEXTURE_FALLBACK_MS)

    return () => {
      disposed = true
      clearTimeout(fallbackTimer)
      unsubscribe()
    }
  }, [drawVideoFrameToCanvas, surfaceState])

  // Rendering — uses pixel readback polling at ~30fps as the primary path.
  //
  // The Ghostty sidecar runs as a headless Node.js process without GPU
  // context, so its Metal renderer does not produce render_frame push events
  // needed for the shared texture zero-copy path. Pixel readback via
  // get_pixels is the reliable rendering method for this architecture.
  //
  // If shared texture frames ever arrive (e.g., future GPU-enabled sidecar),
  // they will be handled by a separate subscriber that can override the
  // polling loop.
  useEffect(() => {
    if (surfaceState.status !== 'active' || renderTransport !== 'pixels') {
      return
    }

    const { surfaceId } = surfaceState

    let timerId: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let hasRenderedFrame = false

    const getNextRenderInterval = () => {
      if (!isFocused) {
        return BACKGROUND_RENDER_INTERVAL_MS
      }

      const inInteractionBurst = Date.now() < interactionBurstUntilRef.current
      if (inInteractionBurst) {
        return BURST_RENDER_INTERVAL_MS
      }

      if (hasRenderedFrame) {
        return ACTIVE_RENDER_INTERVAL_MS
      }

      return INITIAL_RENDER_INTERVAL_MS
    }

    const scheduleRender = (delayMs: number) => {
      if (timerId !== null) {
        clearTimeout(timerId)
      }
      timerId = setTimeout(renderFrame, delayMs)
    }

    const renderFrame = async () => {
      if (stopped || renderingRef.current) {
        return
      }
      renderingRef.current = true

      try {
        const currentBridge = getDesktopBridge()
        const result = await currentBridge?.ghosttyGetPixels(surfaceId)

        if (!(stopped || result === undefined || result === null)) {
          hasRenderedFrame = true
          const canvas = canvasRef.current
          if (canvas !== null) {
            drawPixelsToCanvas(
              canvas,
              result.pixels,
              result.width,
              result.height
            )
          }
        }
      } catch {
        // Best effort — surface may have been destroyed or bridge disconnected
      } finally {
        renderingRef.current = false
      }

      if (!stopped) {
        scheduleRender(getNextRenderInterval())
      }
    }

    immediatePixelRenderRef.current = () => {
      if (stopped || renderTransport !== 'pixels') {
        return
      }
      scheduleRender(0)
    }

    scheduleRender(0)

    return () => {
      stopped = true
      immediatePixelRenderRef.current = null
      if (timerId !== null) {
        clearTimeout(timerId)
      }
    }
  }, [isFocused, renderTransport, surfaceState])

  // Translate a browser KeyboardEvent to a GhosttyKeyEvent and send it
  const sendKeyEvent = useCallback(
    (event: React.KeyboardEvent, action: number) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      const ghosttyKeycode =
        GHOSTTY_NATIVE_KEYCODE_OVERRIDES.get(event.code) ??
        GHOSTTY_KEY_MAP.get(event.code)
      if (ghosttyKeycode === undefined) {
        // Unknown key — cannot translate
        return
      }

      const controlText = CONTROL_KEY_TEXT[event.code]
      const text =
        action === 1
          ? (controlText ?? (event.key.length === 1 ? event.key : null))
          : null
      const unshiftedCodepoint = text !== null ? (text.codePointAt(0) ?? 0) : 0

      const keyEvent: GhosttyKeyEvent = {
        action,
        composing: event.nativeEvent.isComposing,
        keycode: ghosttyKeycode,
        mods: translateModifiers(event),
        text,
        unshiftedCodepoint,
      }

      const bridge = getDesktopBridge()
      requestInteractionBurst()
      bridge?.ghosttySendKey(id, keyEvent).catch(() => {
        // Best effort — surface may have been destroyed
      })
    },
    [isFocused, requestInteractionBurst]
  )

  // Keyboard event handlers with shortcut scope isolation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // If prefix mode is active, let this key bubble to global hotkeys
      if (prefixActiveRef.current) {
        prefixActiveRef.current = false
        if (prefixTimerRef.current !== null) {
          clearTimeout(prefixTimerRef.current)
          prefixTimerRef.current = null
        }
        // Don't prevent default — let TanStack Hotkeys handle it
        return
      }

      // Check if this key should bypass the terminal
      if (shouldBypassTerminal(event.nativeEvent)) {
        // Ctrl+B activates prefix mode
        if (
          event.key === 'b' &&
          event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          prefixActiveRef.current = true
          prefixTimerRef.current = setTimeout(() => {
            prefixActiveRef.current = false
            prefixTimerRef.current = null
          }, PREFIX_TIMEOUT_MS)
        }
        // Don't prevent default — let it bubble to global hotkeys
        return
      }

      // Forward to Ghostty (action=1 for press)
      event.preventDefault()
      event.stopPropagation()
      sendKeyEvent(event, 1)
    },
    [sendKeyEvent]
  )

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      // Don't send key-up for bypassed keys
      if (shouldBypassTerminal(event.nativeEvent)) {
        return
      }

      // Forward to Ghostty (action=0 for release)
      event.preventDefault()
      event.stopPropagation()
      sendKeyEvent(event, 0)
    },
    [sendKeyEvent]
  )

  // Mouse event handlers — forward mouse input to the native Ghostty surface

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const mouseEvent: GhosttyMouseButtonEvent = {
        state: GHOSTTY_MOUSE_PRESS,
        button: translateMouseButton(event.button),
        mods: translateMouseModifiers(event),
      }

      const bridge = getDesktopBridge()
      requestInteractionBurst()
      bridge?.ghosttySendMouseButton(id, mouseEvent).catch(() => {
        // Best effort
      })

      // Also send position with the button press
      const posEvent: GhosttyMousePosEvent = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        mods: translateMouseModifiers(event),
      }
      requestInteractionBurst()
      bridge?.ghosttySendMousePos(id, posEvent).catch(() => {
        // Best effort
      })
    },
    [requestInteractionBurst]
  )

  const handleMouseUp = useCallback(
    (event: React.MouseEvent) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      const mouseEvent: GhosttyMouseButtonEvent = {
        state: GHOSTTY_MOUSE_RELEASE,
        button: translateMouseButton(event.button),
        mods: translateMouseModifiers(event),
      }

      const bridge = getDesktopBridge()
      requestInteractionBurst()
      bridge?.ghosttySendMouseButton(id, mouseEvent).catch(() => {
        // Best effort
      })
    },
    [requestInteractionBurst]
  )

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const posEvent: GhosttyMousePosEvent = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        mods: translateMouseModifiers(event),
      }

      pendingMousePosRef.current = posEvent
      if (mouseFrameRef.current !== null) {
        return
      }

      mouseFrameRef.current = requestAnimationFrame(() => {
        mouseFrameRef.current = null
        const currentId = surfaceIdRef.current
        const currentPos = pendingMousePosRef.current
        pendingMousePosRef.current = null
        if (currentId === null || currentPos === null) {
          return
        }

        const bridge = getDesktopBridge()
        requestInteractionBurst()
        bridge?.ghosttySendMousePos(currentId, currentPos).catch(() => {
          // Best effort
        })
      })
    },
    [requestInteractionBurst]
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      // Normalize scroll deltas. Browser WheelEvent.deltaX/deltaY are in
      // pixels (for deltaMode 0). Ghostty expects scroll amounts where
      // positive Y means scrolling content up (opposite of browser convention).
      const scrollEvent: GhosttyMouseScrollEvent = {
        dx: event.deltaX,
        dy: event.deltaY,
        scrollMods: 0,
      }

      const bridge = getDesktopBridge()
      requestInteractionBurst()
      bridge?.ghosttySendMouseScroll(id, scrollEvent).catch(() => {
        // Best effort
      })

      // Prevent the page from scrolling
      event.preventDefault()
    },
    [requestInteractionBurst]
  )

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    // Prevent the browser context menu inside the terminal surface.
    // Right-click events are forwarded to Ghostty as mouse button events.
    event.preventDefault()
  }, [])

  // Handle the exit callback when the surface is destroyed
  const handleExit = useCallback(() => {
    onSurfaceExit?.()
  }, [onSurfaceExit])

  // Handle reconnection after a sidecar crash — re-create the surface
  const handleReconnect = useCallback(() => {
    const bridge = getDesktopBridge()
    if (!bridge?.ghosttyCreateSurface) {
      return
    }

    // Reset to creating state and attempt to create a new surface
    setSurfaceState({ status: 'creating' })
    setTitle('')

    bridge
      .ghosttyCreateSurface()
      .then((surfaceId) => {
        if (!mountedRef.current) {
          bridge.ghosttyDestroySurface(surfaceId).catch(() => {
            // Best effort cleanup
          })
          return
        }
        surfaceIdRef.current = surfaceId
        setSurfaceState({ status: 'active', surfaceId })
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) {
          return
        }
        setSurfaceState({
          status: 'error',
          message: `Failed to reconnect Ghostty surface: ${String(error)}`,
        })
      })
  }, [])

  // Detect Ghostty sidecar crashes and transition to crashed state.
  // When the sidecar recovers (healthy), automatically attempt to reconnect.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge?.onSidecarStatus) {
      return
    }

    const unsubscribe = bridge.onSidecarStatus((status: SidecarStatusEvent) => {
      if (status.name !== 'ghostty') {
        return
      }

      if (status.state === 'crashed' && surfaceIdRef.current !== null) {
        // Only transition to crashed if we had an active surface
        surfaceIdRef.current = null
        setSurfaceState({ status: 'crashed' })
      }

      if (status.state === 'healthy') {
        // Sidecar recovered — auto-reconnect if we're in crashed state
        setSurfaceState((prev) => {
          if (prev.status === 'crashed') {
            // Trigger reconnect on next tick to avoid setState-in-setState
            setTimeout(handleReconnect, 0)
          }
          return prev
        })
      }
    })

    return unsubscribe
  }, [handleReconnect])

  // Cleanup prefix timer on unmount
  useEffect(() => {
    return () => {
      if (prefixTimerRef.current !== null) {
        clearTimeout(prefixTimerRef.current)
      }
      if (mouseFrameRef.current !== null) {
        cancelAnimationFrame(mouseFrameRef.current)
      }
    }
  }, [])

  // Subscribe to Ghostty action events (title, pwd, bell, child exit, etc.)
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge?.onGhosttyAction) {
      return
    }

    const unsubscribe = bridge.onGhosttyAction((event: GhosttyActionEvent) => {
      // Only handle events for this pane's surface
      const currentSurfaceId = surfaceIdRef.current
      if (currentSurfaceId === null || event.surfaceId !== currentSurfaceId) {
        return
      }

      switch (event.type) {
        case 'title_changed':
          setTitle(event.title)
          onTitleChange?.(event.title)
          break
        case 'pwd_changed':
          onPwdChange?.(event.pwd)
          break
        case 'bell':
          // Visual bell flash
          setBellFlash(true)
          setTimeout(() => setBellFlash(false), 150)
          break
        case 'child_exited':
          setSurfaceState({ status: 'destroyed' })
          onSurfaceExit?.()
          break
        case 'close_window':
          setSurfaceState({ status: 'destroyed' })
          onSurfaceExit?.()
          break
        case 'renderer_health':
          if (!event.healthy) {
            console.warn(
              `[GhosttyTerminalPane] Renderer unhealthy for surface ${currentSurfaceId}`
            )
          }
          break
        case 'cell_size':
          // Cell size changes are informational — no UI action needed currently
          break
        case 'unsupported_action':
          // Unsupported actions are logged by the host process — no UI action needed
          break
        default:
          break
      }
    })

    return unsubscribe
  }, [onSurfaceExit, onTitleChange, onPwdChange])

  if (surfaceState.status === 'idle' || surfaceState.status === 'creating') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm">Starting Ghostty terminal...</span>
        </div>
      </div>
    )
  }

  if (surfaceState.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-destructive">
          <Ghost className="size-5" />
          <span className="text-sm">{surfaceState.message}</span>
          <button
            className="mt-2 rounded-md border px-3 py-1 text-muted-foreground text-sm hover:bg-muted"
            onClick={handleExit}
            type="button"
          >
            Close pane
          </button>
        </div>
      </div>
    )
  }

  if (surfaceState.status === 'destroyed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Ghost className="size-5" />
          <span className="text-sm">Terminal session ended</span>
        </div>
      </div>
    )
  }

  if (surfaceState.status === 'crashed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-destructive">
          <Ghost className="size-5" />
          <span className="text-sm">
            Ghostty service crashed — terminal lost
          </span>
          <span className="text-muted-foreground text-xs">
            Waiting for service recovery...
          </span>
          <div className="mt-2 flex gap-2">
            <button
              className="flex items-center gap-1 rounded-md border px-3 py-1 text-muted-foreground text-sm hover:bg-muted"
              onClick={handleReconnect}
              type="button"
            >
              <RefreshCw className="size-3" />
              Reconnect
            </button>
            <button
              className="rounded-md border px-3 py-1 text-muted-foreground text-sm hover:bg-muted"
              onClick={handleExit}
              type="button"
            >
              Close pane
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Active state — renders the native Ghostty surface via shared texture
  // (zero-copy IOSurface → VideoFrame → canvas.drawImage) when available,
  // falling back to pixel readback polling at ~30fps.
  //
  // The container div must be focusable (tabIndex) and receive keyboard events
  // to forward them to the native Ghostty surface. This is intentional — the
  // div acts as a keyboard capture surface for the terminal, similar to how
  // xterm.js uses a <textarea> for input capture.
  const ariaLabel =
    title !== ''
      ? `Ghostty Terminal: ${title}`
      : `Ghostty Terminal Surface #${surfaceState.surfaceId}`

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Terminal keyboard and mouse event handlers for input forwarding
    <div
      aria-label={ariaLabel}
      className={`flex h-full w-full flex-col bg-black outline-none${bellFlash ? 'ring-2 ring-yellow-400' : ''}`}
      data-ghostty-surface-id={surfaceState.surfaceId}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      ref={containerRef}
      role="document"
      tabIndex={-1}
    >
      <canvas
        className="min-h-0 flex-1"
        ref={canvasRef}
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  )
}

export { GhosttyTerminalPane }
