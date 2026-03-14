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

import type {
  LeafNode,
  PaneType,
  SplitDirection,
  WindowLayout,
} from '@laborer/shared/types'
import { createContext, useContext } from 'react'

/**
 * Direction for pane resize operations.
 * Duplicated from layout-utils to avoid circular imports.
 */
type ResizeDirection = 'left' | 'right' | 'up' | 'down'

interface AssignTerminalToPaneOptions {
  /** Whether assigning this terminal should auto-open the workspace dev server. */
  readonly autoOpenDevServer?: boolean | undefined
}

interface PanelActions {
  // -- Panel tab actions ---------------------------------------------------

  /**
   * Add a new panel tab of the given type to the focused workspace.
   * Triggered by Ctrl+T (with type picker).
   *
   * @param workspaceId - The workspace to add the tab to
   * @param panelType - The panel type for the new tab
   */
  readonly addPanelTab:
    | ((workspaceId: string, panelType: PaneType) => void)
    | undefined

  // -- Window tab actions ---------------------------------------------------

  /**
   * Add a new empty window tab and switch to it.
   * Triggered by Cmd+N.
   */
  readonly addWindowTab: (() => void) | undefined
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
    paneId?: string,
    options?: AssignTerminalToPaneOptions
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
   * Close the active window tab.
   * Triggered by Cmd+Shift+W.
   */
  readonly closeWindowTab: (() => void) | undefined
  /**
   * Close all panes belonging to a workspace, killing their terminals.
   *
   * Finds every leaf node with the given workspaceId and closes them,
   * removing the associated terminals from the terminal service. If
   * the workspace has running child processes, callers should show a
   * confirmation dialog before invoking this action.
   *
   * @param workspaceId - The workspace whose panes should be closed
   */
  readonly closeWorkspace: (workspaceId: string) => void
  /**
   * Close all panes belonging to a workspace without confirmation.
   *
   * Identical to closeWorkspace but bypasses the running-process
   * confirmation gate. Used by workspace destruction which has its own
   * confirmation dialog that already warns the user about active
   * terminals.
   *
   * @param workspaceId - The workspace whose panes should be closed
   */
  readonly forceCloseWorkspace: (workspaceId: string) => void

  /**
   * Remove a panel tab by ID from a workspace.
   *
   * @param workspaceId - The workspace containing the tab
   * @param tabId - The ID of the panel tab to remove
   */
  readonly removePanelTab:
    | ((workspaceId: string, tabId: string) => void)
    | undefined

  /**
   * Reorder panel tabs within a workspace (for drag-and-drop).
   *
   * @param workspaceId - The workspace containing the tabs
   * @param fromIndex - Source tab index (0-based)
   * @param toIndex - Target tab index (0-based)
   */
  readonly reorderPanelTabsDnd:
    | ((workspaceId: string, fromIndex: number, toIndex: number) => void)
    | undefined

  /**
   * Reorder window tabs (for drag-and-drop).
   */
  readonly reorderWindowTabsDnd:
    | ((fromIndex: number, toIndex: number) => void)
    | undefined
  /**
   * Reorder workspace frames in the panel view.
   *
   * Persists a new explicit ordering of workspace IDs, overriding the
   * default DFS-derived order from the layout tree. Called when the user
   * drag-and-drops workspace frames to rearrange them.
   *
   * @param workspaceOrder - The new ordered array of workspace IDs
   */
  readonly reorderWorkspaces: (workspaceOrder: (string | undefined)[]) => void
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
   * Switch the active panel tab by ID within a workspace.
   *
   * @param workspaceId - The workspace containing the tab
   * @param tabId - The ID of the panel tab to activate
   */
  readonly switchPanelTab:
    | ((workspaceId: string, tabId: string) => void)
    | undefined

  /**
   * Switch the active panel tab by 1-based index within the focused workspace.
   * Triggered by Ctrl+1 through Ctrl+8 (index 9 = last tab).
   *
   * @param workspaceId - The workspace containing the tabs
   * @param index - 1-based tab index (1-8, or 9 for last)
   */
  readonly switchPanelTabByIndex:
    | ((workspaceId: string, index: number) => void)
    | undefined

  /**
   * Cycle to the next or previous panel tab within the focused workspace.
   * Triggered by Ctrl+Shift+] (delta=1) and Ctrl+Shift+[ (delta=-1).
   *
   * @param workspaceId - The workspace containing the tabs
   * @param delta - +1 for next, -1 for previous
   */
  readonly switchPanelTabRelative:
    | ((workspaceId: string, delta: number) => void)
    | undefined

  /**
   * Switch to a specific window tab by ID.
   */
  readonly switchWindowTab: ((tabId: string) => void) | undefined

