import { useAtomValue } from "@effect-atom/atom-react/Hooks";
import { terminals, workspaces } from "@laborer/shared/schema";
import type { LeafNode, PanelNode, SplitNode } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useMemo } from "react";
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
import { PanelManager } from "@/panels/panel-manager";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

/** LiveStore queries for building the default panel layout. */
const allTerminals$ = queryDb(terminals, { label: "homePanelTerminals" });
const allWorkspaces$ = queryDb(workspaces, { label: "homePanelWorkspaces" });

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
 * Builds a default panel layout from the current LiveStore state.
 *
 * - Multiple running terminals → horizontal SplitNode (side-by-side panes)
 * - Single running terminal → LeafNode
 * - Active workspaces but no terminals → empty terminal pane
 * - No workspaces → undefined (PanelManager shows empty state)
 */
function usePanelLayout(): PanelNode | undefined {
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

function HomeComponent() {
	const layout = usePanelLayout();

	return (
		<ResizablePanelGroup orientation="horizontal">
			{/* Sidebar — project list, workspace list, health check */}
			<ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
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
			<ResizablePanel defaultSize={75} minSize={40}>
				<PanelManager layout={layout} />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
