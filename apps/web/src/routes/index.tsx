import { useAtomValue } from "@effect-atom/atom-react/Hooks";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { LaborerClient } from "@/atoms/laborer-client";
import { AddProjectForm } from "@/components/add-project-form";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { ProjectList } from "@/components/project-list";
import { WorkspaceList } from "@/components/workspace-list";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

const TITLE_TEXT = `
 ██╗      █████╗ ██████╗  ██████╗ ██████╗ ███████╗██████╗
 ██║     ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██╔════╝██╔══██╗
 ██║     ███████║██████╔╝██║   ██║██████╔╝█████╗  ██████╔╝
 ██║     ██╔══██║██╔══██╗██║   ██║██╔══██╗██╔══╝  ██╔══██╗
 ███████╗██║  ██║██████╔╝╚██████╔╝██║  ██║███████╗██║  ██║
 ╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
 `;

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

function HomeComponent() {
	return (
		<div className="container mx-auto max-w-3xl px-4 py-2">
			<pre className="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
			<div className="grid gap-6">
				<section>
					<div className="mb-2 flex items-center justify-between">
						<h2 className="font-medium">Projects</h2>
						<AddProjectForm />
					</div>
					<ProjectList />
				</section>
				<section>
					<div className="mb-2 flex items-center justify-between">
						<h2 className="font-medium">Workspaces</h2>
						<CreateWorkspaceForm />
					</div>
					<WorkspaceList />
				</section>
				<section className="rounded-lg border p-4">
					<h2 className="mb-2 font-medium">Server RPC Status</h2>
					<p className="text-sm">
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
		</div>
	);
}
