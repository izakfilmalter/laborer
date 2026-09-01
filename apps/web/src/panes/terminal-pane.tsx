/**
 * Terminal pane component — renders PTY output through the vendored Ghostty
 * surface, over the daemon's `terminal.attach` stream.
 *
 * Data flow:
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to its headless mirror + notifies subscribers
 * 3. The attach RPC stream forwards output to the renderer
 * 4. `useTerminalRpc` decides what each frame means for this screen
 * 5. The frame is parsed by `GhosttyTerminalSurface`, synchronously
 *
 * Transport: `terminal.attach` over the daemon's shared WebSocket RPC.
 *
 * Input flow:
 * - Keystrokes are encoded by Ghostty's key encoder and delivered via `onData`
 * - Sent through the hook's bounded, ordered `terminal.write` lane
 * - Terminal service forwards to PTY via PtyHostClient.write()
 *
 * Sizing:
 * - The surface measures its own mount and debounces the PTY resize itself, so
 *   the pane holds no ResizeObserver and no debouncer. `onResize` is the single
 *   channel to `terminal.resize`.
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - The surface hands every keydown to `beforeKey` before encoding it.
 *   Returning `false` leaves the event to bubble to TanStack Hotkeys on
 *   document; returning `true` lets Ghostty encode it for the PTY.
 *
 * @see packages/terminal/src/services/terminal-manager.ts — headless mirror
 * @see apps/web/src/hooks/use-terminal-rpc.ts — attach lifecycle
 * @see apps/web/src/lib/terminal-screen.ts — surface identity and lifetime
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@laborer/ui/components/context-menu'
import { Spinner } from '@laborer/ui/components/spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import {
  TERMINAL_REVIVAL_ANNOUNCEMENT,
  TerminalRevivalMarker,
} from '@/components/terminal-revival-marker'
import { useTerminalRpc } from '@/hooks/use-terminal-rpc'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { shouldBypassTerminal } from '@/lib/keybinds'
import { localApi } from '@/lib/local-api'
import { handleTerminalKeyEvent } from '@/lib/terminal-keyboard'
import {
  openTerminalLink,
  type TerminalContextMenuAction,
  terminalContextMenuItems,
} from '@/lib/terminal-links'
import {
  createTerminalScreen,
  type TerminalScreen,
  type TerminalScreenCanvas,
} from '@/lib/terminal-screen'
import { toast } from '@/lib/toast'
import type { GhosttyTheme } from '@/terminal/ghostty/core'
import { GhosttyTerminalSurface } from '@/terminal/ghostty/surface'
import {
  showTerminalRevivalMarker,
  terminalLoadingMessage,
} from './terminal-loading-state'

const resizeMutation = TerminalServiceClient.mutation('terminal.resize')
type ReplayStatus = 'idle' | 'replaying' | 'complete'
type TerminalStatus = 'running' | 'stopped' | 'restarted'

/**
 * The pane's palette, in the form Ghostty takes it.
 *
 * Only these four colors are ours. The sixteen ANSI colors reach the screen
 * through SGR sequences Ghostty resolves against its own built-in palette,
 * which the vendored core exposes no way to override, so those stay Ghostty's.
 */
const TERMINAL_THEME: GhosttyTheme = {
  /** zinc-950 `#09090b`, matching the app's dark background. */
  background: { r: 9, g: 9, b: 11 },
  /** zinc-50 `#fafafa`. */
  cursor: { r: 250, g: 250, b: 250 },
  foreground: { r: 250, g: 250, b: 250 },
  /** zinc-800 at 50% alpha. */
  selectionBackground: 'rgb(39 39 42 / 50%)',
}

const TERMINAL_FONT = { family: 'JetBrains Mono', size: 13 } as const

/**
 * What the right-click menu was opened over. Captured at open time because the
 * hovered link and the selection can both change while the menu is up.
 */
interface TerminalContextMenuTarget {
  readonly link: string | null
  readonly selection: string
}

type TerminalContextMenuState = TerminalContextMenuTarget | null

/**
 * Run a terminal right-click action against the live surface. Paste goes
 * through the surface so bracketed-paste mode is honored.
 */
const runTerminalContextAction = async (
  action: TerminalContextMenuAction,
  context: TerminalContextMenuTarget,
  surface: GhosttyTerminalSurface | null
): Promise<void> => {
  if (action === 'open-link') {
    if (context.link) {
      openTerminalLink(context.link)
    }
    return
  }
  if (action === 'copy-link') {
    if (context.link) {
      await navigator.clipboard.writeText(context.link)
    }
    return
  }
  if (action === 'copy') {
    if (context.selection.length > 0) {
      await navigator.clipboard.writeText(context.selection)
    }
    return
  }
  await surface?.pasteFromClipboard(() => navigator.clipboard.readText())
}

