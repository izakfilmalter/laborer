/**
 * Cross-project workspace dashboard component.
 *
 * Provides a high-level overview of all workspaces across all projects
 * with their status, and task status summaries per project. Gives the
 * developer a command-center view of what's happening across their
 * entire development environment.
 *
 * Per-project sections show:
 * - Project name and repo path
 * - Task summary counts (pending, in progress, completed, cancelled)
 * - All workspaces for that project with status badges, branch names,
 *   ports, and terminal counts
 *
 * Workspace and task data comes from LiveStore queries. Terminal counts
 * come from the terminal service via the `useTerminalList` polling hook.
 *
 * @see Issue #114: Cross-project workspace dashboard
 * @see Issue #144: Web app LiveStore terminal query replacement
 * @see Issue #160: UI for detected workspaces
 */

import { projects, tasks, workspaces } from "@laborer/shared/schema";
import type { WorkspaceOrigin } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import {
	CheckCircle2,
	CircleDot,
	FolderGit2,
	GitBranch,
	LayoutDashboard,
	Loader2,
	XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useTerminalList } from "@/hooks/use-terminal-list";
import { cn } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

/** LiveStore queries for dashboard data. */
const dashboardProjects$ = queryDb(projects, { label: "dashboardProjects" });
const dashboardWorkspaces$ = queryDb(workspaces, {
	label: "dashboardWorkspaces",
});
const dashboardTasks$ = queryDb(tasks, { label: "dashboardTasks" });

type WorkspaceStatus =
	| "creating"
	| "running"
	| "stopped"
	| "errored"
	| "destroyed";

/** Returns Tailwind classes for a workspace status badge. */
function getStatusClasses(status: string): string {
	switch (status as WorkspaceStatus) {
		case "creating":
			return "border-warning/30 bg-warning/10 text-warning";
		case "running":
			return "border-success/30 bg-success/10 text-success";
		case "stopped":
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
		case "errored":
			return "border-destructive/30 bg-destructive/10 text-destructive";
		case "destroyed":
			return "border-muted-foreground/20 bg-muted/50 text-muted-foreground/60";
		default:
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
	}
}

/** Small colored status indicator dot / spinner. */
function StatusDot({ status }: { readonly status: string }) {
	if (status === "creating") {
		return <Spinner className="size-3 text-warning" />;
	}

	const dotColor = (() => {
		switch (status as WorkspaceStatus) {
			case "running":
				return "bg-success";
			case "stopped":
				return "bg-muted-foreground/50";
			case "errored":
				return "bg-destructive";
			case "destroyed":
				return "bg-muted-foreground/30";
			default:
				return "bg-muted-foreground/50";
		}
	})();

	return <span className={cn("inline-block size-2 rounded-full", dotColor)} />;
}

/** Task status counts for a single project. */
interface TaskCounts {
	readonly cancelled: number;
	readonly completed: number;
	readonly in_progress: number;
	readonly pending: number;
	readonly total: number;
}

/** Aggregate task counts from a filtered task list. */
function computeTaskCounts(
	taskList: ReadonlyArray<{ readonly status: string }>
): TaskCounts {
	let pending = 0;
	let in_progress = 0;
	let completed = 0;
	let cancelled = 0;
	for (const task of taskList) {
		switch (task.status) {
			case "pending":
				pending++;
				break;
			case "in_progress":
				in_progress++;
				break;
			case "completed":
				completed++;
				break;
			case "cancelled":
				cancelled++;
				break;
			default:
				break;
		}
	}
	return {
		pending,
		in_progress,
		completed,
		cancelled,
		total: taskList.length,
	};
}

/** Compact task summary with icons and counts. */
function TaskSummary({ counts }: { readonly counts: TaskCounts }) {
	if (counts.total === 0) {
		return <span className="text-muted-foreground text-xs">No tasks</span>;
	}

	return (
		<div className="flex flex-wrap gap-3 text-xs">
			{counts.pending > 0 && (
				<span className="flex items-center gap-1 text-info">
					<CircleDot className="size-3" />
					{counts.pending} pending
				</span>
			)}
			{counts.in_progress > 0 && (
				<span className="flex items-center gap-1 text-warning">
					<Loader2 className="size-3" />
					{counts.in_progress} in progress
				</span>
			)}
			{counts.completed > 0 && (
				<span className="flex items-center gap-1 text-success">
					<CheckCircle2 className="size-3" />
					{counts.completed} completed
				</span>
			)}
			{counts.cancelled > 0 && (
				<span className="flex items-center gap-1 text-muted-foreground">
					<XCircle className="size-3" />
					{counts.cancelled} cancelled
				</span>
			)}
		</div>
	);
}

