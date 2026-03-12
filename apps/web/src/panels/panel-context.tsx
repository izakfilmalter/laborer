/**
 * PanelContext — React context for panel layout actions and active pane state.
 *
 * Provides split/close actions and active pane tracking to pane components
 * deep in the tree. The layout owner (e.g., the route component that manages
 * the PanelNode state) provides the action implementations and active pane
 * state via PanelActionsProvider.
 * Pane components consume them via usePanelActions() and useActivePaneId().
 *
 * @see Issue #69: PanelManager — recursive splits
 * @see Issue #75: Keyboard shortcut — split horizontal
 */

import type { LeafNode, SplitDirection } from '@laborer/shared/types'
import { createContext, useContext } from 'react'

/**
 * Direction for pane resize operations.
 * Duplicated from layout-utils to avoid circular imports.
 */
type ResizeDirection = 'left' | 'right' | 'up' | 'down'

interface PanelActions {
  /**
   * Assign a terminal to an existing pane or the first available empty pane.
   * If no paneId is given, finds the first empty terminal pane in the tree
   * or creates a new pane via split.
   *
   * @param terminalId - The terminal to display
   * @param workspaceId - The workspace the terminal belongs to
   * @param paneId - Optional specific pane to assign to
   */
  readonly assignTerminalToPane: (
    terminalId: string,
    workspaceId: string,
    paneId?: string
  ) => void
  /**
   * Close a pane and remove it from the layout.
   * If it's the last pane, the layout becomes empty.
   *
   * @param paneId - The ID of the LeafNode to close
   */
  readonly closePane: (paneId: string) => void

  /**
   * Close a terminal and remove its pane from the layout.
   *
   * Finds the pane associated with the given terminal, then closes it
   * (which also removes the terminal from the service). If no pane is
   * found, the terminal is removed from the service directly.
   *
   * @param terminalId - The ID of the terminal to close
   */
  readonly closeTerminalPane: (terminalId: string) => void
  /**
   * Resize the active pane in the given direction.
   *
   * Grows or shrinks the active pane by a fixed step (5%), taking from
   * or giving to the adjacent sibling in the parent split. The direction
   * determines both which axis to resize on and whether to grow or shrink:
   * - Right/Down → grow the active pane
   * - Left/Up → shrink the active pane
   *
   * Minimum pane size is enforced.
   *
   * @param paneId - The ID of the pane to resize
   * @param direction - The direction to resize in
   * @see Issue #79: Keyboard shortcut — resize panes
   */
  readonly resizePane: (paneId: string, direction: ResizeDirection) => void
  /**
   * Set the active (focused) pane.
   *
   * @param paneId - The ID of the pane to focus, or null to clear focus
   */
  readonly setActivePaneId: (paneId: string | null) => void
  /**
   * Split a pane into two. The original pane stays; a new sibling pane
   * is added in the given direction.
   *
   * @param paneId - The ID of the LeafNode to split
   * @param direction - "horizontal" (side-by-side) or "vertical" (stacked)
   * @param newPaneContent - Optional content for the new pane
   */
  readonly splitPane: (
    paneId: string,
    direction: SplitDirection,
    newPaneContent?: Partial<LeafNode>
  ) => void
  /**
   * Toggle the dev server terminal alongside a terminal pane.
   *
   * When toggled ON: the dev server terminal pane is rendered below the
   * main terminal in a vertical split. If no dev server terminal session
   * exists yet, one is spawned via `terminal.spawn` with `autoRun: true`.
   * When toggled OFF: hides the dev server terminal pane but keeps the
   * terminal session alive for later reconnection.
   *
   * @param paneId - The ID of the terminal LeafNode to toggle dev server for
   * @returns A promise that resolves to whether the dev server pane is now
   *   visible (true = toggled on)
   */
  readonly toggleDevServerPane: (paneId: string) => Promise<boolean>
  /**
   * Toggle a diff viewer alongside a terminal pane.
   *
   * When toggled ON: splits the terminal pane horizontally with a diff
   * pane showing the same workspace's changes.
   * When toggled OFF: closes the sibling diff pane, expanding the
   * terminal to fill the space.
   *
   * @param paneId - The ID of the terminal LeafNode to toggle diff for
   * @returns Whether the diff pane is now visible (true = toggled on)
   */
  readonly toggleDiffPane: (paneId: string) => boolean
  /**
   * Toggle fullscreen mode for the active terminal pane.
   *
   * When toggled ON: hides all other workspaces and all sibling panes
   * within the current workspace, showing only the active terminal pane
   * at full size. The workspace bar header remains visible.
   *
   * When toggled OFF: restores the normal multi-pane, multi-workspace view.
   *
   * This is a transient UI state (not persisted to LiveStore).
   */
  readonly toggleFullscreenPane: () => void
}

/**
 * The ID of the pane currently in fullscreen mode, or null if no pane
 * is fullscreened. Provided alongside PanelActions for UI components
 * that need to adjust rendering based on fullscreen state.
 */
const FullscreenPaneIdContext = createContext<string | null>(null)

const PanelActionsContext = createContext<PanelActions | null>(null)
const ActivePaneIdContext = createContext<string | null>(null)

/**
 * Provider component that makes panel actions, active pane state,
 * and fullscreen pane state available to all pane components in the tree.
 */
function PanelActionsProvider({
  activePaneId,
  children,
  fullscreenPaneId,
  value,
}: {
  readonly activePaneId: string | null
  readonly children: React.ReactNode
  readonly fullscreenPaneId: string | null
  readonly value: PanelActions
}) {
  return (
    <PanelActionsContext.Provider value={value}>
      <ActivePaneIdContext.Provider value={activePaneId}>
        <FullscreenPaneIdContext.Provider value={fullscreenPaneId}>
          {children}
        </FullscreenPaneIdContext.Provider>
      </ActivePaneIdContext.Provider>
    </PanelActionsContext.Provider>
  )
}

/**
 * Hook to access panel layout actions (split, close, setActivePaneId)
 * from a pane component. Returns null if no PanelActionsProvider is present.
 */
function usePanelActions(): PanelActions | null {
  return useContext(PanelActionsContext)
}

/**
 * Hook to read the currently active (focused) pane ID.
 * Returns null if no pane is active or no provider is present.
 */
function useActivePaneId(): string | null {
  return useContext(ActivePaneIdContext)
}

/**
 * Hook to read the pane ID that is currently in fullscreen mode.
 * Returns null if no pane is fullscreened or no provider is present.
 */
function useFullscreenPaneId(): string | null {
  return useContext(FullscreenPaneIdContext)
}

export {
  PanelActionsProvider,
  useActivePaneId,
  useFullscreenPaneId,
  usePanelActions,
}
export type { PanelActions }
