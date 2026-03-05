/**
 * PanelManager — tmux-style panel system for rendering terminal and diff panes.
 *
 * Renders a panel layout based on a `PanelNode` tree structure. Supports:
 * - Single pane rendering (LeafNode)
 * - Horizontal split (SplitNode with direction "horizontal") — side-by-side panes
 * - Vertical split (SplitNode with direction "vertical") — stacked panes
 * - Recursive nesting of splits to arbitrary depth (5+ levels tested)
 * - Close pane with automatic tree collapse
 *
 * The PanelManager fills its parent container and renders pane content
 * based on the pane type:
 * - "terminal" → renders a TerminalPane with xterm.js
 * - "diff" → renders a DiffPane with @pierre/diffs
 *
 * Empty terminal panes show a guided empty state with a CTA to spawn a
 * terminal directly in the pane. If the pane has a workspaceId or there's
 * exactly one active workspace, the user can spawn with one click. If
 * multiple workspaces are active, a dropdown lets them pick which workspace
 * to spawn in. If no workspaces exist, guidance text points to the sidebar.
 *
 * Split panes are rendered using react-resizable-panels (via shadcn/ui's
 * resizable wrapper) with drag-to-resize handles between each child.
 *
 * Split/close/diff-toggle actions have moved to the PanelHeaderBar in the
 * route component. PanelActionsContext is still used for active-pane tracking.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see apps/web/src/panes/terminal-pane.tsx — Terminal pane component
 * @see apps/web/src/panels/layout-utils.ts — Tree manipulation functions
 * @see apps/web/src/panels/panel-context.tsx — PanelActionsContext
 * @see Issue #66: PanelManager — single pane rendering
 * @see Issue #67: PanelManager — horizontal split
 * @see Issue #68: PanelManager — vertical split
 * @see Issue #69: PanelManager — recursive splits
 * @see Issue #120: Empty state — no terminals
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { workspaces } from "@laborer/shared/schema";
import type { LeafNode, PanelNode, SplitNode } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import { Layers, Plus, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";
import { useActivePaneId, usePanelActions } from "@/panels/panel-context";
import { usePanelGroupRegistry } from "@/panels/panel-group-registry";
import { DiffPane } from "@/panes/diff-pane";
import { TerminalPane } from "@/panes/terminal-pane";

const allWorkspaces$ = queryDb(workspaces, { label: "paneWorkspaces" });
const spawnTerminalMutation = LaborerClient.mutation("terminal.spawn");

interface EmptyTerminalPaneProps {
	/** The pane ID, used to assign the spawned terminal to this specific pane. */
	readonly paneId: string;
	/** Pre-assigned workspace ID from the pane node, if any. */
	readonly workspaceId?: string | undefined;
}

/**
 * Empty state for terminal panes with no terminal assigned.
 *
 * Provides a CTA to spawn a terminal directly in this pane:
 * - If the pane has a workspaceId or exactly one active workspace exists,
 *   a single "Spawn Terminal" button spawns and assigns immediately.
 * - If multiple active workspaces exist, a dropdown lets the user pick
 *   which workspace to spawn in.
 * - If no active workspaces exist, shows guidance pointing to the sidebar.
 */
