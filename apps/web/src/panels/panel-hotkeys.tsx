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
 *
 * Tmux-style prefix key sequences (Ctrl+b then action key):
 * - Ctrl+b then h → split horizontal (side-by-side)
 * - Ctrl+b then v → split vertical (stacked)
 * - Ctrl+b then x → close active pane
 * - Ctrl+b then o → cycle focus to next pane
 * - Ctrl+b then p → cycle focus to previous pane
 * - Ctrl+b then d → toggle diff viewer alongside active terminal pane
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

import type { PanelNode } from '@laborer/shared/types'
import { useHotkeySequence } from '@tanstack/react-hotkeys'
import { useEffect, useRef } from 'react'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { getDesktopBridge } from '@/lib/desktop'
import type { NavigationDirection } from '@/panels/layout-utils'
import { findNodeById, findPaneInDirection } from '@/panels/layout-utils'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'

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
      if (actions && activePaneId) {
        actions.closePane(activePaneId)
        return
      }
      onMetaWWithoutPane?.()
    })
  }, [actions, activePaneId, onMetaWWithoutPane])

  const activePaneNode =
    activePaneId && layout ? findNodeById(layout, activePaneId) : undefined
  const activeWorkspaceId =
    activePaneNode?._tag === 'LeafNode' ? activePaneNode.workspaceId : undefined

  const triggerPushWorkspace = () => {
    if (!activeWorkspaceId) {
      return
    }

    pushWorkspace(activeWorkspaceId).catch(() => {
      // Error state is already surfaced via toast in the shared action hook.
    })
  }

  const triggerPullWorkspace = () => {
    if (!activeWorkspaceId) {
      return
    }

    pullWorkspace(activeWorkspaceId).catch(() => {
      // Error state is already surfaced via toast in the shared action hook.
    })
  }

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

  // Ctrl+b then h → split active pane horizontally
  useHotkeySequence(
    ['Control+B', 'H'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.splitPane(activePaneId, 'horizontal')
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then v → split active pane vertically
  useHotkeySequence(
    ['Control+B', 'V'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.splitPane(activePaneId, 'vertical')
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Cmd+d → split active pane horizontally (Ghostty-style)
  useHotkeySequence(['Meta+D'], (event) => {
    event.preventDefault()
    if (actions && activePaneId) {
      actions.splitPane(activePaneId, 'horizontal')
    }
  })

  // Cmd+Shift+d → split active pane vertically (Ghostty-style)
  useHotkeySequence(['Shift+Meta+D'], (event) => {
    event.preventDefault()
    if (actions && activePaneId) {
      actions.splitPane(activePaneId, 'vertical')
    }
  })

  // Ctrl+b then x → close active pane
  useHotkeySequence(
    ['Control+B', 'X'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.closePane(activePaneId)
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Cmd+w (Meta+W) → close active pane directly
  useHotkeySequence(['Meta+W'], (event) => {
    event.preventDefault()
    if (actions && activePaneId) {
      actions.closePane(activePaneId)
      return
    }
    onMetaWWithoutPane?.()
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

  // Ctrl+b then d → toggle diff viewer alongside active terminal pane
  useHotkeySequence(
    ['Control+B', 'D'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.toggleDiffPane(activePaneId)
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then r → toggle review pane alongside active terminal pane
  useHotkeySequence(
    ['Control+B', 'R'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.toggleReviewPane(activePaneId)
      }
    },
    { timeout: SEQUENCE_TIMEOUT }
  )

  // Ctrl+b then s → toggle dev server terminal alongside active terminal pane
  useHotkeySequence(
    ['Control+B', 'S'],
    (event) => {
      event.preventDefault()
      if (actions && activePaneId) {
        actions.toggleDevServerPane(activePaneId)
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

  return null
}

export { PanelHotkeys }
