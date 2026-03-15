/**
 * PanelHotkeys — Keyboard shortcuts for the panel system.
 *
 * Registers tmux-style keyboard shortcuts for panel operations using
 * TanStack Hotkeys' `useHotkeySequence` for prefix-key sequences.
 *
 * Direct shortcuts:
 * - Cmd+d → split horizontal (side-by-side)
 * - Cmd+Shift+d → split vertical (stacked)
 * - Cmd+Shift+Enter → toggle fullscreen for active terminal pane
 * - Cmd+Option+ArrowLeft → move focus to pane on the left
 * - Cmd+Option+ArrowRight → move focus to pane on the right
 * - Cmd+Option+ArrowUp → move focus to pane above
 * - Cmd+Option+ArrowDown → move focus to pane below
 *
 * Tmux-style prefix key sequences (Ctrl+b then action key):
 * - Ctrl+b then h → split horizontal (side-by-side)
 * - Ctrl+b then v → split vertical (stacked)
 * - Ctrl+b then x → close active pane
 * - Ctrl+b then o → cycle focus to next pane
 * - Ctrl+b then p → cycle focus to previous pane
 * - Ctrl+b then d → create diff panel in right-side split
 * - Ctrl+b then r → toggle review pane alongside active terminal pane
 * - Ctrl+b then s → toggle dev server terminal alongside active terminal pane
 * - Ctrl+b then z → toggle fullscreen for active terminal pane (zoom)
 * - Ctrl+b then ArrowLeft → move focus left
 * - Ctrl+b then ArrowRight → move focus right
 * - Ctrl+b then ArrowUp → move focus up
 * - Ctrl+b then ArrowDown → move focus down
 * - Ctrl+b then Shift+ArrowLeft → shrink active pane (horizontal)
 * - Ctrl+b then Shift+ArrowRight → grow active pane (horizontal)
 * - Ctrl+b then Shift+ArrowUp → shrink active pane (vertical)
 * - Ctrl+b then Shift+ArrowDown → grow active pane (vertical)
 *
 * All shortcuts operate on the currently active (focused) pane.
 * The active pane is tracked via PanelActionsContext.
 *
 * @see Issue #71: PanelManager — navigate between panes (directional navigation)
 * @see Issue #75: Keyboard shortcut — split horizontal
 * @see Issue #76: Keyboard shortcut — split vertical (also done here)
 * @see Issue #77: Keyboard shortcut — close pane (also done here)
 * @see Issue #78: Keyboard shortcut — navigate panes (also done here)
 * @see Issue #79: Keyboard shortcut — resize panes
 * @see Issue #90: Toggle diff alongside terminal
 */

import type { LeafNode, PanelNode } from '@laborer/shared/types'
import { useHotkeySequence } from '@tanstack/react-hotkeys'
import { useCallback, useEffect, useRef } from 'react'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { getDesktopBridge } from '@/lib/desktop'
import type { NavigationDirection } from '@/panels/layout-utils'
import { findNodeById, findPaneInDirection } from '@/panels/layout-utils'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'
import { computeProgressiveCloseAction } from '@/panels/window-tab-utils'

/** Timeout for the prefix key sequence (ms). */
const SEQUENCE_TIMEOUT = 1500

interface PanelHotkeysProps {
  /**
   * The root panel layout tree, used for directional navigation
   * (arrow key shortcuts). Needed to resolve spatial relationships
   * between panes based on split orientations.
   */
  readonly layout?: PanelNode | undefined
  /**
   * All leaf pane IDs in order, used for cycling focus between panes.
   * Passed from the layout owner which has access to the full tree.
   */
  readonly leafPaneIds: readonly string[]
  /**
   * Called when Cmd+W is pressed while no active pane exists.
   * Used to show the close-app confirmation dialog.
   */
  readonly onMetaWWithoutPane?: (() => void) | undefined
}

function getResizeDirectionFromEvent(
  event: KeyboardEvent
): NavigationDirection | null {
  if (!event.shiftKey) {
    return null
  }

  if (event.key === 'ArrowRight') {
    return 'right'
  }
  if (event.key === 'ArrowLeft') {
    return 'left'
  }
  if (event.key === 'ArrowDown') {
    return 'down'
  }
  if (event.key === 'ArrowUp') {
    return 'up'
  }

  return null
}