  /**
   * Switch to a window tab by its 1-based index.
   * Triggered by Cmd+1 through Cmd+8 (index 9 = last tab).
   */
  readonly switchWindowTabByIndex: ((index: number) => void) | undefined

  /**
   * Cycle to the next or previous window tab.
   * Triggered by Cmd+Shift+] (delta=1) and Cmd+Shift+[ (delta=-1).
   */
  readonly switchWindowTabRelative: ((delta: number) => void) | undefined
  /**
   * Toggle the dev server terminal alongside a terminal pane.
   *
   * When toggled ON: the dev server terminal pane is rendered to the right of
   * the main terminal in a horizontal split. If no dev server terminal session
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
  /**
   * Toggle a review pane for a workspace.
   *
   * When toggled ON: splits right from the given pane with a new review
   * pane showing the same workspace's PR review findings and comments.
   * When toggled OFF: closes the existing review pane for that workspace.
   *
   * Unlike diff and dev server panes (which are sidebars on a terminal
   * pane), the review pane is a standalone pane in the layout tree.
   *
   * @param paneId - The ID of the pane to split from (used to inherit workspaceId)
   * @returns Whether the review pane is now visible (true = toggled on)
   */
  readonly toggleReviewPane: (paneId: string) => boolean

  /**
   * The current window layout (for rendering the tab bar).
   */
  readonly windowLayout: WindowLayout | undefined
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
 * State for the pane-scoped close confirmation dialog.
 * When a pane has a running process and the user attempts to close it,
 * the pane ID is stored here so the LeafPaneRenderer can render an
 * inline confirmation dialog within that specific pane's bounds.
 */
interface PendingCloseState {
  /** Cancel the close — dismisses the dialog. */
  readonly onCancel: () => void
  /**
   * Optional handler for "Close & Destroy" — closes the pane AND
   * destroys the workspace worktree. Present only when the pane is
   * the last for a workspace whose PR is merged.
   */
  readonly onCloseAndDestroy?: (() => void) | undefined
  /** Confirm the close — kills the process and removes the pane. */
  readonly onConfirm: () => void
  /** The pane ID awaiting close confirmation, or null if none. */
  readonly paneId: string | null
}

const noop = () => undefined

const defaultPendingClose: PendingCloseState = {
  paneId: null,
  onConfirm: noop,
  onCancel: noop,
}

const PendingClosePaneContext =
  createContext<PendingCloseState>(defaultPendingClose)

/**
 * The DOM element where the fullscreened pane portals its content.
 * The portal target sits at the PanelContent level, positioned absolutely
 * over the entire panel area. This lets the fullscreened pane escape its
 * ResizablePanel container without unmounting siblings.
 *
 * Uses `HTMLElement | null` (not a ref) so that setting the element via
 * a callback ref + useState triggers a re-render — ensuring the portal
 * target is available to `createPortal` on the first render after mount.
 */
const FullscreenPortalContext = createContext<HTMLElement | null>(null)

/**
 * Provider component that makes panel actions, active pane state,
 * fullscreen pane state, and pending close confirmation state available
 * to all pane components in the tree.
 */
function PanelActionsProvider({
  activePaneId,
  children,
  fullscreenPaneId,
  pendingClose,
  value,
}: {
  readonly activePaneId: string | null
  readonly children: React.ReactNode
  readonly fullscreenPaneId: string | null
  readonly pendingClose?: PendingCloseState | undefined
  readonly value: PanelActions
}) {
  return (
    <PanelActionsContext.Provider value={value}>
      <ActivePaneIdContext.Provider value={activePaneId}>
        <FullscreenPaneIdContext.Provider value={fullscreenPaneId}>
          <PendingClosePaneContext.Provider
            value={pendingClose ?? defaultPendingClose}
          >
            {children}
          </PendingClosePaneContext.Provider>
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

/**
 * Hook to read the pending close confirmation state.
 * Used by LeafPaneRenderer to render an inline confirmation dialog
 * within the pane that is awaiting close confirmation.
 */
function usePendingClosePane(): PendingCloseState {
  return useContext(PendingClosePaneContext)
}

/**
 * Hook to access the fullscreen portal target element.
 * Used by LeafPaneRenderer to portal the fullscreened pane's content
 * into a container that sits above the panel hierarchy.
 */
function useFullscreenPortal(): HTMLElement | null {
  return useContext(FullscreenPortalContext)
}

export {
  FullscreenPortalContext,
  PanelActionsProvider,
  useActivePaneId,
  useFullscreenPaneId,
  useFullscreenPortal,
  usePanelActions,
  usePendingClosePane,
}
export type { AssignTerminalToPaneOptions, PanelActions, PendingCloseState }
