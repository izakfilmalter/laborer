/**
 * Workspace list UI component.
 *
 * Displays a reactive list of workspaces for a given project from LiveStore.
 * Each workspace shows its branch name, port, and status with color-coded
 * badges: creating=yellow, running=green, stopped=gray, errored=red,
 * destroyed=dim.
 * Updates reactively when workspace state changes.
 *
 * @see Issue #41: Workspace list UI component
 */

import { projects, workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { GitBranch, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

const allWorkspaces$ = queryDb(workspaces, { label: "workspaceList" });
const allProjects$ = queryDb(projects, { label: "workspaceListProjects" });

type WorkspaceStatus =
	| "creating"
	| "running"
	| "stopped"
	| "errored"
	| "destroyed";

/**
 * Returns Tailwind classes for a status badge based on workspace status.
 */
function getStatusClasses(status: string): string {
	switch (status as WorkspaceStatus) {
		case "creating":
			return "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
		case "running":
			return "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400";
		case "stopped":
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
		case "errored":
			return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400";
		case "destroyed":
			return "border-muted-foreground/20 bg-muted/50 text-muted-foreground/60";
		default:
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
	}
}

/**
 * Returns a small colored dot indicator for the workspace status.
 */
function StatusDot({ status }: { readonly status: string }) {
	const dotColor = (() => {
		switch (status as WorkspaceStatus) {
			case "creating":
				return "bg-yellow-500 animate-pulse";
			case "running":
				return "bg-green-500";
			case "stopped":
				return "bg-muted-foreground/50";
			case "errored":
				return "bg-red-500";
			case "destroyed":
				return "bg-muted-foreground/30";
			default:
				return "bg-muted-foreground/50";
		}
	})();

	return <span className={cn("inline-block size-2 rounded-full", dotColor)} />;
}

interface WorkspaceItemProps {
	readonly projectName: string;
	readonly workspace: {
		readonly id: string;
		readonly projectId: string;
		readonly branchName: string;
		readonly worktreePath: string;
		readonly port: number;
		readonly status: string;
		readonly createdAt: string;
		readonly taskSource: string | null;
	};
}

function WorkspaceItem({ workspace, projectName }: WorkspaceItemProps) {
	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2">
							<GitBranch className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate font-mono text-sm">
								{workspace.branchName}
							</span>
						</CardTitle>
						<CardDescription>{projectName}</CardDescription>
					</div>
					<Badge
						className={cn(
							"shrink-0 border",
							getStatusClasses(workspace.status)
						)}
						variant="outline"
					>
						<StatusDot status={workspace.status} />
						{workspace.status}
					</Badge>
				</div>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-3 text-muted-foreground text-xs">
					<span>
						Port: <span className="font-mono">{workspace.port}</span>
					</span>
					<span className="truncate font-mono">{workspace.worktreePath}</span>
				</div>
			</CardContent>
		</Card>
	);
}

function WorkspaceList() {
	const store = useLaborerStore();
	const workspaceList = store.useQuery(allWorkspaces$);
	const projectList = store.useQuery(allProjects$);

	// Build a map of project IDs to names for display
	const projectNameMap = new Map(
		projectList.map((p) => [p.id, p.name] as const)
	);

	// Filter out destroyed workspaces from the active list
	const activeWorkspaces = workspaceList.filter(
		(ws) => ws.status !== "destroyed"
	);

	if (activeWorkspaces.length === 0) {
		return (
			<Empty className="border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Layers />
					</EmptyMedia>
					<EmptyTitle>No workspaces</EmptyTitle>
					<EmptyDescription>
						Create a workspace to get started. Each workspace is an isolated git
						worktree with its own branch, port, and dev server.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="grid gap-2">
			{activeWorkspaces.map((workspace) => (
				<WorkspaceItem
					key={workspace.id}
					projectName={projectNameMap.get(workspace.projectId) ?? "Unknown"}
					workspace={workspace}
				/>
			))}
		</div>
	);
}

export { WorkspaceList };
