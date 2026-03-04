import { useAtomValue } from "@effect-atom/atom-react/Hooks";
import {
	layoutPaneAssigned,
	layoutPaneClosed,
	layoutRestored,
	layoutSplit,
	panelLayout,
	terminals,
	workspaces,
} from "@laborer/shared/schema";
import type { LeafNode, PanelNode, SplitNode } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { LaborerClient } from "@/atoms/laborer-client";
import { AddProjectForm } from "@/components/add-project-form";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { ProjectList } from "@/components/project-list";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkspaceList } from "@/components/workspace-list";
import { useLaborerStore } from "@/livestore/store";
import {
	closePane,
	generateId,
	getLeafIds,
	replaceNode,
	splitPane,
} from "@/panels/layout-utils";
import { PanelActionsProvider } from "@/panels/panel-context";
import { PanelManager } from "@/panels/panel-manager";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

/** LiveStore queries for building the default panel layout. */
const allTerminals$ = queryDb(terminals, { label: "homePanelTerminals" });
const allWorkspaces$ = queryDb(workspaces, { label: "homePanelWorkspaces" });

/** Session ID for the persisted panel layout row. Single-user, single-session. */
const LAYOUT_SESSION_ID = "default";

/** Query the persisted panel layout from LiveStore. */
const persistedLayout$ = queryDb(panelLayout, {
	label: "persistedPanelLayout",
});

/**
 * Health check query atom — subscribes to the server's health.check RPC.
 * Returns a Result<HealthCheckResponse, RpcError>.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
const healthCheck$ = LaborerClient.query("health.check", undefined as void);

function HealthCheckStatus() {
	const result = useAtomValue(healthCheck$);
	if (result._tag === "Initial" || result.waiting) {
		return <span className="text-muted-foreground">connecting...</span>;
	}
	if (result._tag === "Failure") {
		return <span className="text-destructive">disconnected</span>;
	}
	return (
		<span className="text-green-500">
			connected (uptime: {Math.round(result.value.uptime)}s)
		</span>
	);
}

/**
 * Computes an initial panel layout from the current LiveStore state.
 *
 * This is used to seed the layout when there's no persisted layout yet.
 *
 * - Multiple running terminals → horizontal SplitNode (side-by-side panes)
 * - Single running terminal → LeafNode
 * - Active workspaces but no terminals → empty terminal pane
 * - No workspaces → undefined (PanelManager shows empty state)
 */
function useInitialLayout(): PanelNode | undefined {
	const store = useLaborerStore();
	const terminalList = store.useQuery(allTerminals$);
	const workspaceList = store.useQuery(allWorkspaces$);

	return useMemo(() => {
		const runningTerminals = terminalList.filter((t) => t.status === "running");

		// Multiple running terminals → horizontal split
		if (runningTerminals.length > 1) {
			const children: readonly LeafNode[] = runningTerminals.map((t) => ({
				_tag: "LeafNode" as const,
				id: `pane-${t.id}`,
				paneType: "terminal" as const,
				terminalId: t.id,
				workspaceId: t.workspaceId,
			}));
			const equalSize = 100 / children.length;
			const sizes: readonly number[] = children.map(() => equalSize);
			return {
				_tag: "SplitNode" as const,
				id: "split-root",
				direction: "horizontal" as const,
				children,
				sizes,
			} satisfies SplitNode;
		}

		// Single running terminal → single pane
		const runningTerminal = runningTerminals[0];
		if (runningTerminal) {
			return {
				_tag: "LeafNode" as const,
				id: `pane-${runningTerminal.id}`,
				paneType: "terminal" as const,
				terminalId: runningTerminal.id,
				workspaceId: runningTerminal.workspaceId,
			} satisfies LeafNode;
		}

		// Active workspaces but no terminals → empty terminal pane
		const activeWorkspace = workspaceList.find(
			(ws) => ws.status === "running" || ws.status === "creating"
		);
		if (activeWorkspace) {
			return {
				_tag: "LeafNode" as const,
				id: `pane-empty-${activeWorkspace.id}`,
				paneType: "terminal" as const,
				terminalId: undefined,
				workspaceId: activeWorkspace.id,
			} satisfies LeafNode;
		}

		return undefined;
	}, [terminalList, workspaceList]);
}

