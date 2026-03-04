/**
 * PanelManager — tmux-style panel system for rendering terminal and diff panes.
 *
 * Renders a panel layout based on a `PanelNode` tree structure. Currently
 * supports rendering a single pane that hosts a terminal component. Future
 * issues will add horizontal/vertical splitting, recursive splits, and
 * layout persistence via LiveStore.
 *
 * The PanelManager fills its parent container and renders pane content
 * based on the pane type:
 * - "terminal" → renders a TerminalPane with xterm.js
 * - "diff" → placeholder for future DiffPane component
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see apps/web/src/panes/terminal-pane.tsx — Terminal pane component
 * @see Issue #66: PanelManager — single pane rendering
 */

import type { LeafNode, PanelNode } from "@laborer/shared/types";
import { Layers, Terminal as TerminalIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
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
 * Recursively renders a PanelNode tree.
 *
 * - LeafNode → renders PaneContent with the appropriate component.
 * - SplitNode → will render child panels in a resizable split (Issue #67/#68).
 *
 * For now, only LeafNode rendering is implemented. SplitNode renders its
 * first child as a fallback until the split infrastructure is built.
 */
function PanelRenderer({ node }: PanelRendererProps) {
	if (node._tag === "LeafNode") {
		return (
			<div className="h-full w-full overflow-hidden" data-pane-id={node.id}>
				<PaneContent node={node} />
			</div>
		);
	}

	// SplitNode — future: render with ResizablePanelGroup (Issue #67/#68)
	// For now, render the first child as a fallback
	const firstChild = node.children[0];
	if (firstChild) {
		return <PanelRenderer node={firstChild} />;
	}

	return null;
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

export { PanelManager, PanelRenderer, PaneContent };
