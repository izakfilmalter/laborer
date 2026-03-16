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
  PanelLeafNode,
  PaneType,
  SplitDirection,
  WindowLayout,
} from '@laborer/shared/types'
import { createContext, useContext } from 'react'

/**
 * Direction for pane resize operations.
 * Duplicated from window-tab-utils to avoid circular imports.
 */
type ResizeDirection = 'left' | 'right' | 'up' | 'down'

/** Mode for the panel type picker overlay. */
type PickerMode =
  | {
      readonly kind: 'split-right'
      readonly paneId: string
      readonly workspaceId: string
    }
  | {
      readonly kind: 'split-down'
      readonly paneId: string
      readonly workspaceId: string
    }
  | { readonly kind: 'new-tab'; readonly workspaceId: string }

interface PanelActions {
  /** Add a new panel tab for a workspace with the given pane type. */
  readonly addPanelTab:
    | ((
        workspaceId: string,
        panelType: PaneType,
        options?: { terminalId?: string }
      ) => void)
    | undefined
  /** Add a new window tab. */
  readonly addWindowTab: (() => void) | undefined
  /** Add a workspace to the current window tab. */
  readonly addWorkspaceToCurrentTab: ((workspaceId: string) => void) | undefined
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
  /** Close the terminal pane with the given terminal ID. */
  readonly closeTerminalPane: (terminalId: string) => void
  /** Close a window tab. */
  readonly closeWindowTab: (() => void) | undefined
  /** Close a workspace and remove it from the layout. */
  readonly closeWorkspace: (workspaceId: string) => void
  /** Force-close a workspace, bypassing dirty checks. */
  readonly forceCloseWorkspace: (workspaceId: string) => void
  /** Remove a panel tab from a workspace. */
  readonly removePanelTab:
    | ((workspaceId: string, tabId: string) => void)
    | undefined
  /** Rename a window tab. */
  readonly renameWindowTab: ((tabId: string, label: string) => void) | undefined
  /** Reorder panel tabs via drag-and-drop. */
  readonly reorderPanelTabsDnd:
    | ((workspaceId: string, fromIndex: number, toIndex: number) => void)
    | undefined
  /** Reorder window tabs via drag-and-drop. */
  readonly reorderWindowTabsDnd:
    | ((fromIndex: number, toIndex: number) => void)
    | undefined
  /** Reorder workspaces in the sidebar. */
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
  /** Show the panel type picker overlay. */
  readonly showPanelTypePicker: ((mode: PickerMode) => void) | undefined
  /**
   * Split a pane into two. The original pane stays; a new sibling pane
   * is added in the given direction.
   *
   * @param paneId - The ID of the pane to split
   * @param direction - "horizontal" (side-by-side) or "vertical" (stacked)
   * @param newPaneContent - Optional content for the new pane
   */
  readonly splitPane: (
    paneId: string,
    direction: SplitDirection,
    newPaneContent?: Partial<PanelLeafNode>
  ) => void
  /** Switch to a specific panel tab by ID. */
  readonly switchPanelTab:
    | ((workspaceId: string, tabId: string) => void)
    | undefined
  /** Switch to a panel tab by its index position. */
  readonly switchPanelTabByIndex:
    | ((workspaceId: string, index: number) => void)
    | undefined
  /** Switch to the next or previous panel tab. */
  readonly switchPanelTabRelative:
    | ((workspaceId: string, delta: number) => void)
    | undefined
  /** Switch to a specific window tab by ID. */
  readonly switchWindowTab: ((tabId: string) => void) | undefined
  /** Switch to a window tab by its index position. */
  readonly switchWindowTabByIndex: ((index: number) => void) | undefined
  /** Switch to the next or previous window tab. */
  readonly switchWindowTabRelative: ((delta: number) => void) | undefined
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
  /** Toggle fullscreen for the active pane. */
  readonly toggleFullscreenPane: () => void
  /** Toggle the review side panel. */
  readonly toggleReviewPane: (paneId: string) => boolean
  /** The current window layout. */
  readonly windowLayout: WindowLayout | undefined
}

/** Options passed to assignTerminalToPane. */
interface AssignTerminalToPaneOptions {
  /** Whether to auto-open a dev server split alongside. */
  readonly autoOpenDevServer?: boolean
}

/** State for the close-confirmation dialog on a terminal pane. */
interface PendingCloseState {
  readonly onCancel: () => void
  readonly onCloseAndDestroy?: (() => void) | undefined
  readonly onConfirm: () => void
  readonly paneId: string | null
}

/** State for the panel type picker overlay. */
interface PendingPickerState {
  readonly onCancel: () => void
  readonly onSelect: (type: PaneType) => void
  readonly paneId: string | null
}

const PanelActionsContext = createContext<PanelActions | null>(null)
const ActivePaneIdContext = createContext<string | null>(null)
const FullscreenPaneIdContext = createContext<string | null>(null)
const ActiveWorkspaceIdContext = createContext<string | null>(null)
const PendingCloseContext = createContext<PendingCloseState | null>(null)
const PendingPickerContext = createContext<PendingPickerState | null>(null)

/**
 * Context for the fullscreen portal DOM element.
 * When non-null, the fullscreened pane renders into this container via a portal.
 */
const FullscreenPortalContext = createContext<HTMLElement | null>(null)

/**
 * Provider component that makes panel actions and active pane state
 * available to all pane components in the tree.
 */
function PanelActionsProvider({
  activePaneId,
  activeWorkspaceId,
  children,
  fullscreenPaneId,
  pendingClose,
  pendingPicker,
  value,
}: {
  readonly activePaneId: string | null
  readonly activeWorkspaceId?: string | null
  readonly children: React.ReactNode
  readonly fullscreenPaneId?: string | null
  readonly pendingClose?: PendingCloseState | null
  readonly pendingPicker?: PendingPickerState | null
  readonly value: PanelActions
}) {
  return (
    <PanelActionsContext.Provider value={value}>
      <ActivePaneIdContext.Provider value={activePaneId}>
        <FullscreenPaneIdContext.Provider value={fullscreenPaneId ?? null}>
          <ActiveWorkspaceIdContext.Provider value={activeWorkspaceId ?? null}>
            <PendingCloseContext.Provider value={pendingClose ?? null}>
              <PendingPickerContext.Provider value={pendingPicker ?? null}>
                {children}
              </PendingPickerContext.Provider>
            </PendingCloseContext.Provider>
          </ActiveWorkspaceIdContext.Provider>
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

/** Hook to read the currently fullscreened pane ID, if any. */
function useFullscreenPaneId(): string | null {
  return useContext(FullscreenPaneIdContext)
}

/** Hook to read the fullscreen portal DOM element. */
function useFullscreenPortal(): HTMLElement | null {
  return useContext(FullscreenPortalContext)
}

/** Hook to read the pending close-confirmation dialog state. */
function usePendingClosePane(): PendingCloseState | null {
  return useContext(PendingCloseContext)
}

/** Hook to read the pending panel type picker overlay state. */
function usePendingPicker(): PendingPickerState | null {
  return useContext(PendingPickerContext)
}

export {
  FullscreenPortalContext,
  PanelActionsProvider,
  useActivePaneId,
  useFullscreenPaneId,
  useFullscreenPortal,
  usePanelActions,
  usePendingClosePane,
  usePendingPicker,
}
export type {
  AssignTerminalToPaneOptions,
  PanelActions,
  PendingCloseState,
  PendingPickerState,
  PickerMode,
}