/** Per-project workspace status summary counts. */
interface WorkspaceCounts {
	readonly creating: number;
	readonly errored: number;
	readonly running: number;
	readonly stopped: number;
	readonly total: number;
}

/** Aggregate workspace counts from a filtered workspace list. */
function computeWorkspaceCounts(
	wsList: ReadonlyArray<{ readonly status: string }>
): WorkspaceCounts {
	let running = 0;
	let creating = 0;
	let stopped = 0;
	let errored = 0;
	for (const ws of wsList) {
		switch (ws.status as WorkspaceStatus) {
			case "running":
				running++;
				break;
			case "creating":
				creating++;
				break;
			case "stopped":
				stopped++;
				break;
			case "errored":
				errored++;
				break;
			default:
				break;
		}
	}
	return { running, creating, stopped, errored, total: wsList.length };
}

/** Compact workspace status summary. */
function WorkspaceStatusSummary({
	counts,
}: {
	readonly counts: WorkspaceCounts;
}) {
	if (counts.total === 0) {
		return <span className="text-muted-foreground text-xs">No workspaces</span>;
	}

	return (
		<div className="flex flex-wrap gap-3 text-xs">
			{counts.running > 0 && (
				<span className="flex items-center gap-1 text-success">
					<span className="inline-block size-2 rounded-full bg-success" />
					{counts.running} running
				</span>
			)}
			{counts.creating > 0 && (
				<span className="flex items-center gap-1 text-warning">
					<Spinner className="size-3" />
					{counts.creating} creating
				</span>
			)}
			{counts.errored > 0 && (
				<span className="flex items-center gap-1 text-destructive">
					<span className="inline-block size-2 rounded-full bg-destructive" />
					{counts.errored} errored
				</span>
			)}
			{counts.stopped > 0 && (
				<span className="flex items-center gap-1 text-muted-foreground">
					<span className="inline-block size-2 rounded-full bg-muted-foreground/50" />
					{counts.stopped} stopped
				</span>
			)}
		</div>
	);
}

/** Structured data for a single project's dashboard section. */
interface ProjectSection {
	readonly project: {
		readonly id: string;
		readonly name: string;
		readonly repoPath: string;
	};
	readonly taskCounts: TaskCounts;
	readonly terminalCountByWorkspace: ReadonlyMap<string, number>;
	readonly workspaceCounts: WorkspaceCounts;
	readonly workspaces: ReadonlyArray<{
		readonly id: string;
		readonly projectId: string;
		readonly branchName: string;
		readonly worktreePath: string;
		readonly port: number;
		readonly status: string;
		readonly origin: WorkspaceOrigin | string;
		readonly createdAt: string;
	}>;
}

/**
 * Cross-project workspace dashboard.
 *
 * Shows all workspaces across all projects with status badges and
 * per-project task summaries. Provides a high-level command-center
 * overview for developers running multiple agents simultaneously.
 */