/**
 * Manages the panel layout state, providing split and close actions
 * that mutate the tree and persist changes to LiveStore.
 *
 * Layout persistence flow:
 * 1. Read the persisted layout from LiveStore's `panelLayout` table.
 * 2. If no persisted layout exists, fall back to the auto-generated layout
 *    from terminals/workspaces and commit it as a `layoutRestored` event.
 * 3. On split/close, compute the new tree and commit the appropriate
 *    layout event (`layoutSplit` / `layoutPaneClosed`) to LiveStore.
 * 4. The materializer upserts the row, and the reactive query re-fires.
 *
 * @see Issue #73: PanelManager — serialize layout to LiveStore
 */
function usePanelLayout() {
	const store = useLaborerStore();
	const initialLayout = useInitialLayout();

	// Read the persisted layout from LiveStore reactively.
	// Returns all rows (should be 0 or 1 for the "default" session).
	const persistedRows = store.useQuery(persistedLayout$);
	const persistedRow = persistedRows.find(
		(row) => row.id === LAYOUT_SESSION_ID
	);

	// The persisted layout tree, if one exists in LiveStore.
	const persistedLayoutTree = persistedRow?.layoutTree as PanelNode | undefined;
	const persistedActivePaneId = persistedRow?.activePaneId ?? null;

	// Determine the effective layout: persisted layout takes priority,
	// otherwise fall back to the auto-generated layout from terminals/workspaces.
	const layout = persistedLayoutTree ?? initialLayout;

	// Seed LiveStore with the initial layout when there's no persisted layout
	// but we have an auto-generated one from terminals/workspaces.
	const hasSeeded = useRef(false);
	useEffect(() => {
		if (!persistedLayoutTree && initialLayout && !hasSeeded.current) {
			hasSeeded.current = true;
			store.commit(
				layoutRestored({
					id: LAYOUT_SESSION_ID,
					layoutTree: initialLayout,
					activePaneId: null,
				})
			);
		}
	}, [persistedLayoutTree, initialLayout, store]);

	const handleSplitPane = useCallback(
		(paneId: string, direction: "horizontal" | "vertical") => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				return;
			}
			const newTree = splitPane(base, paneId, direction);
			store.commit(
				layoutSplit({
					id: LAYOUT_SESSION_ID,
					layoutTree: newTree,
					activePaneId: persistedActivePaneId,
				})
			);
		},
		[persistedLayoutTree, initialLayout, persistedActivePaneId, store]
	);

	const handleClosePane = useCallback(
		(paneId: string) => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				return;
			}
			const newTree = closePane(base, paneId);
			if (newTree) {
				store.commit(
					layoutPaneClosed({
						id: LAYOUT_SESSION_ID,
						layoutTree: newTree,
						activePaneId: persistedActivePaneId,
					})
				);
			} else {
				// All panes closed — remove the persisted layout so the
				// empty state renders and a new initial layout can seed.
				store.commit(
					layoutPaneClosed({
						id: LAYOUT_SESSION_ID,
						// Commit a single empty leaf as a placeholder since
						// the schema requires a valid PanelNode.
						// The PanelManager will show the empty state because
						// the pane has no terminal assigned.
						layoutTree: {
							_tag: "LeafNode" as const,
							id: "pane-empty",
							paneType: "terminal" as const,
							terminalId: undefined,
							workspaceId: undefined,
						},
						activePaneId: null,
					})
				);
				hasSeeded.current = false;
			}
		},
		[persistedLayoutTree, initialLayout, persistedActivePaneId, store]
	);

	const handleAssignTerminalToPane = useCallback(
		(terminalId: string, workspaceId: string, paneId?: string) => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				// No layout at all — create a new single-pane layout for this terminal
				const newLeaf: LeafNode = {
					_tag: "LeafNode" as const,
					id: generateId("pane"),
					paneType: "terminal" as const,
					terminalId,
					workspaceId,
				};
				store.commit(
					layoutPaneAssigned({
						id: LAYOUT_SESSION_ID,
						layoutTree: newLeaf,
						activePaneId: newLeaf.id,
					})
				);
				return;
			}

			// If a specific pane ID is given, replace that pane's content
			if (paneId) {
				const targetLeaf: LeafNode = {
					_tag: "LeafNode" as const,
					id: paneId,
					paneType: "terminal" as const,
					terminalId,
					workspaceId,
				};
				const newTree = replaceNode(base, paneId, targetLeaf);
				store.commit(
					layoutPaneAssigned({
						id: LAYOUT_SESSION_ID,
						layoutTree: newTree,
						activePaneId: paneId,
					})
				);
				return;
			}

			// No specific pane — find an empty terminal pane or the first pane
			const leafIds = getLeafIds(base);
			const findEmptyTerminalPane = (node: PanelNode): LeafNode | undefined => {
				if (
					node._tag === "LeafNode" &&
					node.paneType === "terminal" &&
					!node.terminalId
				) {
					return node;
				}
				if (node._tag === "SplitNode") {
					for (const child of node.children) {
						const found = findEmptyTerminalPane(child);
						if (found) {
							return found;
						}
					}
				}
				return undefined;
			};

			const emptyPane = findEmptyTerminalPane(base);
			if (emptyPane) {
				// Assign to the empty pane
				const updatedLeaf: LeafNode = {
					_tag: "LeafNode" as const,
					id: emptyPane.id,
					paneType: "terminal" as const,
					terminalId,
					workspaceId,
				};
				const newTree = replaceNode(base, emptyPane.id, updatedLeaf);
				store.commit(
					layoutPaneAssigned({
						id: LAYOUT_SESSION_ID,
						layoutTree: newTree,
						activePaneId: emptyPane.id,
					})
				);
				return;
			}

			// No empty pane — split the first leaf and assign to the new pane
			const firstLeafId = leafIds[0];
			if (firstLeafId) {
				const newPaneContent: Partial<LeafNode> = {
					paneType: "terminal" as const,
					terminalId,
					workspaceId,
				};
				const newTree = splitPane(
					base,
					firstLeafId,
					"horizontal",
					newPaneContent
				);
				store.commit(
					layoutPaneAssigned({
						id: LAYOUT_SESSION_ID,
						layoutTree: newTree,
						activePaneId: persistedActivePaneId,
					})
				);
			}
		},
		[persistedLayoutTree, initialLayout, persistedActivePaneId, store]
	);

	const panelActions = useMemo(
		() => ({
			assignTerminalToPane: handleAssignTerminalToPane,
			splitPane: handleSplitPane,
			closePane: handleClosePane,
		}),
		[handleAssignTerminalToPane, handleSplitPane, handleClosePane]
	);

	return { layout, panelActions };
}

