import { useAtomValue } from "@effect-atom/atom-react/Hooks";
import {
	layoutPaneAssigned,
	layoutPaneClosed,
	layoutRestored,
	layoutSplit,
	panelLayout,
	projects,
	workspaces,
} from "@laborer/shared/schema";
import type { LeafNode, PanelNode, SplitNode } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import { createFileRoute } from "@tanstack/react-router";
import {
	Columns2,
	FileCode2,
	FolderGit2,
	LayoutDashboard,
	PanelLeftClose,
	PanelLeftOpen,
	Rows2,
	Terminal,
	X,
} from "lucide-react";
import {
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { LaborerClient } from "@/atoms/laborer-client";
import { AddProjectForm } from "@/components/add-project-form";
import { CreatePlanWorkspace } from "@/components/create-plan-workspace";
import { PlanEditor } from "@/components/plan-editor";
import { PlanIssuesList } from "@/components/plan-issues-list";
import { ProjectGroup } from "@/components/project-group";
import { SidebarSearch } from "@/components/sidebar-search";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkspaceDashboard } from "@/components/workspace-dashboard";
import { useProjectCollapseState } from "@/hooks/use-project-collapse-state";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { useSidebarWidth } from "@/hooks/use-sidebar-width";
import { useTerminalList } from "@/hooks/use-terminal-list";
import { useTrayWorkspaceCount } from "@/hooks/use-tray-workspace-count";
import { useLaborerStore } from "@/livestore/store";
import type { NavigationDirection } from "@/panels/layout-utils";
import {
	closePane,
	computeResize,
	ensureValidActivePaneId,
	findNodeById,
	findSiblingPaneId,
	generateId,
	getFirstLeafId,
	getLeafIds,
	replaceNode,
	splitPane,
} from "@/panels/layout-utils";
import {
	PanelActionsProvider,
	useActivePaneId,
	usePanelActions,
} from "@/panels/panel-context";
import {
	PanelGroupRegistryProvider,
	usePanelGroupRegistry,
} from "@/panels/panel-group-registry";
import { PanelHotkeys } from "@/panels/panel-hotkeys";
import { PanelManager } from "@/panels/panel-manager";

/**
 * Route-level wrapper that provides PanelGroupRegistryProvider above
 * HomeComponent so that usePanelLayout can access the registry.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */
function HomeRoute() {
	return (
		<PanelGroupRegistryProvider>
			<HomeComponent />
		</PanelGroupRegistryProvider>
	);
}

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

/** LiveStore query for building the default panel layout. */
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
		<span className="text-success">
			connected (uptime: {Math.round(result.value.uptime)}s)
		</span>
	);
}

/** LiveStore query for projects (used by PanelHeaderBar to resolve names). */
const allProjects$ = queryDb(projects, { label: "headerProjects" });

/** The two main content views: terminal panels, cross-project dashboard, or plan editor. */
type MainView = "panels" | "dashboard" | "plan";

/**
 * Thin header bar rendered above the PanelManager.
 *
 * - Left side: view toggle (panels / dashboard) + `project / branch`
 *   context for the active pane's workspace (in panels view).
 * - Right side: split horizontal, split vertical, diff toggle, and close
 *   buttons that operate on the active pane (disabled in dashboard view).
 *
 * Uses the PanelActionsContext so it must be rendered inside a
 * PanelActionsProvider.
 *
 * @see Issue #114: Cross-project workspace dashboard
 */
