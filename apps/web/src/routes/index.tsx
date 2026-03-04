import { useAtomValue } from "@effect-atom/atom-react/Hooks";
import { terminals, workspaces } from "@laborer/shared/schema";
import type { LeafNode } from "@laborer/shared/types";
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
 * If there are running terminals, creates a LeafNode for the first one.
 * If there are running workspaces but no terminals, shows an empty terminal pane.
 * Otherwise, returns undefined (PanelManager shows empty state).
 */
function usePanelLayout(): LeafNode | undefined {
	const store = useLaborerStore();
	const terminalList = store.useQuery(allTerminals$);
	const workspaceList = store.useQuery(allWorkspaces$);

	return useMemo(() => {
		// Find the first running terminal
		const runningTerminal = terminalList.find((t) => t.status === "running");
		if (runningTerminal) {
			return {
				_tag: "LeafNode" as const,
				id: `pane-${runningTerminal.id}`,
				paneType: "terminal" as const,
				terminalId: runningTerminal.id,
				workspaceId: runningTerminal.workspaceId,
			};
		}

		// If there are active workspaces but no terminals, show an empty terminal pane
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
			};
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
