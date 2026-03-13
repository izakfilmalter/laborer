/**
 * Ghostty terminal pane — manages the lifecycle of a native Ghostty terminal
 * surface within Laborer's panel layout system.
 *
 * This component is responsible for:
 * - Creating a Ghostty surface via the DesktopBridge IPC when the pane mounts
 * - Setting focus on the surface when the pane gains/loses focus
 * - Forwarding keyboard input to the native Ghostty surface (Issue 5)
 * - Propagating resize events from the pane layout to the surface (Issue 5)
 * - Destroying the surface cleanly when the pane unmounts
 * - Showing loading, error, and placeholder states
 *
 * The component does NOT handle:
 * - Mouse input routing (Issue 6)
 * - Zero-copy rendering via WebGPU/IOSurface (Issue 3)
 * - Action callbacks like title changes (Issue 7)
 *
 * The rendered output is currently a placeholder. Issue 3 will replace this
 * with shared-surface WebGPU rendering.
 *
 * Keyboard input routing:
 * - The container div receives keyboard events via tabIndex={0}
 * - Events are translated from W3C KeyboardEvent.code to Ghostty's
 *   ghostty_input_key_e enum and sent via the DesktopBridge IPC
 * - Panel shortcuts (Ctrl+B prefix, Cmd+W, Cmd+Shift+Enter) bypass the
 *   terminal and bubble to the global hotkey layer
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
 */

import type { GhosttyKeyEvent } from '@laborer/shared/desktop-bridge'
import { Ghost, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDesktopBridge } from '@/lib/desktop'
import {
  GHOSTTY_KEY_MAP,
  RESIZE_DEBOUNCE_MS,
  translateModifiers,
} from './ghostty-keys.js'
import { shouldBypassTerminal } from './terminal-keys.js'

/** Target render rate for the pixel readback polling loop (ms). */
const RENDER_INTERVAL_MS = 33 // ~30fps

/**
 * Decode base64-encoded BGRA pixel data and draw it to a canvas.
 * Converts BGRA → RGBA in-place before creating ImageData.
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

interface GhosttyTerminalPaneProps {
  /** Whether this pane is currently focused in the panel layout. */
  readonly isFocused?: boolean | undefined
  /** Callback invoked when the surface exits or is destroyed. */
  readonly onSurfaceExit?: (() => void) | undefined
}

/**
 * Prefix mode state — when Ctrl+B is pressed, the next keypress should
 * bypass the terminal and bubble to TanStack Hotkeys for panel shortcuts.
 */
const PREFIX_TIMEOUT_MS = 1500

function GhosttyTerminalPane({
  onSurfaceExit,
  isFocused = false,
}: GhosttyTerminalPaneProps) {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>({
    status: 'idle',
  })
  const surfaceIdRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const prefixActiveRef = useRef(false)
  const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renderingRef = useRef(false)

  // Create the Ghostty surface on mount
  useEffect(() => {
    mountedRef.current = true
    const bridge = getDesktopBridge()

    if (!bridge?.ghosttyCreateSurface) {
      setSurfaceState({
        status: 'error',
        message: 'Ghostty not available (not running in Electron)',
      })
      return
    }

    setSurfaceState({ status: 'creating' })

    bridge
      .ghosttyCreateSurface()
      .then((surfaceId) => {
        if (!mountedRef.current) {
          // Component unmounted during creation — destroy immediately
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
    const id = surfaceIdRef.current
    if (id === null) {
      return
    }
    const bridge = getDesktopBridge()
    bridge?.ghosttySetFocus(id, isFocused).catch(() => {
      // Best effort — surface may have been destroyed
    })
  }, [isFocused])

  // Auto-focus the container when the pane becomes focused
  useEffect(() => {
    if (isFocused && containerRef.current) {
      containerRef.current.focus()
    }
  }, [isFocused])

  // ResizeObserver — propagate container size changes to the native surface
  useEffect(() => {
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
  }, [])

  // Pixel readback rendering loop — polls the Ghostty host for pixel data
  // and draws it to the canvas. This is the tracer-bullet path; Issue 3
  // will replace this with zero-copy WebGPU shared-texture rendering.
  useEffect(() => {
    if (surfaceState.status !== 'active') {
      return
    }

    const { surfaceId } = surfaceState
    let timerId: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const renderFrame = async () => {
      if (stopped || renderingRef.current) {
        return
      }
      renderingRef.current = true

      try {
        const bridge = getDesktopBridge()
        const result = await bridge?.ghosttyGetPixels(surfaceId)

        if (stopped || result === null || result === undefined) {
          return
        }

        const canvas = canvasRef.current
        if (canvas === null) {
          return
        }

        drawPixelsToCanvas(canvas, result.pixels, result.width, result.height)
      } catch {
        // Best effort — surface may have been destroyed or bridge disconnected
      } finally {
        renderingRef.current = false
      }

      if (!stopped) {
        timerId = setTimeout(renderFrame, RENDER_INTERVAL_MS)
      }
    }

    // Start the render loop
    timerId = setTimeout(renderFrame, RENDER_INTERVAL_MS)

    return () => {
      stopped = true
      if (timerId !== null) {
        clearTimeout(timerId)
      }
    }
  }, [surfaceState])

  // Translate a browser KeyboardEvent to a GhosttyKeyEvent and send it
  const sendKeyEvent = useCallback(
    (event: React.KeyboardEvent, action: number) => {
      const id = surfaceIdRef.current
      if (id === null) {
        return
      }

      const ghosttyKeycode = GHOSTTY_KEY_MAP.get(event.code)
      if (ghosttyKeycode === undefined) {
        // Unknown key — cannot translate
        return
      }

      const keyEvent: GhosttyKeyEvent = {
        action,
        composing: event.nativeEvent.isComposing,
        keycode: ghosttyKeycode,
        mods: translateModifiers(event),
        text: action === 1 && event.key.length === 1 ? event.key : null,
        unshiftedCodepoint:
          event.key.length === 1 ? (event.key.codePointAt(0) ?? 0) : 0,
      }

      const bridge = getDesktopBridge()
      bridge?.ghosttySendKey(id, keyEvent).catch(() => {
        // Best effort — surface may have been destroyed
      })
    },
    []
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

  // Handle the exit callback when the surface is destroyed
  const handleExit = useCallback(() => {
    onSurfaceExit?.()
  }, [onSurfaceExit])

  // Cleanup prefix timer on unmount
  useEffect(() => {
    return () => {
      if (prefixTimerRef.current !== null) {
        clearTimeout(prefixTimerRef.current)
      }
    }
  }, [])

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

  // Active state — renders the native Ghostty surface via pixel readback.
  // The canvas displays BGRA pixel data polled from the Ghostty host at ~30fps.
  // Issue 3 will replace this with zero-copy WebGPU shared-texture rendering.
  //
  // The container div must be focusable (tabIndex) and receive keyboard events
  // to forward them to the native Ghostty surface. This is intentional — the
  // div acts as a keyboard capture surface for the terminal, similar to how
  // xterm.js uses a <textarea> for input capture.
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Terminal keyboard event handlers for input forwarding
    <div
      aria-label={`Ghostty Terminal Surface #${surfaceState.surfaceId}`}
      className="flex h-full w-full flex-col bg-black outline-none"
      data-ghostty-surface-id={surfaceState.surfaceId}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
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