function PanelHeaderBar({
	layout,
	mainView,
	onViewChange,
	onToggleSidebar,
	sidebarCollapsed,
}: {
	readonly layout?: PanelNode | undefined;
	readonly mainView: MainView;
	readonly onViewChange: (view: MainView) => void;
	readonly onToggleSidebar?: (() => void) | undefined;
	readonly sidebarCollapsed?: boolean;
}) {
	const store = useLaborerStore();
	const activePaneId = useActivePaneId();
	const actions = usePanelActions();

	const projectList = store.useQuery(allProjects$);
	const workspaceList = store.useQuery(allWorkspaces$);

	// Resolve the active leaf node from the layout tree
	const activeLeaf = useMemo((): LeafNode | undefined => {
		if (!(layout && activePaneId)) {
			return undefined;
		}
		const node = findNodeById(layout, activePaneId);
		if (node && node._tag === "LeafNode") {
			return node;
		}
		return undefined;
	}, [layout, activePaneId]);

	// Resolve workspace and project names for the active pane
	const { projectName, branchName } = useMemo(() => {
		if (!activeLeaf?.workspaceId) {
			return { projectName: undefined, branchName: undefined };
		}
		const workspace = workspaceList.find(
			(ws) => ws.id === activeLeaf.workspaceId
		);
		if (!workspace) {
			return { projectName: undefined, branchName: undefined };
		}
		const project = projectList.find((p) => p.id === workspace.projectId);
		return {
			projectName: project?.name,
			branchName: workspace.branchName,
		};
	}, [activeLeaf, workspaceList, projectList]);

	const showDiffToggle =
		mainView === "panels" &&
		activeLeaf?.paneType === "terminal" &&
		activeLeaf.workspaceId !== undefined;
	const diffIsOpen = activeLeaf?.diffOpen === true;
	const hasActivePane = mainView === "panels" && !!activePaneId && !!activeLeaf;

	return (
		<div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
			{/* Left: sidebar toggle + view toggle + project / branch context */}
			<div className="flex items-center gap-2">
				{onToggleSidebar && (
					<Button
						aria-label={
							sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
						}
						onClick={onToggleSidebar}
						size="icon-sm"
						title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
						variant="ghost"
					>
						{sidebarCollapsed ? (
							<PanelLeftOpen className="size-3.5" />
						) : (
							<PanelLeftClose className="size-3.5" />
						)}
					</Button>
				)}
				<div className="flex gap-0.5">
					<Button
						aria-label="Terminal panels"
						className={mainView === "panels" ? "bg-accent" : ""}
						onClick={() => onViewChange("panels")}
						size="icon-sm"
						title="Terminal panels"
						variant="ghost"
					>
						<Terminal className="size-3.5" />
					</Button>
					<Button
						aria-label="Dashboard"
						className={mainView === "dashboard" ? "bg-accent" : ""}
						onClick={() => onViewChange("dashboard")}
						size="icon-sm"
						title="Cross-project dashboard"
						variant="ghost"
					>
						<LayoutDashboard className="size-3.5" />
					</Button>
				</div>
				<div className="min-w-0 truncate text-muted-foreground text-xs">
					{mainView === "panels" && projectName && branchName ? (
						<>
							<span className="text-foreground">{projectName}</span>
							<span className="mx-1">/</span>
							<span>{branchName}</span>
						</>
					) : null}
					{mainView === "dashboard" && (
						<span className="text-foreground">Dashboard</span>
					)}
				</div>
			</div>

			{/* Right: pane actions */}
			<div className="flex gap-0.5">
				{showDiffToggle && (
					<Button
						aria-label={diffIsOpen ? "Close diff viewer" : "Open diff viewer"}
						className={diffIsOpen ? "bg-accent" : ""}
						disabled={!hasActivePane}
						onClick={() =>
							activePaneId && actions?.toggleDiffPane(activePaneId)
						}
						size="icon-sm"
						variant="ghost"
					>
						<FileCode2 className="size-3.5" />
					</Button>
				)}
				<Button
					aria-label="Split horizontally"
					disabled={!hasActivePane}
					onClick={() =>
						activePaneId && actions?.splitPane(activePaneId, "horizontal")
					}
					size="icon-sm"
					variant="ghost"
				>
					<Columns2 className="size-3.5" />
				</Button>
				<Button
					aria-label="Split vertically"
					disabled={!hasActivePane}
					onClick={() =>
						activePaneId && actions?.splitPane(activePaneId, "vertical")
					}
					size="icon-sm"
					variant="ghost"
				>
					<Rows2 className="size-3.5" />
				</Button>
				<Button
					aria-label="Close pane"
					disabled={!hasActivePane}
					onClick={() => activePaneId && actions?.closePane(activePaneId)}
					size="icon-sm"
					variant="ghost"
				>
					<X className="size-3.5" />
				</Button>
			</div>
		</div>
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
	const { terminals: terminalList } = useTerminalList();
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
	const registry = usePanelGroupRegistry();

	// Read the persisted layout from LiveStore reactively.
	// Returns all rows (should be 0 or 1 for the "default" session).
	const persistedRows = store.useQuery(persistedLayout$);
	const persistedRow = persistedRows.find(
		(row) => row.id === LAYOUT_SESSION_ID
	);

	// The persisted layout tree, if one exists in LiveStore.
	const persistedLayoutTree = persistedRow?.layoutTree as PanelNode | undefined;
	const rawPersistedActivePaneId = persistedRow?.activePaneId ?? null;

	// Determine the effective layout: persisted layout takes priority,
	// otherwise fall back to the auto-generated layout from terminals/workspaces.
	const layout = persistedLayoutTree ?? initialLayout;

	// Enforce the guaranteed active pane invariant: when a layout exists,
	// activePaneId must reference a valid leaf node. If it's null or stale
	// (pointing to a removed pane), fall back to the first leaf.
	// @see Issue #150: Guaranteed active pane invariant
	const persistedActivePaneId = layout
		? ensureValidActivePaneId(layout, rawPersistedActivePaneId)
		: null;

	// Seed LiveStore with the initial layout when there's no persisted layout
	// but we have an auto-generated one from terminals/workspaces.
	// Sets activePaneId to the first leaf so keyboard shortcuts work immediately.
	// @see Issue #150: Guaranteed active pane invariant
	const hasSeeded = useRef(false);
	useEffect(() => {
		if (!persistedLayoutTree && initialLayout && !hasSeeded.current) {
			hasSeeded.current = true;
			store.commit(
				layoutRestored({
					id: LAYOUT_SESSION_ID,
					layoutTree: initialLayout,
					activePaneId: getFirstLeafId(initialLayout) ?? null,
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

			// Compute the sibling BEFORE the close mutation removes the pane.
			// This ensures we can find the correct sibling in the original tree.
			// If the closing pane is the currently active pane, transfer focus
			// to its sibling. Otherwise, keep the current active pane.
			const candidateActivePaneId =
				persistedActivePaneId === paneId
					? findSiblingPaneId(base, paneId)
					: persistedActivePaneId;

			const newTree = closePane(base, paneId);
			if (newTree) {
				// Defense-in-depth: validate the candidate activePaneId is a valid
				// leaf in the post-close tree. Handles edge cases where the active
				// pane reference becomes stale after tree mutations.
				// @see Issue #150: Guaranteed active pane invariant
				const nextActivePaneId = ensureValidActivePaneId(
					newTree,
					candidateActivePaneId
				);

				store.commit(
					layoutPaneClosed({
						id: LAYOUT_SESSION_ID,
						layoutTree: newTree,
						activePaneId: nextActivePaneId,
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

	const handleSetActivePaneId = useCallback(
		(paneId: string | null) => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				return;
			}
			// Enforce the invariant: do not accept null when panes exist.
			// If null is passed (e.g., by legacy code), fall back to the first leaf.
			// @see Issue #150: Guaranteed active pane invariant
			const validatedPaneId = ensureValidActivePaneId(base, paneId);
			store.commit(
				layoutPaneAssigned({
					id: LAYOUT_SESSION_ID,
					layoutTree: base,
					activePaneId: validatedPaneId,
				})
			);
		},
		[persistedLayoutTree, initialLayout, store]
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

	/**
	 * Resize a pane in the given direction by adjusting the parent split's
	 * sizes via the imperative GroupImperativeHandle API.
	 *
	 * Finds the nearest ancestor SplitNode matching the direction, computes
	 * new sizes (+/- 5%), and calls `groupRef.setLayout()` to apply them.
	 *
	 * @see Issue #79: Keyboard shortcut — resize panes
	 */
	const handleResizePane = useCallback(
		(paneId: string, direction: NavigationDirection) => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				return;
			}

			const result = computeResize(base, paneId, direction);
			if (!result) {
				return;
			}

			const groupHandle = registry?.getGroupRef(result.splitNodeId);
			if (!groupHandle) {
				return;
			}

			groupHandle.setLayout(result.newSizes);
		},
		[persistedLayoutTree, initialLayout, registry]
	);

	/**
	 * Toggle the integrated diff sidebar on a terminal pane.
	 *
	 * Flips the `diffOpen` flag on the target LeafNode and persists the
	 * updated tree. The diff sidebar is rendered inside the terminal pane
	 * container (not as a separate pane in the layout tree).
	 *
	 * @see Issue #90: Toggle diff alongside terminal
	 */
	const handleToggleDiffPane = useCallback(
		(paneId: string): boolean => {
			const base = persistedLayoutTree ?? initialLayout;
			if (!base) {
				return false;
			}

			const targetNode = findNodeById(base, paneId);
			if (
				!targetNode ||
				targetNode._tag !== "LeafNode" ||
				targetNode.paneType !== "terminal" ||
				!targetNode.workspaceId
			) {
				return false;
			}

			const nowOpen = !targetNode.diffOpen;
			const updatedLeaf: LeafNode = {
				...targetNode,
				diffOpen: nowOpen,
			};
			const newTree = replaceNode(base, paneId, updatedLeaf);
			store.commit(
				layoutPaneAssigned({
					id: LAYOUT_SESSION_ID,
					layoutTree: newTree,
					activePaneId: persistedActivePaneId,
				})
			);
			return nowOpen;
		},
		[persistedLayoutTree, initialLayout, persistedActivePaneId, store]
	);

	const panelActions = useMemo(
		() => ({
			assignTerminalToPane: handleAssignTerminalToPane,
			splitPane: handleSplitPane,
			closePane: handleClosePane,
			setActivePaneId: handleSetActivePaneId,
			toggleDiffPane: handleToggleDiffPane,
			resizePane: handleResizePane,
		}),
		[
			handleAssignTerminalToPane,
			handleSplitPane,
			handleClosePane,
			handleSetActivePaneId,
			handleToggleDiffPane,
			handleResizePane,
		]
	);

	// Compute leaf pane IDs for keyboard navigation
	const leafPaneIds = useMemo(
		() => (layout ? getLeafIds(layout) : []),
		[layout]
	);

	return {
		layout,
		panelActions,
		activePaneId: persistedActivePaneId,
		leafPaneIds,
	};
}

/** LiveStore query for projects (used by sidebar and WelcomeEmptyState). */
const sidebarProjects$ = queryDb(projects, { label: "sidebarProjects" });

/** LiveStore query for workspaces (used by sidebar search filtering). */
const sidebarWorkspaces$ = queryDb(workspaces, {
	label: "sidebarWorkspaces",
});

/**
 * Welcome empty state shown in the main content area when no projects
 * are registered. Guides the user to add their first project.
 *
 * @see Issue #118: Empty state — no projects
 */
function WelcomeEmptyState() {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<FolderGit2 />
				</EmptyMedia>
				<EmptyTitle>Welcome to Laborer</EmptyTitle>
				<EmptyDescription>
					Add a git repository to get started. Laborer will create isolated
					workspaces for your AI agents to work in parallel.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<AddProjectForm />
			</EmptyContent>
		</Empty>
	);
}

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function CloseAppDialog({
	open,
	onOpenChange,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	const handleCloseToTray = useCallback(async () => {
		if (isTauri()) {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().hide();
		}
		onOpenChange(false);
	}, [onOpenChange]);

	const handleCloseClick = useCallback(() => {
		handleCloseToTray().catch(() => {
			onOpenChange(false);
		});
	}, [handleCloseToTray, onOpenChange]);

	return (
		<AlertDialog onOpenChange={onOpenChange} open={open}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Close Laborer?</AlertDialogTitle>
					<AlertDialogDescription>
						The window will be hidden to the system tray. Your workspaces will
						continue running.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={handleCloseClick}>
						Close
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function HomeComponent() {
	const { layout, panelActions, activePaneId, leafPaneIds } = usePanelLayout();
	const store = useLaborerStore();
	const projectList = store.useQuery(sidebarProjects$);
	const workspaceList = store.useQuery(sidebarWorkspaces$);
	const hasProjects = projectList.length > 0;

	// Sync running workspace count to Tauri system tray tooltip (no-op in browser)
	useTrayWorkspaceCount();

	// Responsive sizing — adapts sidebar and pane sizes to viewport width
	const responsiveSizes = useResponsiveLayout();

	// Sidebar width persistence — restore from localStorage, debounced writes
	const sidebarWidth = useSidebarWidth(
		Number.parseFloat(responsiveSizes.sidebarMin),
		Number.parseFloat(responsiveSizes.sidebarMax)
	);

	// Project collapse state — persisted to localStorage
	const collapseState = useProjectCollapseState();

	// Sidebar search — filters the project tree in real-time
	const [searchQuery, setSearchQuery] = useState("");

	// Filter projects and determine which to show based on search query.
	// A project is shown if its name matches OR any of its non-destroyed
	// workspace branch names match. Matching is case-insensitive substring.
	const { filteredProjects, matchingProjectIds } = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) {
			return {
				filteredProjects: projectList,
				matchingProjectIds: new Set<string>(),
			};
		}
		const matching = new Set<string>();
		const filtered = projectList.filter((project) => {
			const nameMatch = project.name.toLowerCase().includes(query);
			const workspaceMatch = workspaceList.some(
				(ws) =>
					ws.projectId === project.id &&
					ws.status !== "destroyed" &&
					ws.branchName.toLowerCase().includes(query)
			);
			if (nameMatch || workspaceMatch) {
				matching.add(project.id);
				return true;
			}
			return false;
		});
		return { filteredProjects: filtered, matchingProjectIds: matching };
	}, [searchQuery, projectList, workspaceList]);

	// When search is active, auto-expand matching projects (override collapse state).
	// When search is cleared, the stored collapse state is naturally restored.
	const isSearchActive = searchQuery.trim().length > 0;

	// Main content view toggle — panels (terminal panes), dashboard, or plan editor
	const [mainView, setMainView] = useState<MainView>("panels");
	const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
	const [isCloseAppDialogOpen, setIsCloseAppDialogOpen] = useState(false);

	// Handle plan selection from sidebar — switch to plan view
	const handleSelectPlan = useCallback((prdId: string) => {
		setSelectedPlanId(prdId);
		setMainView("plan");
	}, []);

	// Handle back from plan editor — return to panels view
	const handlePlanBack = useCallback(() => {
		setSelectedPlanId(null);
		setMainView("panels");
	}, []);

	// Sidebar collapse via imperative panel ref
	const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	const handleSidebarResize = useCallback(
		(panelSize: { asPercentage: number }) => {
			const panel = sidebarPanelRef.current;
			if (panel) {
				setSidebarCollapsed(panel.isCollapsed());
			}
			sidebarWidth.handleResize(panelSize.asPercentage);
		},
		[sidebarWidth.handleResize]
	);

	const toggleSidebar = useCallback(() => {
		const panel = sidebarPanelRef.current;
		if (!panel) {
			return;
		}
		if (panel.isCollapsed()) {
			panel.expand();
		} else {
			panel.collapse();
		}
	}, []);

	const handleMetaWWithoutPane = useCallback(() => {
		if (mainView === "panels") {
			setIsCloseAppDialogOpen(true);
		}
	}, [mainView]);

	return (
		<PanelActionsProvider activePaneId={activePaneId} value={panelActions}>
			<CloseAppDialog
				onOpenChange={setIsCloseAppDialogOpen}
				open={isCloseAppDialogOpen}
			/>
			<ResizablePanelGroup orientation="horizontal">
				{/* Sidebar — search, project groups, workspace list, health check */}
				<ResizablePanel
					collapsedSize="0%"
					collapsible={responsiveSizes.canCollapseSidebar}
					defaultSize={
						sidebarWidth.storedDefault ?? responsiveSizes.sidebarDefault
					}
					maxSize={responsiveSizes.sidebarMax}
					minSize={responsiveSizes.sidebarMin}
					onResize={handleSidebarResize}
					panelRef={sidebarPanelRef}
				>
					<div className="flex h-full flex-col">
						<ScrollArea className="min-h-0 flex-1">
							<div className="grid gap-4 p-3">
								{/* Search bar — filters projects and workspaces in real-time */}
								{hasProjects && (
									<SidebarSearch
										onChange={setSearchQuery}
										value={searchQuery}
									/>
								)}
								<div className="flex items-center justify-between">
									<h2 className="font-medium text-sm">Projects</h2>
									<AddProjectForm />
								</div>
								{/* Project-grouped tree — each project is a collapsible heading */}
								{filteredProjects.map((project) => (
									<ProjectGroup
										expanded={
											isSearchActive && matchingProjectIds.has(project.id)
												? true
												: collapseState.isExpanded(project.id)
										}
										key={project.id}
										onSelectPlan={handleSelectPlan}
										onToggle={() => collapseState.toggle(project.id)}
										project={project}
										selectedPlanId={selectedPlanId}
									/>
								))}
								{projectList.length === 0 && (
									<p className="py-2 text-center text-muted-foreground text-xs">
										No projects. Add one to get started.
									</p>
								)}
								{isSearchActive &&
									filteredProjects.length === 0 &&
									projectList.length > 0 && (
										<p className="py-2 text-center text-muted-foreground text-xs">
											No matching projects or workspaces.
										</p>
									)}
							</div>
						</ScrollArea>
						{/* Server Status — sticky footer, always visible outside scroll area */}
						<section className="shrink-0 border-t p-3">
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
				</ResizablePanel>

				<ResizableHandle withHandle />

				{/* Main content — Panel system, dashboard, plan editor, or welcome empty state */}
				<ResizablePanel defaultSize="75%" minSize="10%">
					{!hasProjects && <WelcomeEmptyState />}
					{hasProjects && mainView === "plan" && selectedPlanId && (
						<div className="flex h-full border-2 border-transparent">
							<div className="min-w-0 flex-1">
								<PlanEditor onBack={handlePlanBack} prdId={selectedPlanId} />
							</div>
							<div className="w-80 shrink-0 border-l">
								<div className="flex h-8 shrink-0 items-center justify-between border-b px-3">
									<span className="font-medium text-sm">Issues</span>
								</div>
								<ScrollArea className="h-[calc(100%-2rem)]">
									<div className="grid gap-3 p-3">
										<CreatePlanWorkspace prdId={selectedPlanId} />
										<PlanIssuesList prdId={selectedPlanId} />
									</div>
								</ScrollArea>
							</div>
						</div>
					)}
					{hasProjects && mainView !== "plan" && (
						<div
							className={`flex h-full flex-col border-2 ${mainView === "panels" && activePaneId ? "border-primary" : "border-transparent"}`}
						>
							<PanelHeaderBar
								layout={layout}
								mainView={mainView}
								onToggleSidebar={
									responsiveSizes.canCollapseSidebar ? toggleSidebar : undefined
								}
								onViewChange={setMainView}
								sidebarCollapsed={sidebarCollapsed}
							/>
							{mainView === "panels" && (
								<>
									<PanelHotkeys
										layout={layout}
										leafPaneIds={leafPaneIds}
										onMetaWWithoutPane={handleMetaWWithoutPane}
									/>
									<div className="min-h-0 flex-1">
										<PanelManager layout={layout} />
									</div>
								</>
							)}
							{mainView === "dashboard" && (
								<div className="min-h-0 flex-1">
									<WorkspaceDashboard />
								</div>
							)}
						</div>
					)}
				</ResizablePanel>
			</ResizablePanelGroup>
		</PanelActionsProvider>
	);
}