function EmptyTerminalPane({ paneId, workspaceId }: EmptyTerminalPaneProps) {
	const store = useLaborerStore();
	const workspaceList = store.useQuery(allWorkspaces$);
	const panelActions = usePanelActions();
	const spawnTerminal = useAtomSet(spawnTerminalMutation, {
		mode: "promise",
	});
	const [isSpawning, setIsSpawning] = useState(false);
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

	const activeWorkspaces = workspaceList.filter(
		(ws) => ws.status === "running" || ws.status === "creating"
	);

	// Determine which workspace to use for spawning
	const singleWorkspaceId =
		activeWorkspaces.length === 1 ? activeWorkspaces[0]?.id : undefined;
	const resolvedWorkspaceId =
		workspaceId ?? singleWorkspaceId ?? selectedWorkspaceId;

	const handleSpawn = useCallback(async () => {
		if (!resolvedWorkspaceId) {
			return;
		}
		setIsSpawning(true);
		try {
			const result = await spawnTerminal({
				payload: { workspaceId: resolvedWorkspaceId },
			});
			toast.success(`Terminal spawned: ${result.command}`);
			if (panelActions) {
				panelActions.assignTerminalToPane(
					result.id,
					resolvedWorkspaceId,
					paneId
				);
			}
		} catch (error) {
			toast.error(`Failed to spawn terminal: ${extractErrorMessage(error)}`);
		} finally {
			setIsSpawning(false);
		}
	}, [spawnTerminal, resolvedWorkspaceId, panelActions, paneId]);

	const hasMultipleWorkspaces = !workspaceId && activeWorkspaces.length > 1;

	return (
		<div className="flex h-full w-full items-center justify-center bg-background">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TerminalIcon />
					</EmptyMedia>
					<EmptyTitle>No terminal</EmptyTitle>
					<EmptyDescription>
						{activeWorkspaces.length === 0
							? "Create a workspace first, then spawn a terminal to see output here."
							: "Spawn a terminal in a workspace to see output here."}
					</EmptyDescription>
				</EmptyHeader>
				{activeWorkspaces.length > 0 && (
					<EmptyContent>
						{hasMultipleWorkspaces && (
							<Select
								onValueChange={(value) => setSelectedWorkspaceId(value ?? "")}
								value={selectedWorkspaceId}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select workspace" />
								</SelectTrigger>
								<SelectContent>
									{activeWorkspaces.map((ws) => (
										<SelectItem key={ws.id} value={ws.id}>
											{ws.branchName}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<Button
							disabled={isSpawning || !resolvedWorkspaceId}
							onClick={handleSpawn}
							size="sm"
							variant="outline"
						>
							<Plus className="size-3.5" />
							{isSpawning ? "Spawning..." : "Spawn Terminal"}
						</Button>
					</EmptyContent>
				)}
			</Empty>
		</div>
	);
}

interface PaneContentProps {
	/** The leaf node describing this pane's content. */
	readonly node: LeafNode;
}

/**
 * Renders the content of a single pane based on its type and assigned IDs.
 *
 * Terminal panes with `diffOpen: true` render the diff as an integrated
 * sidebar (resizable) alongside the terminal within the same pane container.
 * This keeps the diff visually coupled to its terminal.
 */
function PaneContent({ node }: PaneContentProps) {
	if (node.paneType === "terminal" && node.terminalId) {
		// Terminal with integrated diff sidebar
		if (node.diffOpen && node.workspaceId) {
			return (
				<ResizablePanelGroup orientation="horizontal">
					<ResizablePanel defaultSize="60%" minSize="20%">
						<TerminalPane terminalId={node.terminalId} />
					</ResizablePanel>
					<ResizableHandle />
					<ResizablePanel defaultSize="40%" minSize="15%">
						<DiffPane workspaceId={node.workspaceId} />
					</ResizablePanel>
				</ResizablePanelGroup>
			);
		}
		return <TerminalPane terminalId={node.terminalId} />;
	}

	// Empty pane — use guided empty state with CTA for terminal panes
	if (node.paneType === "terminal") {
		return (
			<EmptyTerminalPane paneId={node.id} workspaceId={node.workspaceId} />
		);
	}

	// Generic empty pane (non-terminal)
	return (
		<div className="flex h-full w-full items-center justify-center bg-background">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Layers />
					</EmptyMedia>
					<EmptyTitle>Empty pane</EmptyTitle>
					<EmptyDescription>Assign content to this pane.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}

/**
 * Pane toolbar — currently empty since split/diff/close actions moved
 * to the top-level PanelHeaderBar. Kept as a hook point in case
 * per-pane controls are added later.
 */

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
 *
 * Registers the ResizablePanelGroup's imperative handle with the
 * PanelGroupRegistry so keyboard shortcuts can programmatically resize
 * panels via `groupRef.setLayout()`.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */
function SplitPanelRenderer({ node }: { readonly node: SplitNode }) {
	const registry = usePanelGroupRegistry();
	const groupRef = useRef<GroupImperativeHandle | null>(null);

	useEffect(() => {
		if (registry && groupRef.current) {
			registry.registerGroupRef(node.id, groupRef.current);
		}
		return () => {
			registry?.unregisterGroupRef(node.id);
		};
	}, [registry, node.id]);

	return (
		<ResizablePanelGroup
			data-split-id={node.id}
			groupRef={groupRef}
			orientation={node.direction}
		>
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
 *
 * Each ResizablePanel has an `id` matching its PanelNode ID, enabling
 * programmatic resize via the GroupImperativeHandle's `setLayout()` API.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
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
			<ResizablePanel
				defaultSize={`${defaultSize}%`}
				id={child.id}
				minSize="5%"
			>
				<PanelRenderer node={child} />
			</ResizablePanel>
		</>
	);
}

/**
 * Recursively renders a PanelNode tree.
 *
 * - LeafNode → renders PaneContent with the appropriate component,
 *   wrapped in a container with active-pane highlighting.
 * - SplitNode → renders a ResizablePanelGroup with each child in a
 *   ResizablePanel, separated by ResizableHandles. Supports horizontal
 *   (side-by-side) and vertical (stacked) orientations, and recursive
 *   nesting to arbitrary depth (5+ levels).
 */
function PanelRenderer({ node }: PanelRendererProps) {
	const activePaneId = useActivePaneId();
	const actions = usePanelActions();
	const isActive = activePaneId === node.id;

	if (node._tag === "LeafNode") {
		return (
			<div
				className={`group/pane relative h-full w-full overflow-hidden ${
					isActive ? "ring-2 ring-primary ring-inset" : ""
				}`}
				data-pane-id={node.id}
				onFocusCapture={() => actions?.setActivePaneId(node.id)}
				onMouseDownCapture={() => actions?.setActivePaneId(node.id)}
			>
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
 *
 * Split/close actions are provided via PanelActionsProvider. If no provider
 * is present, the pane toolbar is hidden.
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