function HomeComponent() {
	const { layout, panelActions } = usePanelLayout();

	return (
		<ResizablePanelGroup orientation="horizontal">
			{/* Sidebar — project list, workspace list, health check */}
			<ResizablePanel defaultSize="25%" maxSize="40%" minSize="15%">
				<ScrollArea className="h-full">
					<div className="grid gap-4 p-3">
						<section>
							<div className="mb-2 flex items-center justify-between">
								<h2 className="font-medium text-sm">Projects</h2>
								<AddProjectForm />
							</div>
							<ProjectList />
						</section>
						<section>
							<div className="mb-2 flex items-center justify-between">
								<h2 className="font-medium text-sm">Workspaces</h2>
								<CreateWorkspaceForm />
							</div>
							<WorkspaceList />
						</section>
						<section className="rounded-lg border p-3">
							<h2 className="mb-1 font-medium text-sm">Server Status</h2>
							<p className="text-xs">
								<Suspense
									fallback={
										<span className="text-muted-foreground">loading...</span>
									}
								>
									<HealthCheckStatus />
								</Suspense>
							</p>
						</section>
					</div>
				</ScrollArea>
			</ResizablePanel>

			<ResizableHandle withHandle />

			{/* Main content — Panel system */}
			<ResizablePanel defaultSize="75%" minSize="40%">
				<PanelActionsProvider value={panelActions}>
					<PanelManager layout={layout} />
				</PanelActionsProvider>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