/** Map an arrow key string to a NavigationDirection, or null if not an arrow key. */
function arrowKeyToDirection(key: string): NavigationDirection | null {
  if (key === 'ArrowLeft') {
    return 'left'
  }
  if (key === 'ArrowRight') {
    return 'right'
  }
  if (key === 'ArrowUp') {
    return 'up'
  }
  if (key === 'ArrowDown') {
    return 'down'
  }
  return null
}

/**
 * Registers all panel keyboard shortcuts.
 *
 * Must be rendered inside a PanelActionsProvider and HotkeysProvider.
 * This component renders nothing — it only registers event handlers.
 */
function PanelHotkeys({
  layout,
  leafPaneIds,
  onMetaWWithoutPane,
}: PanelHotkeysProps) {
  const actions = usePanelActions()
  const activePaneId = useActivePaneId()
  const { pullWorkspace, pushWorkspace } = useWorkspaceSyncActions()
  const resizePrefixActiveRef = useRef(false)
  const resizePrefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // Cmd+W (Meta+W) should close panes, not the Electron window.
  // Capture at the window level so native close behavior is suppressed.
  useEffect(() => {
    const handleMetaW = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === 'w'
      ) {
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleMetaW)
    return () => {
      window.removeEventListener('keydown', handleMetaW)
    }
  }, [])

  const activePaneNode =
    activePaneId && layout ? findNodeById(layout, activePaneId) : undefined
  const activeWorkspaceId =
    activePaneNode?._tag === 'LeafNode' ? activePaneNode.workspaceId : undefined

  /**
   * Execute the progressive close chain: determines the correct close
   * action based on the current layout hierarchy and dispatches it.
   *
   * The chain escalates from innermost to outermost:
   * 1. Multiple panes in active panel tab → close the active pane
   * 2. Single pane in active panel tab → close the panel tab
   * 3. Last panel tab in workspace → remove the workspace
   * 4. Last workspace in window tab → close the window tab
   * 5. Last window tab → show close-app dialog
   */
  const executeProgressiveClose = useCallback(() => {
    if (!actions) {
      onMetaWWithoutPane?.()
      return
    }

    const closeAction = computeProgressiveCloseAction(
      actions.windowLayout,
      activePaneId,
      activeWorkspaceId
    )

    switch (closeAction.kind) {
      case 'close-pane':
        actions.closePane(closeAction.paneId)
        break
      case 'close-panel-tab':
        actions.removePanelTab?.(closeAction.workspaceId, closeAction.tabId)
        break
      case 'close-workspace':
        actions.closeWorkspace(closeAction.workspaceId)
        break
      case 'close-window-tab':
        actions.closeWindowTab?.()
        break
      case 'close-app':
        onMetaWWithoutPane?.()
        break
      default:
        break
    }
  }, [actions, activePaneId, activeWorkspaceId, onMetaWWithoutPane])

  // Listen for the Electron menu's 'close-pane' IPC action (Cmd+W on macOS).
  // The Electron menu dispatches this instead of using role:close, so
  // Cmd+W always routes through the panel system for instant close.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    return bridge.onMenuAction((action) => {
      if (action !== 'close-pane') {
        return
      }
      executeProgressiveClose()
    })
  }, [executeProgressiveClose])

  const triggerPushWorkspace = useCallback(() => {
    if (!activeWorkspaceId) {
      return
    }

    pushWorkspace(activeWorkspaceId).catch(() => {
      // Error state is already surfaced via toast in the shared action hook.
    })
  }, [activeWorkspaceId, pushWorkspace])

  const triggerPullWorkspace = useCallback(() => {
    if (!activeWorkspaceId) {
      return
    }

    pullWorkspace(activeWorkspaceId).catch(() => {
      // Error state is already surfaced via toast in the shared action hook.
    })
  }, [activeWorkspaceId, pullWorkspace])

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    return bridge.onMenuAction((action) => {
      if (action === 'push-workspace' && activeWorkspaceId) {
        triggerPushWorkspace()
      }
      if (action === 'pull-workspace' && activeWorkspaceId) {
        triggerPullWorkspace()
      }
    })
  }, [activeWorkspaceId, triggerPullWorkspace, triggerPushWorkspace])

  useEffect(() => {
    const clearResizePrefix = () => {
      resizePrefixActiveRef.current = false
      if (resizePrefixTimeoutRef.current !== null) {
        clearTimeout(resizePrefixTimeoutRef.current)
        resizePrefixTimeoutRef.current = null
      }
    }

    const armResizePrefix = () => {
      clearResizePrefix()
      resizePrefixActiveRef.current = true
      resizePrefixTimeoutRef.current = setTimeout(() => {
        resizePrefixActiveRef.current = false
        resizePrefixTimeoutRef.current = null
      }, SEQUENCE_TIMEOUT)
    }

    const handleResizeShortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'b'
      ) {
        armResizePrefix()
        return
      }

      if (!resizePrefixActiveRef.current) {
        return
      }

      if (event.key === 'Shift') {
        return
      }

      const direction = getResizeDirectionFromEvent(event)

      clearResizePrefix()

      if (!(actions && activePaneId && direction)) {
        return
      }

      event.preventDefault()
      actions.resizePane(activePaneId, direction)
    }

    window.addEventListener('keydown', handleResizeShortcut)
    return () => {
      clearResizePrefix()
      window.removeEventListener('keydown', handleResizeShortcut)
    }
  }, [actions, activePaneId])

  // Ctrl+b then h → split active pane horizontally (shows type picker)
  useHotkeySequence(
    ['Control+B', 'H'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId && activeWorkspaceId) {
        actions.showPanelTypePicker?.({
          kind: 'split-right',
          paneId: activePaneId,
          workspaceId: activeWorkspaceId,
        })
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then v → split active pane vertically (shows type picker)
  useHotkeySequence(
    ['Control+B', 'V'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId && activeWorkspaceId) {
        actions.showPanelTypePicker?.({
          kind: 'split-down',
          paneId: activePaneId,
          workspaceId: activeWorkspaceId,
        })
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Cmd+d → split active pane horizontally (shows type picker)
  useHotkeySequence(['Meta+D'], (event) => {
    event.preventDefault()
    if (actions && activePaneId && activeWorkspaceId) {
      actions.showPanelTypePicker?.({
        kind: 'split-right',
        paneId: activePaneId,
        workspaceId: activeWorkspaceId,
      })
    }
  })

  // Cmd+Shift+d → split active pane vertically (shows type picker)
  useHotkeySequence(['Shift+Meta+D'], (event) => {
    event.preventDefault()
    if (actions && activePaneId && activeWorkspaceId) {
      actions.showPanelTypePicker?.({
        kind: 'split-down',
        paneId: activePaneId,
        workspaceId: activeWorkspaceId,
      })
    }
  })

  // Ctrl+b then x → progressive close (same chain as Cmd+W)
  useHotkeySequence(
    ['Control+B', 'X'],
    (event) => {
      event.preventDefault()
      executeProgressiveClose()
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Cmd+w (Meta+W) → progressive close: escalates from pane → tab → workspace → window tab → app
  useHotkeySequence(['Meta+W'], (event) => {
    event.preventDefault()
    executeProgressiveClose()
  })

  // Ctrl+b then o → cycle focus to next pane
  useHotkeySequence(
    ['Control+B', 'O'],
    (event) => {
      event.preventDefault()
      if (!actions || leafPaneIds.length === 0) {
        return
      }
      const currentIndex = activePaneId ? leafPaneIds.indexOf(activePaneId) : -1
      const nextIndex = (currentIndex + 1) % leafPaneIds.length
      const nextPaneId = leafPaneIds[nextIndex]
      if (nextPaneId) {
        actions.setActivePaneId(nextPaneId)
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then p → cycle focus to previous pane
  useHotkeySequence(
    ['Control+B', 'P'],
    (event) => {
      event.preventDefault()
      if (!actions || leafPaneIds.length === 0) {
        return
      }
      const currentIndex = activePaneId ? leafPaneIds.indexOf(activePaneId) : 0
      const prevIndex =
        (currentIndex - 1 + leafPaneIds.length) % leafPaneIds.length
      const prevPaneId = leafPaneIds[prevIndex]
      if (prevPaneId) {
        actions.setActivePaneId(prevPaneId)
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then d → create a new diff panel in a right-side split
  useHotkeySequence(
    ['Control+B', 'D'],
    (event) => {
      event.preventDefault()
      if (!actions) {
        return
      }
      if (activePaneId && activeWorkspaceId) {
        // Split right with a diff pane inheriting the workspace context
        actions.splitPane(activePaneId, 'horizontal', {
          paneType: 'diff',
          workspaceId: activeWorkspaceId,
        } as Partial<LeafNode>)
      } else if (activeWorkspaceId) {
        // No active pane — add as a new panel tab
        actions.addPanelTab?.(activeWorkspaceId, 'diff')
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then r → create a new review panel in a right-side split
  useHotkeySequence(
    ['Control+B', 'R'],
    (event) => {
      event.preventDefault()
      if (!actions) {
        return
      }
      if (activePaneId && activeWorkspaceId) {
        // Split right with a review pane inheriting the workspace context
        actions.splitPane(activePaneId, 'horizontal', {
          paneType: 'review',
          workspaceId: activeWorkspaceId,
        } as Partial<LeafNode>)
      } else if (activeWorkspaceId) {
        // No active pane — add as a new panel tab
        actions.addPanelTab?.(activeWorkspaceId, 'review')
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then s → create a new dev server terminal panel in a right-side split
  useHotkeySequence(
    ['Control+B', 'S'],
    (event) => {
      event.preventDefault()
      if (!actions) {
        return
      }
      if (activePaneId && activeWorkspaceId) {
        // Split right with a dev server terminal pane inheriting the workspace context
        actions.splitPane(activePaneId, 'horizontal', {
          paneType: 'devServerTerminal',
          workspaceId: activeWorkspaceId,
        } as Partial<LeafNode>)
      } else if (activeWorkspaceId) {
        // No active pane — add as a new panel tab
        actions.addPanelTab?.(activeWorkspaceId, 'devServerTerminal')
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Cmd+Shift+Enter → toggle fullscreen for active terminal pane
  useHotkeySequence(['Shift+Meta+Enter'], (event) => {
    event.preventDefault()
    if (actions) {
      actions.toggleFullscreenPane()
    }
  })

  useHotkeySequence(['Meta+P'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      triggerPushWorkspace()
    }
  })

  useHotkeySequence(['Shift+Meta+P'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      triggerPullWorkspace()
    }
  })

  // Ctrl+b then z → toggle fullscreen for active terminal pane (tmux-style zoom)
  useHotkeySequence(
    ['Control+B', 'Z'],
    (event) => {
      event.preventDefault()
      if (actions) {
        actions.toggleFullscreenPane()
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // --- Directional navigation (Ctrl+b then arrow key) ---
  // Navigate to the pane in the given direction based on the layout
  // tree's spatial structure (split orientations).
  const navigateDirection = (
    event: KeyboardEvent,
    direction: NavigationDirection
  ) => {
    event.preventDefault()
    if (!(actions && activePaneId && layout)) {
      return
    }
    const targetId = findPaneInDirection(layout, activePaneId, direction)
    if (targetId) {
      actions.setActivePaneId(targetId)
    }
  }

  // Ctrl+b then ArrowLeft → move focus to the pane on the left
  useHotkeySequence(
    ['Control+B', 'ArrowLeft'],
    (event) => navigateDirection(event, 'left'),
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then ArrowRight → move focus to the pane on the right
  useHotkeySequence(
    ['Control+B', 'ArrowRight'],
    (event) => navigateDirection(event, 'right'),
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then ArrowUp → move focus to the pane above
  useHotkeySequence(
    ['Control+B', 'ArrowUp'],
    (event) => navigateDirection(event, 'up'),
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then ArrowDown → move focus to the pane below
  useHotkeySequence(
    ['Control+B', 'ArrowDown'],
    (event) => navigateDirection(event, 'down'),
    { timeout: SEQUENCE_TIMEOUT }
  )

  // --- tmux-style direct navigation (Cmd+Option+Arrow) ---
  // Navigate to the pane in the given direction with a single shortcut,
  // no prefix key required. Uses raw keydown handler because TanStack
  // Hotkeys may not handle Alt+Meta+Arrow reliably on macOS (Option key
  // can produce special characters for some key combinations).
  useEffect(() => {
    const handleMetaAltArrow = (event: KeyboardEvent) => {
      if (!(event.metaKey && event.altKey) || event.ctrlKey || event.shiftKey) {
        return
      }
      const direction = arrowKeyToDirection(event.key)
      if (direction) {
        event.preventDefault()
        if (!(actions && activePaneId && layout)) {
          return
        }
        const targetId = findPaneInDirection(layout, activePaneId, direction)
        if (targetId) {
          actions.setActivePaneId(targetId)
        }
      }
    }
    window.addEventListener('keydown', handleMetaAltArrow)
    return () => {
      window.removeEventListener('keydown', handleMetaAltArrow)
    }
  }, [actions, activePaneId, layout])

  // --- Panel tab shortcuts ---

  // Ctrl+T → show type picker, then create new panel tab in focused workspace
  useHotkeySequence(['Control+T'], (event) => {
    event.preventDefault()
    if (actions && activeWorkspaceId) {
      actions.showPanelTypePicker?.({
        kind: 'new-tab',
        workspaceId: activeWorkspaceId,
      })
    }
  })

  // Ctrl+1 through Ctrl+8 → switch to panel tab by index in focused workspace
  useHotkeySequence(['Control+1'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 1)
    }
  })
  useHotkeySequence(['Control+2'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 2)
    }
  })
  useHotkeySequence(['Control+3'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 3)
    }
  })
  useHotkeySequence(['Control+4'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 4)
    }
  })
  useHotkeySequence(['Control+5'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 5)
    }
  })
  useHotkeySequence(['Control+6'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 6)
    }
  })
  useHotkeySequence(['Control+7'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 7)
    }
  })
  useHotkeySequence(['Control+8'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 8)
    }
  })

  // Ctrl+9 → switch to last panel tab in focused workspace
  useHotkeySequence(['Control+9'], (event) => {
    event.preventDefault()
    if (activeWorkspaceId) {
      actions?.switchPanelTabByIndex?.(activeWorkspaceId, 9)
    }
  })

  // Ctrl+Shift+[ and Ctrl+Shift+] → cycle panel tabs in focused workspace
  // Uses raw keydown handler because TanStack Hotkeys doesn't support
  // bracket key names in its Hotkey type.
  useEffect(() => {
    const handlePanelTabCycle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.shiftKey) || event.metaKey || event.altKey) {
        return
      }
      if (!activeWorkspaceId) {
        return
      }
      // Use event.code for layout-stable matching — event.key reports
      // '{' / '}' when Shift is held, not '[' / ']'.
      if (event.code === 'BracketLeft') {
        event.preventDefault()
        actions?.switchPanelTabRelative?.(activeWorkspaceId, -1)
      } else if (event.code === 'BracketRight') {
        event.preventDefault()
        actions?.switchPanelTabRelative?.(activeWorkspaceId, 1)
      }
    }
    window.addEventListener('keydown', handlePanelTabCycle)
    return () => {
      window.removeEventListener('keydown', handlePanelTabCycle)
    }
  }, [actions, activeWorkspaceId])

  // --- Window tab shortcuts ---

  // Cmd+N → create new window tab
  useHotkeySequence(['Meta+N'], (event) => {
    event.preventDefault()
    actions?.addWindowTab?.()
  })

  // Cmd+Shift+W → close active window tab
  useHotkeySequence(['Shift+Meta+W'], (event) => {
    event.preventDefault()
    actions?.closeWindowTab?.()
  })

  // Cmd+1 through Cmd+8 → switch to window tab by index
  useHotkeySequence(['Meta+1'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(1)
  })
  useHotkeySequence(['Meta+2'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(2)
  })
  useHotkeySequence(['Meta+3'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(3)
  })
  useHotkeySequence(['Meta+4'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(4)
  })
  useHotkeySequence(['Meta+5'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(5)
  })
  useHotkeySequence(['Meta+6'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(6)
  })
  useHotkeySequence(['Meta+7'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(7)
  })
  useHotkeySequence(['Meta+8'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(8)
  })

  // Cmd+9 → switch to last window tab
  useHotkeySequence(['Meta+9'], (event) => {
    event.preventDefault()
    actions?.switchWindowTabByIndex?.(9)
  })

  // Cmd+Shift+[ and Cmd+Shift+] → cycle window tabs
  // Uses raw keydown handler because TanStack Hotkeys doesn't support
  // bracket key names in its Hotkey type.
  useEffect(() => {
    const handleWindowTabCycle = (event: KeyboardEvent) => {
      if (!(event.metaKey && event.shiftKey) || event.ctrlKey || event.altKey) {
        return
      }
      // Use event.code for layout-stable matching — event.key reports
      // '{' / '}' when Shift is held, not '[' / ']'.
      if (event.code === 'BracketLeft') {
        event.preventDefault()
        actions?.switchWindowTabRelative?.(-1)
      } else if (event.code === 'BracketRight') {
        event.preventDefault()
        actions?.switchWindowTabRelative?.(1)
      }
    }
    window.addEventListener('keydown', handleWindowTabCycle)
    return () => {
      window.removeEventListener('keydown', handleWindowTabCycle)
    }
  }, [actions])

  return null
}

export { PanelHotkeys }
