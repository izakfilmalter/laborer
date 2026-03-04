/**
 * PanelManager — tmux-style panel system for rendering terminal and diff panes.
 *
 * Renders a panel layout based on a `PanelNode` tree structure. Supports:
 * - Single pane rendering (LeafNode)
 * - Horizontal split (SplitNode with direction "horizontal") — side-by-side panes
 * - Vertical split (SplitNode with direction "vertical") — stacked panes
 * - Recursive nesting of splits to arbitrary depth
 *
 * The PanelManager fills its parent container and renders pane content
 * based on the pane type:
 * - "terminal" → renders a TerminalPane with xterm.js
 * - "diff" → placeholder for future DiffPane component
 *
 * Split panes are rendered using react-resizable-panels (via shadcn/ui's
 * resizable wrapper) with drag-to-resize handles between each child.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see apps/web/src/panes/terminal-pane.tsx — Terminal pane component
 * @see Issue #66: PanelManager — single pane rendering
 * @see Issue #67: PanelManager — horizontal split
 * @see Issue #68: PanelManager — vertical split
 */

import type { LeafNode, PanelNode, SplitNode } from "@laborer/shared/types";
import { Layers, Terminal as TerminalIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TerminalPane } from "@/panes/terminal-pane";

interface PaneContentProps {
	/** The leaf node describing this pane's content. */
	readonly node: LeafNode;
}

/**
 * Renders the content of a single pane based on its type and assigned IDs.
 */
function PaneContent({ node }: PaneContentProps) {
	if (node.paneType === "terminal" && node.terminalId) {
		return <TerminalPane terminalId={node.terminalId} />;
	}

	if (node.paneType === "diff") {
		return (
			<div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
				<p className="text-sm">Diff viewer — coming soon (Issue #87)</p>
			</div>
		);
	}

	// Empty pane — no terminal or diff assigned
	return (
		<div className="flex h-full w-full items-center justify-center bg-background">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						{node.paneType === "terminal" ? <TerminalIcon /> : <Layers />}
					</EmptyMedia>
					<EmptyTitle>
						{node.paneType === "terminal" ? "No terminal" : "Empty pane"}
					</EmptyTitle>
					<EmptyDescription>
						{node.paneType === "terminal"
							? "Spawn a terminal in a workspace to see output here."
							: "Assign content to this pane."}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}

interface PanelRendererProps {
	/** The panel node tree to render. */
	readonly node: PanelNode;
}

/**
 * Renders a SplitNode as a resizable panel group with children separated
 * by drag handles.
 *
 * - direction "horizontal" → side-by-side panes (row layout)
 * - direction "vertical" → stacked panes (column layout)
 *
 * Each child is rendered recursively via PanelRenderer, supporting
 * arbitrary nesting depth. Panel sizes are taken from the SplitNode's
 * sizes array (percentages that must sum to 100).
 */
function SplitPanelRenderer({ node }: { readonly node: SplitNode }) {
	return (
		<ResizablePanelGroup data-split-id={node.id} orientation={node.direction}>
			{node.children.map((child, index) => {
				const size = node.sizes[index] ?? 100 / node.children.length;
				return (
					<SplitChild
						child={child}
						defaultSize={size}
						index={index}
						key={child.id}
					/>
				);
			})}
		</ResizablePanelGroup>
	);
}

/**
 * Renders a single child within a SplitNode, preceded by a ResizableHandle
 * if it is not the first child. Extracted to a separate component to keep
 * the SplitPanelRenderer map clean and to provide stable keys.
 */
function SplitChild({
	child,
	defaultSize,
	index,
}: {
	readonly child: PanelNode;
	readonly defaultSize: number;
	readonly index: number;
}) {
	return (
		<>
			{index > 0 && <ResizableHandle />}
			<ResizablePanel defaultSize={`${defaultSize}%`} minSize="5%">
				<PanelRenderer node={child} />
			</ResizablePanel>
		</>
	);
}

/**
 * Recursively renders a PanelNode tree.
 *
 * - LeafNode → renders PaneContent with the appropriate component.
 * - SplitNode → renders a ResizablePanelGroup with each child in a
 *   ResizablePanel, separated by ResizableHandles. Supports horizontal
 *   (side-by-side) and vertical (stacked) orientations, and recursive
 *   nesting to arbitrary depth.
 */
function PanelRenderer({ node }: PanelRendererProps) {
	if (node._tag === "LeafNode") {
		return (
			<div className="h-full w-full overflow-hidden" data-pane-id={node.id}>
				<PaneContent node={node} />
			</div>
		);
	}

	// SplitNode — render children in a resizable panel group
	if (node.children.length === 0) {
		return null;
	}

	return <SplitPanelRenderer node={node} />;
}

interface PanelManagerProps {
	/**
	 * The root panel node to render. When undefined, renders an empty state
	 * guiding the user to create a workspace and spawn a terminal.
	 */
	readonly layout?: PanelNode | undefined;
}

/**
 * Top-level PanelManager component.
 *
 * Renders the panel layout tree, filling its parent container.
 * Pass a PanelNode tree as the `layout` prop, or omit it for an empty state.
 */
function PanelManager({ layout }: PanelManagerProps) {
	if (!layout) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-background">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Layers />
						</EmptyMedia>
						<EmptyTitle>No panels</EmptyTitle>
						<EmptyDescription>
							Create a workspace and spawn a terminal to get started. Panels
							will appear here automatically.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	return (
		<div className="h-full w-full overflow-hidden">
			<PanelRenderer node={layout} />
		</div>
	);
}

export { PanelManager, PanelRenderer, PaneContent, SplitPanelRenderer };