function WorkspaceDashboard() {
	const store = useLaborerStore();
	const projectList = store.useQuery(dashboardProjects$);
	const workspaceList = store.useQuery(dashboardWorkspaces$);
	const taskList = store.useQuery(dashboardTasks$);
	const { terminals: terminalList } = useTerminalList();

	// Build per-project dashboard sections
	const sections: readonly ProjectSection[] = useMemo(() => {
		return projectList.map((project) => {
			const projectWorkspaces = workspaceList.filter(
				(ws) => ws.projectId === project.id && ws.status !== "destroyed"
			);
			const projectTasks = taskList.filter((t) => t.projectId === project.id);
			const taskCounts = computeTaskCounts(projectTasks);
			const workspaceCounts = computeWorkspaceCounts(projectWorkspaces);

			// Count terminals per workspace
			const terminalCountByWorkspace = new Map<string, number>();
			for (const ws of projectWorkspaces) {
				const count = terminalList.filter(
					(t) => t.workspaceId === ws.id && t.status === "running"
				).length;
				terminalCountByWorkspace.set(ws.id, count);
			}

			return {
				project,
				workspaces: projectWorkspaces,
				taskCounts,
				workspaceCounts,
				terminalCountByWorkspace,
			};
		});
	}, [projectList, workspaceList, taskList, terminalList]);

	// Global summary counts
	const globalSummary = useMemo(() => {
		const activeWorkspaces = workspaceList.filter(
			(ws) => ws.status !== "destroyed"
		);
		return {
			totalProjects: projectList.length,
			workspaceCounts: computeWorkspaceCounts(activeWorkspaces),
			taskCounts: computeTaskCounts(taskList),
		};
	}, [projectList, workspaceList, taskList]);

	if (projectList.length === 0) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<LayoutDashboard />
					</EmptyMedia>
					<EmptyTitle>No projects</EmptyTitle>
					<EmptyDescription>
						Add a project to see the workspace dashboard.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-4">
				{/* Global summary bar */}
				<div className="mb-4 rounded-lg border p-4">
					<div className="mb-3 flex items-center gap-2">
						<LayoutDashboard className="size-4 text-muted-foreground" />
						<h2 className="font-semibold text-sm">Overview</h2>
						<Badge className="ml-auto" variant="secondary">
							{globalSummary.totalProjects} project
							{globalSummary.totalProjects !== 1 ? "s" : ""}
						</Badge>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div>
							<p className="mb-1 text-muted-foreground text-xs">Workspaces</p>
							<WorkspaceStatusSummary counts={globalSummary.workspaceCounts} />
						</div>
						<div>
							<p className="mb-1 text-muted-foreground text-xs">Tasks</p>
							<TaskSummary counts={globalSummary.taskCounts} />
						</div>
					</div>
				</div>

				{/* Per-project sections */}
				<div className="grid gap-4">
					{sections.map((section) => (
						<ProjectDashboardSection
							key={section.project.id}
							section={section}
						/>
					))}
				</div>
			</div>
		</ScrollArea>
	);
}

/** Dashboard section for a single project. */
function ProjectDashboardSection({
	section,
}: {
	readonly section: ProjectSection;
}) {
	const {
		project,
		workspaces: projectWorkspaces,
		taskCounts,
		workspaceCounts,
		terminalCountByWorkspace,
	} = section;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2">
							<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate">{project.name}</span>
						</CardTitle>
						<p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
							{project.repoPath}
						</p>
					</div>
					<div className="flex shrink-0 gap-2">
						<Badge variant="outline">
							{workspaceCounts.total} workspace
							{workspaceCounts.total !== 1 ? "s" : ""}
						</Badge>
						<Badge variant="outline">
							{taskCounts.total} task
							{taskCounts.total !== 1 ? "s" : ""}
						</Badge>
					</div>
				</div>
			</CardHeader>

			<CardContent>
				{/* Task summary */}
				<div className="mb-3">
					<p className="mb-1 font-medium text-muted-foreground text-xs">
						Tasks
					</p>
					<TaskSummary counts={taskCounts} />
				</div>

				<Separator className="my-3" />

				{/* Workspace list */}
				<div>
					<p className="mb-2 font-medium text-muted-foreground text-xs">
						Workspaces
					</p>
					{projectWorkspaces.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							No active workspaces
						</p>
					) : (
						<div className="grid gap-2">
							{projectWorkspaces.map((ws) => (
								<DashboardWorkspaceRow
									key={ws.id}
									terminalCount={terminalCountByWorkspace.get(ws.id) ?? 0}
									workspace={ws}
								/>
							))}
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/** Compact workspace row in the dashboard. */
function DashboardWorkspaceRow({
	workspace,
	terminalCount,
}: {
	readonly workspace: {
		readonly id: string;
		readonly branchName: string;
		readonly port: number;
		readonly status: string;
		readonly origin: WorkspaceOrigin | string;
	};
	readonly terminalCount: number;
}) {
	const isDetectedWorkspace =
		(workspace.origin as WorkspaceOrigin) === "external";

	return (
		<div className="flex items-center gap-2 rounded-md border px-3 py-2">
			<GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 truncate font-mono text-xs">
				{workspace.branchName}
			</span>
			{isDetectedWorkspace && (
				<span className="font-mono text-[10px] text-muted-foreground uppercase">
					Detected
				</span>
			)}
			{workspace.port > 0 && (
				<span className="text-muted-foreground text-xs">:{workspace.port}</span>
			)}
			{terminalCount > 0 && (
				<span className="text-muted-foreground text-xs">
					{terminalCount} terminal{terminalCount !== 1 ? "s" : ""}
				</span>
			)}
			<Badge
				className={cn(
					"ml-auto shrink-0 border",
					getStatusClasses(workspace.status)
				)}
				variant="outline"
			>
				<StatusDot status={workspace.status} />
				{workspace.status}
			</Badge>
		</div>
	);
}

export { WorkspaceDashboard };
