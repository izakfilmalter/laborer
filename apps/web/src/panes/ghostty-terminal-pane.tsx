/**
 * Ghostty terminal pane — manages the lifecycle of a native Ghostty terminal
 * surface within Laborer's panel layout system.
 *
 * This component is responsible for:
 * - Creating a Ghostty surface via the DesktopBridge IPC when the pane mounts
 * - Setting focus on the surface when the pane gains/loses focus
 * - Destroying the surface cleanly when the pane unmounts
 * - Showing loading, error, and placeholder states
 *
 * The component does NOT handle:
 * - Keyboard/mouse input routing (Issue 5/6)
 * - Zero-copy rendering via WebGPU/IOSurface (Issue 3)
 * - Action callbacks like title changes (Issue 7)
 *
 * The rendered output is currently a placeholder. Issue 3 will replace this
 * with shared-surface WebGPU rendering, and Issue 5 will add input routing.
 *
 * @see packages/ghostty/src/ghostty-host.ts — Ghostty Host IPC protocol
 * @see apps/desktop/src/ghostty-bridge.ts — Main process IPC relay
 * @see Issue 4: Ghostty terminal lifecycle and pane integration
 */

import { Ghost, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDesktopBridge } from '@/lib/desktop'

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

function GhosttyTerminalPane({
  onSurfaceExit,
  isFocused = false,
}: GhosttyTerminalPaneProps) {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>({
    status: 'idle',
  })
  const surfaceIdRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

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

  // Handle the exit callback when the surface is destroyed
  const handleExit = useCallback(() => {
    onSurfaceExit?.()
  }, [onSurfaceExit])

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

  // Active state — placeholder for the native surface rendering.
  // Issue 3 will replace this with WebGPU shared-texture display.
  // Issue 5 will add keyboard/mouse event forwarding.
  return (
    <div
      className="flex h-full w-full flex-col bg-black"
      data-ghostty-surface-id={surfaceState.surfaceId}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-border/50 border-b bg-zinc-900 px-2">
        <Ghost className="size-3 text-purple-400" />
        <span className="font-medium text-purple-400 text-xs">
          Ghostty Surface #{surfaceState.surfaceId}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-zinc-500">
          <Ghost className="size-8" />
          <span className="text-sm">
            Ghostty surface active — rendering pending (Issue 3)
          </span>
          <span className="text-xs">Input routing pending (Issue 5)</span>
        </div>
      </div>
    </div>
  )
}

export { GhosttyTerminalPane }