/** Connection result shape for the terminal attach RPC hook. */
interface TerminalConnection {
  readonly dismissRevival?: (() => void) | undefined
  readonly replayStatus: ReplayStatus
  readonly send: (data: string) => void
  readonly status: 'connecting' | 'connected' | 'disconnected'
  readonly terminalStatus: TerminalStatus
  readonly wasRevived?: boolean
}

interface TerminalPaneProps {
  /**
   * Callback invoked when the terminal process exits (status becomes
   * "stopped"). Used by the panel system to auto-close the pane when a
   * terminal is closed.
   */
  readonly onTerminalExit?: (() => void) | undefined
  /** The terminal ID to subscribe to for output events. */
  readonly terminalId: string
}

/**
 * TerminalPane renders a live terminal view for a given terminal ID.
 *
 * Waits for the lifecycle phase to reach Restored (terminal sidecar
 * available) before rendering the terminal. Shows a connecting placeholder
 * in the meantime.
 */
function TerminalPane({ terminalId, onTerminalExit }: TerminalPaneProps) {
  const isRestored = useWhenPhase(LifecyclePhase.Restored)

  if (!isRestored) {
    return <TerminalConnectingPlaceholder />
  }

  return (
    <TerminalPaneRpc onTerminalExit={onTerminalExit} terminalId={terminalId} />
  )
}

/**
 * Placeholder shown when the terminal service is still connecting (before
 * Phase 3 / Restored).
 */
function TerminalConnectingPlaceholder() {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background"
      data-testid="terminal-connecting-placeholder"
    >
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">
        Terminal service connecting...
      </p>
    </div>
  )
}

/** Browser terminal transport over terminal.attach on the daemon's single WS. */
function TerminalPaneRpc({ terminalId, onTerminalExit }: TerminalPaneProps) {
  /**
   * The screen outlives each attach and each attach outlives nothing: the
   * daemon can reconnect under a mounted surface, and React can rebuild the
   * surface under a live attach. Owning it here, above both, is what lets the
   * two lifetimes be told apart.
   */
  const [screen] = useState(createTerminalScreen)

  const connection = useTerminalRpc({
    onStatus: (status) => {
      if (status === 'stopped') {
        onTerminalExit?.()
      }
    },
    screen,
    terminalId,
  })

  return (
    <TerminalPaneRenderer
      connection={connection}
      screen={screen}
      terminalId={terminalId}
    />
  )
}

/** Props for the shared terminal renderer component. */
interface TerminalPaneRendererProps {
  readonly connection: TerminalConnection
  readonly screen: TerminalScreen
  readonly terminalId: string
}

/**
 * Shared terminal renderer — owns the Ghostty surface's lifetime and the pane
 * chrome around it. Transport-agnostic: receives connection state and the send
 * function via props.
 */
