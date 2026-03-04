/**
 * PanelContext — React context for panel layout actions.
 *
 * Provides split/close actions to pane components deep in the tree.
 * The layout owner (e.g., the route component that manages the PanelNode
 * state) provides the action implementations via PanelActionsProvider.
 * Pane components consume them via usePanelActions().
 *
 * @see Issue #69: PanelManager — recursive splits
 */

import type { LeafNode, SplitDirection } from "@laborer/shared/types";
import { createContext, useContext } from "react";

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
	) => void;
	/**
	 * Close a pane and remove it from the layout.
	 * If it's the last pane, the layout becomes empty.
	 *
	 * @param paneId - The ID of the LeafNode to close
	 */
	readonly closePane: (paneId: string) => void;
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
	) => void;
}

const PanelActionsContext = createContext<PanelActions | null>(null);

/**
 * Provider component that makes panel actions available to all pane
 * components in the tree.
 */
function PanelActionsProvider({
	children,
	value,
}: {
	readonly children: React.ReactNode;
	readonly value: PanelActions;
}) {
	return (
		<PanelActionsContext.Provider value={value}>
			{children}
		</PanelActionsContext.Provider>
	);
}

/**
 * Hook to access panel layout actions (split, close) from a pane component.
 * Returns null if no PanelActionsProvider is present.
 */
function usePanelActions(): PanelActions | null {
	return useContext(PanelActionsContext);
}

export { PanelActionsProvider, usePanelActions };
export type { PanelActions };
