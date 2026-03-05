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

export {
	closePane,
	countLeaves,
	findNodeById,
	findParent,
	generateId,
	getLeafIds,
	getTreeDepth,
	replaceNode,
	splitPane,
};
