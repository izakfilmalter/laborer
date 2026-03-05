/**
 * Panel layout tree manipulation utilities.
 *
 * These pure functions operate on the `PanelNode` tree structure to support
 * splitting panes, closing panes, and finding nodes by ID. They are used by
 * the PanelManager and usePanelLayout hook to mutate the layout in response
 * to user actions (keyboard shortcuts, context menus, etc.).
 *
 * All functions return a new tree — the original tree is never mutated.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see Issue #69: PanelManager — recursive splits
 */

import type {
	LeafNode,
	PanelNode,
	SplitDirection,
	SplitNode,
} from "@laborer/shared/types";

let _counter = 0;

/**
 * Generate a unique ID for new panel nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions
 * across page reloads.
 */
function generateId(prefix: string): string {
	_counter += 1;
	const random = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${_counter}-${random}`;
}

/**
 * Find a node by ID in the panel tree.
 * Returns the node if found, or undefined.
 */
function findNodeById(root: PanelNode, nodeId: string): PanelNode | undefined {
	if (root.id === nodeId) {
		return root;
	}
	if (root._tag === "SplitNode") {
		for (const child of root.children) {
			const found = findNodeById(child, nodeId);
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

/**
 * Split a pane identified by `paneId` into two panes.
 *
 * The original pane becomes one child of a new SplitNode. A new empty
 * LeafNode becomes the other child. The `direction` controls whether
 * the split is horizontal (side-by-side) or vertical (stacked).
 *
 * If the target pane is already a direct child of a SplitNode with the
 * same direction, the new pane is inserted adjacent to the target instead
 * of creating a nested split. This keeps the tree flat when possible.
 *
 * @param root - The root PanelNode tree
 * @param paneId - The ID of the LeafNode to split
 * @param direction - "horizontal" or "vertical"
 * @param newPaneContent - Optional content for the new pane (defaults to empty terminal pane)
 * @returns A new PanelNode tree with the split applied, or the original tree if paneId not found
 */
function splitPane(
	root: PanelNode,
	paneId: string,
	direction: SplitDirection,
	newPaneContent?: Partial<LeafNode>
): PanelNode {
	return splitPaneRecursive(root, paneId, direction, newPaneContent);
}

function splitPaneRecursive(
	node: PanelNode,
	paneId: string,
	direction: SplitDirection,
	newPaneContent?: Partial<LeafNode>
): PanelNode {
	// Found the target leaf — wrap it in a split with a new sibling
	if (node._tag === "LeafNode" && node.id === paneId) {
		const newPane: LeafNode = {
			_tag: "LeafNode",
			id: generateId("pane"),
			paneType: newPaneContent?.paneType ?? "terminal",
			terminalId: newPaneContent?.terminalId,
			workspaceId: newPaneContent?.workspaceId ?? node.workspaceId,
		};
		const splitNode: SplitNode = {
			_tag: "SplitNode",
			id: generateId("split"),
			direction,
			children: [node, newPane],
			sizes: [50, 50],
		};
		return splitNode;
	}

	// Recurse into SplitNode children
	if (node._tag === "SplitNode") {
		// Check if any direct child is the target and has the same direction.
		// If so, insert adjacent instead of nesting.
		if (node.direction === direction) {
			const targetIndex = node.children.findIndex(
				(child) => child._tag === "LeafNode" && child.id === paneId
			);
			if (targetIndex !== -1) {
				const newPane: LeafNode = {
					_tag: "LeafNode",
					id: generateId("pane"),
					paneType: newPaneContent?.paneType ?? "terminal",
					terminalId: newPaneContent?.terminalId,
					workspaceId:
						newPaneContent?.workspaceId ??
						(node.children[targetIndex] as LeafNode).workspaceId,
				};
				const newChildren = [
					...node.children.slice(0, targetIndex + 1),
					newPane,
					...node.children.slice(targetIndex + 1),
				];
				const equalSize = 100 / newChildren.length;
				const newSizes = newChildren.map(() => equalSize);
				return {
					...node,
					children: newChildren,
					sizes: newSizes,
				};
			}
		}

		// Recurse into children
		const newChildren = node.children.map((child) =>
			splitPaneRecursive(child, paneId, direction, newPaneContent)
		);

		// Check if anything changed
		const changed = newChildren.some((child, i) => child !== node.children[i]);
		if (!changed) {
			return node;
		}

		return {
			...node,
			children: newChildren,
		};
	}

	return node;
}

/**
 * Close a pane identified by `paneId`.
 *
 * Removes the pane from its parent split. If the parent split is left with
 * a single child, the parent collapses and the remaining child takes its
 * place in the tree.
 *
 * If the target is the root leaf, returns undefined (no panes left).
 *
 * @param root - The root PanelNode tree
 * @param paneId - The ID of the LeafNode to close
 * @returns A new PanelNode tree with the pane removed, or undefined if empty
 */
function closePane(root: PanelNode, paneId: string): PanelNode | undefined {
	// Closing the root leaf → empty
	if (root._tag === "LeafNode" && root.id === paneId) {
		return undefined;
	}

	if (root._tag === "SplitNode") {
		const result = closePaneInSplit(root, paneId);
		return result;
	}

	return root;
}

function closePaneInSplit(
	node: SplitNode,
	paneId: string
): PanelNode | undefined {
	// Check if a direct child is the target
	const targetIndex = node.children.findIndex(
		(child) => child._tag === "LeafNode" && child.id === paneId
	);
	if (targetIndex !== -1) {
		const remaining = node.children.filter((_, i) => i !== targetIndex);
		if (remaining.length === 0) {
			return undefined;
		}
		if (remaining.length === 1) {
			// Collapse the split — single child takes over
			return remaining[0];
		}
		// Redistribute sizes evenly
		const equalSize = 100 / remaining.length;
		const newSizes = remaining.map(() => equalSize);
		return {
			...node,
			children: remaining,
			sizes: newSizes,
		};
	}

	// Recurse into split children
	const newChildren: PanelNode[] = [];
	let changed = false;

	for (const child of node.children) {
		if (child._tag === "SplitNode") {
			const result = closePaneInSplit(child, paneId);
			if (result !== child) {
				changed = true;
			}
			if (result) {
				newChildren.push(result);
			}
			// If result is undefined, the entire subtree was removed
		} else {
			newChildren.push(child);
		}
	}

	if (!changed) {
		return node;
	}

	if (newChildren.length === 0) {
		return undefined;
	}
	if (newChildren.length === 1) {
		return newChildren[0];
	}
	const equalSize = 100 / newChildren.length;
	const newSizes = newChildren.map(() => equalSize);
	return {
		...node,
		children: newChildren,
		sizes: newSizes,
	};
}

/**
 * Count the total number of leaf panes in a layout tree.
 */
function countLeaves(node: PanelNode): number {
	if (node._tag === "LeafNode") {
		return 1;
	}
	let count = 0;
	for (const child of node.children) {
		count += countLeaves(child);
	}
	return count;
}

/**
 * Get the maximum nesting depth of the layout tree.
 * A single LeafNode has depth 1. A SplitNode adds 1 to the max child depth.
 */
function getTreeDepth(node: PanelNode): number {
	if (node._tag === "LeafNode") {
		return 1;
	}
	let maxChildDepth = 0;
	for (const child of node.children) {
		const d = getTreeDepth(child);
		if (d > maxChildDepth) {
			maxChildDepth = d;
		}
	}
	return 1 + maxChildDepth;
}

/**
 * Get all leaf node IDs in the tree, in order.
 */
function getLeafIds(node: PanelNode): string[] {
	if (node._tag === "LeafNode") {
		return [node.id];
	}
	const ids: string[] = [];
	for (const child of node.children) {
		ids.push(...getLeafIds(child));
	}
	return ids;
}

/**
 * Replace a node in the tree by ID with a new node.
 */
function replaceNode(
	root: PanelNode,
	nodeId: string,
	replacement: PanelNode
): PanelNode {
	if (root.id === nodeId) {
		return replacement;
	}
	if (root._tag === "SplitNode") {
		const newChildren = root.children.map((child) =>
			replaceNode(child, nodeId, replacement)
		);
		const changed = newChildren.some((child, i) => child !== root.children[i]);
		if (!changed) {
			return root;
		}
		return { ...root, children: newChildren };
	}
	return root;
}

/**
 * Find the parent SplitNode of a given node ID.
 * Returns the parent SplitNode and the index of the child within it,
 * or undefined if the node is the root or not found.
 */
function findParent(
	root: PanelNode,
	nodeId: string
): { parent: SplitNode; index: number } | undefined {
	if (root._tag === "SplitNode") {
		for (let i = 0; i < root.children.length; i++) {
			const child = root.children[i];
			if (child && child.id === nodeId) {
				return { parent: root, index: i };
			}
			if (child && child._tag === "SplitNode") {
				const result = findParent(child, nodeId);
				if (result) {
					return result;
				}
			}
		}
	}
	return undefined;
}

/**
 * Direction type for directional pane navigation.
 *
 * Maps to split orientations:
 * - "left" / "right" → navigate within "horizontal" splits (side-by-side)
 * - "up" / "down" → navigate within "vertical" splits (stacked)
 */
type NavigationDirection = "left" | "right" | "up" | "down";

/**
 * Build the path from the root to a target node.
 * Returns an array of PanelNode from root to target (inclusive), or
 * undefined if the target is not found.
 */
function buildPath(root: PanelNode, targetId: string): PanelNode[] | undefined {
	if (root.id === targetId) {
		return [root];
	}
	if (root._tag === "SplitNode") {
		for (const child of root.children) {
			const childPath = buildPath(child, targetId);
			if (childPath) {
				return [root, ...childPath];
			}
		}
	}
	return undefined;
}

/**
 * Get the first leaf node in a subtree, preferring a specific edge.
 *
 * - "first" → leftmost / topmost leaf (DFS, always pick first child)
 * - "last" → rightmost / bottommost leaf (DFS, always pick last child)
 *
 * When entering a subtree from a directional navigation, we want:
 * - Moving right → enter the left edge of the new subtree (first)
 * - Moving left → enter the right edge of the new subtree (last)
 * - Moving down → enter the top edge of the new subtree (first)
 * - Moving up → enter the bottom edge of the new subtree (last)
 */
function getEdgeLeaf(node: PanelNode, edge: "first" | "last"): LeafNode {
	if (node._tag === "LeafNode") {
		return node;
	}
	const child = edge === "first" ? node.children[0] : node.children.at(-1);
	// Safety: SplitNode always has at least one child in valid trees
	if (!child) {
		// Unreachable in valid trees — SplitNodes always have children
		return node as unknown as LeafNode;
	}
	return getEdgeLeaf(child, edge);
}

/**
 * Try to navigate from a specific path index in the given direction.
 * Returns the target leaf ID if a neighbor is found at this ancestor, or
 * undefined to signal the caller to continue walking up.
 */
function tryNavigateAtAncestor(
	path: PanelNode[],
	index: number,
	targetOrientation: "horizontal" | "vertical",
	delta: number
): string | undefined {
	const ancestor = path[index];
	if (!ancestor || ancestor._tag !== "SplitNode") {
		return undefined;
	}
	if (ancestor.direction !== targetOrientation) {
		return undefined;
	}

	const childInPath = path[index + 1];
	if (!childInPath) {
		return undefined;
	}
	const childIndex = ancestor.children.findIndex(
		(c) => c.id === childInPath.id
	);
	if (childIndex === -1) {
		return undefined;
	}

	const neighborIndex = childIndex + delta;
	const neighbor = ancestor.children[neighborIndex];
	if (!neighbor) {
		return undefined;
	}

	const edge = delta > 0 ? "first" : "last";
	return getEdgeLeaf(neighbor, edge).id;
}

/**
 * Find the pane to navigate to from the active pane in a given direction.
 *
 * The algorithm:
 * 1. Build the path from root to the active pane.
 * 2. Walk up the path to find the nearest ancestor SplitNode whose
 *    orientation matches the navigation direction.
 *    - horizontal splits handle left/right
 *    - vertical splits handle up/down
 * 3. In that split, find the adjacent child in the requested direction.
 * 4. Drill into the adjacent subtree to find the nearest leaf on the
 *    entering edge (e.g., moving right enters from the left edge).
 *
 * Returns the target leaf ID, or undefined if navigation is not possible
 * (at the edge of the layout in that direction).
 */
function findPaneInDirection(
	root: PanelNode,
	activePaneId: string,
	direction: NavigationDirection
): string | undefined {
	const path = buildPath(root, activePaneId);
	if (!path || path.length < 2) {
		return undefined;
	}

	const targetOrientation: "horizontal" | "vertical" =
		direction === "left" || direction === "right" ? "horizontal" : "vertical";
	const delta = direction === "left" || direction === "up" ? -1 : 1;

	// Walk up from the active pane's parent toward the root
	for (let i = path.length - 2; i >= 0; i--) {
		const result = tryNavigateAtAncestor(path, i, targetOrientation, delta);
		if (result) {
			return result;
		}
	}

	return undefined;
}

/**
 * Resize step percentage — how much the active pane grows or shrinks
 * per keyboard shortcut press (in percentage points).
 */
const RESIZE_STEP = 5;

/**
 * Compute the resize direction based on the keyboard arrow and the
 * split's orientation.
 *
 * Returns a delta to apply to the active pane's size:
 * - Positive delta → grow the active pane
 * - Negative delta → shrink the active pane
 * - undefined → the arrow direction doesn't match the split orientation
 *
 * Mapping:
 * - Horizontal split + Shift+ArrowRight → grow (+RESIZE_STEP)
 * - Horizontal split + Shift+ArrowLeft → shrink (-RESIZE_STEP)
 * - Vertical split + Shift+ArrowDown → grow (+RESIZE_STEP)
 * - Vertical split + Shift+ArrowUp → shrink (-RESIZE_STEP)
 *
 * Arrow keys that don't match the split orientation return undefined
 * so the caller can walk up to a higher ancestor.
 */
function getResizeDelta(
	direction: NavigationDirection,
	splitOrientation: "horizontal" | "vertical"
): number | undefined {
	if (splitOrientation === "horizontal") {
		if (direction === "right") {
			return RESIZE_STEP;
		}
		if (direction === "left") {
			return -RESIZE_STEP;
		}
		return undefined;
	}
	// vertical
	if (direction === "down") {
		return RESIZE_STEP;
	}
	if (direction === "up") {
		return -RESIZE_STEP;
	}
	return undefined;
}

/**
 * Find the parent SplitNode of the active pane that can be resized in the
 * given direction, and compute the new sizes array.
 *
 * Walks up from the active pane's parent toward the root looking for a
 * SplitNode whose orientation matches the resize direction. Once found,
 * adjusts the sizes array by moving `RESIZE_STEP` percentage points from
 * the adjacent sibling to the active pane (or vice versa).
 *
 * Returns the parent SplitNode ID and new sizes, or undefined if resize
 * is not possible (e.g., no matching split orientation, at minimum size).
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */
function computeResize(
	root: PanelNode,
	activePaneId: string,
	direction: NavigationDirection
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
	const path = buildPath(root, activePaneId);
	if (!path || path.length < 2) {
		return undefined;
	}

	return computeResizeFromPath(path, direction);
}

/** Minimum pane size percentage — prevents panes from being resized to nothing. */
const MIN_PANE_SIZE = 5;

/**
 * Walk up the path from the active pane to find a resizable ancestor.
 * Extracted from computeResize to keep complexity under Biome's limit.
 */
function computeResizeFromPath(
	path: PanelNode[],
	direction: NavigationDirection
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
	// Walk up from the active pane's parent toward the root
	for (let i = path.length - 2; i >= 0; i--) {
		const ancestor = path[i];
		if (!ancestor || ancestor._tag !== "SplitNode") {
			continue;
		}

		const delta = getResizeDelta(direction, ancestor.direction);
		if (delta === undefined) {
			continue;
		}

		const childInPath = path[i + 1];
		if (!childInPath) {
			continue;
		}

		const childIndex = ancestor.children.findIndex(
			(c) => c.id === childInPath.id
		);
		if (childIndex === -1) {
			continue;
		}

		return applyResizeDelta(ancestor, childIndex, delta);
	}

	return undefined;
}

/**
 * Apply a resize delta to a SplitNode at a given child index.
 * Returns the new layout or undefined if resize is not possible.
 */
function applyResizeDelta(
	ancestor: SplitNode,
	childIndex: number,
	delta: number
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
	// Find the sibling to steal/give space from.
	// Growing → take from the next sibling. Shrinking → give to the previous sibling.
	const siblingIndex = delta > 0 ? childIndex + 1 : childIndex - 1;
	const siblingExists =
		siblingIndex >= 0 && siblingIndex < ancestor.children.length;
	if (!siblingExists) {
		return undefined;
	}

	const currentSize = ancestor.sizes[childIndex] ?? 50;
	const siblingSize = ancestor.sizes[siblingIndex] ?? 50;

	const newSize = currentSize + delta;
	const newSiblingSize = siblingSize - delta;

	// Enforce minimum size
	if (newSize < MIN_PANE_SIZE || newSiblingSize < MIN_PANE_SIZE) {
		return undefined;
	}

	// Build the new sizes map using child IDs as keys (for the imperative API)
	const newSizes: Record<string, number> = {};
	for (let j = 0; j < ancestor.children.length; j++) {
		const child = ancestor.children[j];
		if (!child) {
			continue;
		}
		if (j === childIndex) {
			newSizes[child.id] = newSize;
		} else if (j === siblingIndex) {
			newSizes[child.id] = newSiblingSize;
		} else {
			newSizes[child.id] = ancestor.sizes[j] ?? 100 / ancestor.children.length;
		}
	}

	return { splitNodeId: ancestor.id, newSizes };
}

/**
 * Find the sibling pane ID that should receive focus when a pane is closed.
 *
 * Resolution strategy:
 * 1. Find the parent SplitNode containing the pane being closed.
 * 2. If the pane is the first child → focus the next sibling.
 * 3. If the pane is the last or middle child → focus the previous sibling.
 * 4. The sibling may be a SplitNode, in which case we drill into it to
 *    find the nearest leaf (first leaf for next-sibling, last leaf for
 *    previous-sibling).
 * 5. If no parent exists (pane is the root) → return null (no panes remain).
 *
 * This function must be called BEFORE `closePane` mutates the tree, since
 * the pane being closed needs to be present to locate its parent and siblings.
 *
 * @param root - The root PanelNode tree (before close mutation)
 * @param paneId - The ID of the pane about to be closed
 * @returns The leaf ID to focus, or null if no sibling exists
 *
 * @see Issue #149: Focus auto-transfer on pane close
 */
function findSiblingPaneId(root: PanelNode, paneId: string): string | null {
	// Root leaf → no siblings
	if (root._tag === "LeafNode") {
		return null;
	}

	const parentInfo = findParent(root, paneId);
	if (!parentInfo) {
		return null;
	}

	const { parent, index } = parentInfo;
	const siblingCount = parent.children.length;

	// Only child → no sibling (parent will collapse)
	if (siblingCount <= 1) {
		return null;
	}

	// First child → focus next sibling; otherwise focus previous sibling
	const siblingIndex = index === 0 ? 1 : index - 1;
	const sibling = parent.children[siblingIndex];
	if (!sibling) {
		return null;
	}

	// If the sibling is a leaf, return its ID directly.
	// If it's a split, drill into it to find the nearest edge leaf.
	// When focusing the next sibling (index === 0), enter from the left/top edge (first).
	// When focusing the previous sibling (index > 0), enter from the right/bottom edge (last).
	const edge = index === 0 ? "first" : "last";
	return getEdgeLeaf(sibling, edge).id;
}

/**
 * Get the first leaf ID in a layout tree (DFS order).
 * Returns undefined if the tree has no leaves (should not happen for valid trees).
 */
function getFirstLeafId(root: PanelNode): string | undefined {
	if (root._tag === "LeafNode") {
		return root.id;
	}
	for (const child of root.children) {
		const leafId = getFirstLeafId(child);
		if (leafId) {
			return leafId;
		}
	}
	return undefined;
}

/**
 * Validate that an activePaneId references an existing leaf node in the
 * layout tree. If it does not (stale reference, null when panes exist),
 * falls back to the first leaf in the tree.
 *
 * Enforces the invariant: "there is always exactly one focused pane when
 * at least one pane exists."
 *
 * @param root - The current layout tree
 * @param activePaneId - The current activePaneId (may be null or stale)
 * @returns A valid leaf ID, or null only when the tree has no leaves
 *
 * @see Issue #150: Guaranteed active pane invariant
 */
function ensureValidActivePaneId(
	root: PanelNode,
	activePaneId: string | null
): string | null {
	// If activePaneId is set, check it references an existing leaf
	if (activePaneId) {
		const node = findNodeById(root, activePaneId);
		if (node && node._tag === "LeafNode") {
			return activePaneId;
		}
	}

	// activePaneId is null or stale — fall back to first leaf
	return getFirstLeafId(root) ?? null;
}

export {
	closePane,
	computeResize,
	countLeaves,
	ensureValidActivePaneId,
	findNodeById,
	findPaneInDirection,
	findParent,
	findSiblingPaneId,
	generateId,
	getFirstLeafId,
	getLeafIds,
	getTreeDepth,
	replaceNode,
	splitPane,
};
export type { NavigationDirection };