function TerminalPaneRenderer({
  terminalId,
  connection,
  screen,
}: TerminalPaneRendererProps) {
  const {
    dismissRevival,
    send: connectionSend,
    status: connectionStatus,
    replayStatus,
    terminalStatus,
    wasRevived = false,
  } = connection
  const resizeTerminal = useAtomSet(resizeMutation)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalElementRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState>(null)

  const isRunning = terminalStatus !== 'stopped'
  const loadingMessage = terminalLoadingMessage({ isRunning, replayStatus })
  /** Revival is only truthful once the restored history is fully on screen. */
  const showRevivalMarker = showTerminalRevivalMarker({
    replayStatus,
    wasRevived,
  })

  /**
   * The surface is built before the attach exists, and the callbacks it
   * captures at creation outlive every render, so everything they reach for
   * goes through a ref.
   */
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  const connectionSendRef = useRef(connectionSend)
  connectionSendRef.current = connectionSend

  const resizeTerminalRef = useRef(resizeTerminal)
  resizeTerminalRef.current = resizeTerminal

  const terminalIdRef = useRef(terminalId)
  terminalIdRef.current = terminalId

  const executeTerminalContextAction = useCallback(
    (action: TerminalContextMenuAction, context: TerminalContextMenuTarget) => {
      runTerminalContextAction(action, context, surfaceRef.current).catch(
        () => {
          toast.error('Clipboard is unavailable.')
        }
      )
    },
    []
  )

  /**
   * Capture what the pointer is over, then hand off: Electron shows the native
   * menu, the browser falls through to the Base UI menu on the trigger.
   */
  const handleTerminalContextMenu = useCallback(
    (event: Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>) => {
      const surface = surfaceRef.current
      const context = {
        link: surface?.linkAtPoint(event.clientX, event.clientY) ?? null,
        selection: surface?.getSelection() ?? '',
      }
      setContextMenu(context)

      if (localApi.contextMenuKind !== 'native') {
        return
      }

      event.preventDefault()
      localApi
        .showContextMenu<TerminalContextMenuAction>(
          terminalContextMenuItems({
            link: context.link,
            hasSelection: context.selection.length > 0,
          }),
          { x: event.clientX, y: event.clientY },
          async () => null
        )
        .then((action) =>
          action ? executeTerminalContextAction(action, context) : undefined
        )
        .catch(() => {
          toast.error('Could not open the terminal menu.')
        })
    },
    [executeTerminalContextAction]
  )

  /**
   * Build the Ghostty surface and publish it as this pane's screen.
   *
   * `create` is async — the WASM module and the terminal fonts load first — and
   * StrictMode mounts twice, so the cleanup has to be able to retire a surface
   * that has not been handed back yet. `dispose()` is the only teardown the
   * surface offers, it owns its own observers and media listeners, and it is
   * idempotent.
   *
   * Publishing the surface as a canvas is what gives it an identity: the attach
   * reads the screen's generation to decide whether it may resume a cursor or
   * must ask for a snapshot it can draw from scratch. Until then the screen has
   * no generation and the hook holds the attach closed, so no replay is aimed
   * at a screen that cannot show it.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    let disposed = false
    let created: GhosttyTerminalSurface | null = null
    let canvas: TerminalScreenCanvas | null = null

    GhosttyTerminalSurface.create(container, {
      beforeKey: (event) =>
        handleTerminalKeyEvent(event, {
          isRunning: isRunningRef.current,
          send: connectionSendRef.current,
          shouldBypass: shouldBypassTerminal,
        }),
      font: TERMINAL_FONT,
      onData: (data) => {
        // A stopped terminal keeps its final screen selectable and scrollable,
        // but there is no process left to type at.
        if (!isRunningRef.current) {
          return
        }
        connectionSendRef.current(data)
      },
      onLinkActivate: (text) => {
        openTerminalLink(text)
      },
      onResize: (cols, rows) => {
        if (cols <= 0 || rows <= 0) {
          return
        }
        resizeTerminalRef.current({
          payload: { id: terminalIdRef.current, cols, rows },
        })
      },
      onSelectionChange: () => {
        // The pane has no selection-driven chrome; the surface owns the copy
        // shortcuts and the highlight itself.
      },
      theme: TERMINAL_THEME,
    }).then(
      (surface) => {
        if (disposed) {
          surface.dispose()
          return
        }
        created = surface
        surfaceRef.current = surface
        setSurfaceError(null)
        canvas = {
          resetAndWrite: (data) => {
            surface.resetAndWrite(data)
          },
          write: (data) => {
            surface.write(data)
          },
        }
        screen.mount(canvas)
        if (import.meta.env.DEV && terminalElementRef.current) {
          Reflect.set(terminalElementRef.current, 'ghostty', {
            focus: () => {
              surface.focus()
            },
            text: () => surface.viewportText().join('\n'),
          })
        }
      },
      (error: unknown) => {
        if (!disposed) {
          setSurfaceError(
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    )

    return () => {
      disposed = true
      // Retire the screen before disposing the surface so no further output is
      // handed to a terminal that is being torn down.
      if (canvas) {
        screen.unmount(canvas)
        canvas = null
      }
      if (terminalElementRef.current) {
        Reflect.deleteProperty(terminalElementRef.current, 'ghostty')
      }
      created?.dispose()
      created = null
      surfaceRef.current = null
    }
  }, [screen])

  /**
   * Electron replaces the DOM menu with the OS one, and the surface owns the
   * markup inside the container, so the listener is attached here rather than
   * through a JSX handler on an element that has no interactive role of its own.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || localApi.contextMenuKind !== 'native') {
      return
    }

    container.addEventListener('contextmenu', handleTerminalContextMenu)
    return () => {
      container.removeEventListener('contextmenu', handleTerminalContextMenu)
    }
  }, [handleTerminalContextMenu])

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#09090b]"
      data-terminal-id={terminalId}
      data-testid="terminal-emulator"
      ref={terminalElementRef}
    >
      {/* Ghostty container — the surface appends its canvas, IME textarea and
          scrollbar here and measures it for the grid, so it owns the children.
          Right-click offers link, copy, and paste actions for whatever the
          pointer is over. Electron shows the OS menu directly; the browser
          needs the DOM menu around the canvas. */}
      {localApi.contextMenuKind === 'native' ? (
        <div className="relative h-full w-full" ref={containerRef} />
      ) : (
        <ContextMenu
          onOpenChange={(open) => {
            if (!open) {
              setContextMenu(null)
            }
          }}
        >
          <ContextMenuTrigger
            className="h-full w-full select-text"
            onContextMenu={handleTerminalContextMenu}
          >
            <div className="relative h-full w-full" ref={containerRef} />
          </ContextMenuTrigger>
          {contextMenu !== null && (
            <ContextMenuContent className="min-w-40">
              {terminalContextMenuItems({
                link: contextMenu.link,
                hasSelection: contextMenu.selection.length > 0,
              }).map((item) => (
                <ContextMenuItem
                  key={item.id}
                  onSelect={() => {
                    executeTerminalContextAction(item.id, contextMenu)
                  }}
                >
                  {item.label}
                </ContextMenuItem>
              ))}
            </ContextMenuContent>
          )}
        </ContextMenu>
      )}

      {/* The renderer itself failed to start — a missing WASM artifact, a
          browser without Canvas 2D. There is no terminal to show, so say so
          rather than leaving an empty black rectangle. */}
      {surfaceError !== null && (
        <div
          className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm"
          data-testid="terminal-renderer-error"
        >
          Terminal renderer failed to start: {surfaceError}
        </div>
      )}

      {/* Loading overlay — shown while the PTY is spawning and no output has
          arrived yet, and again while a reconnect replays history. Covers the
          terminal canvas with a spinner and message, lifting once the daemon
          reports the replay complete — which, with a synchronous renderer, is
          also the moment it is on screen. A stopped terminal skips startup but
          still replays, so it is covered while its final screen is restored. */}
      {loadingMessage !== undefined && (
        <TerminalLoadingOverlay message={loadingMessage} />
      )}

      {/* Data channel disconnection indicator */}
      {connectionStatus === 'disconnected' && isRunning && (
        <DisconnectedBanner />
      )}

      {/* Connecting indicator */}
      {connectionStatus === 'connecting' && isRunning && <ReconnectingBanner />}

      {/* Tier-iii revival marker — the shell is new, so the restored output
          is labelled rather than passed off as a surviving process. It waits
          for replay to finish and stays until acknowledged. The spoken form
          sits in an always-mounted region so it is not swallowed by the
          region appearing with its own content. */}
      <output aria-live="polite" className="sr-only">
        {showRevivalMarker ? TERMINAL_REVIVAL_ANNOUNCEMENT : ''}
      </output>
      {showRevivalMarker && (
        <TerminalRevivalMarker
          belowBanner={isRunning && connectionStatus !== 'connected'}
          onDismiss={dismissRevival}
        />
      )}

      {/* Status banner — shown when terminal process has exited */}
      {!isRunning && (
        <div className="absolute inset-x-0 bottom-0 border-border/50 border-t bg-muted/90 px-3 py-1.5 text-center text-muted-foreground text-xs backdrop-blur-sm">
          Process exited — terminal output preserved (read-only)
        </div>
      )}
    </div>
  )
}

/**
 * Loading overlay shown while waiting for the terminal's replay to land.
 * Covers the blank terminal canvas with a centered spinner and status message.
 * Uses the terminal's background color (zinc-950) to blend seamlessly.
 */
function TerminalLoadingOverlay({ message }: { readonly message: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  )
}

/** Banner shown when the data channel is disconnected but the terminal is still running. */
function DisconnectedBanner() {
  return (
    <div
      className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm"
      data-testid="terminal-connection-status"
    >
      Disconnected — reconnecting...
    </div>
  )
}

/** Banner shown while the data channel is connecting. */
function ReconnectingBanner() {
  return (
    <div
      className="absolute inset-x-0 top-0 border-warning/50 border-b bg-warning/10 px-3 py-1 text-center text-warning text-xs backdrop-blur-sm"
      data-testid="terminal-connection-status"
    >
      Connecting...
    </div>
  )
}

export { TerminalPane }
