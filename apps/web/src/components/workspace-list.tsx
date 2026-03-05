/**
 * Workspace list UI component.
 *
 * Displays a reactive list of workspaces for a given project from LiveStore.
 * Each workspace shows its branch name, port, and status with color-coded
 * badges: creating=yellow, running=green, stopped=gray, errored=red,
 * destroyed=dim.
 * Updates reactively when workspace state changes.
 * Includes a destroy button with confirmation dialog per workspace.
 * Includes rlph action buttons (Start Ralph Loop, Write PRD, Review PR,
 * Fix Findings) per active workspace for triggering agent workflows.
 *
 * @see Issue #41: Workspace list UI component
 * @see Issue #48: Destroy Workspace button + confirmation dialog
 * @see Issue #93: "Start Ralph Loop" button UI
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects, workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { ChevronDown, GitBranch, Layers, Play, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { TerminalList } from "@/components/terminal-list";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn, extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";
import { usePanelActions } from "@/panels/panel-context";

const allWorkspaces$ = queryDb(workspaces, { label: "workspaceList" });
const allProjects$ = queryDb(projects, { label: "workspaceListProjects" });

const destroyWorkspaceMutation = LaborerClient.mutation("workspace.destroy");
const startLoopMutation = LaborerClient.mutation("rlph.startLoop");

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
	const [isOpen, setIsOpen] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [isDestroying, setIsDestroying] = useState(false);
	const [isStartingLoop, setIsStartingLoop] = useState(false);
	const destroyWorkspace = useAtomSet(destroyWorkspaceMutation, {
		mode: "promise",
	});
	const startLoop = useAtomSet(startLoopMutation, {
		mode: "promise",
	});
	const panelActions = usePanelActions();
	const isActive =
		workspace.status === "running" || workspace.status === "creating";

	const handleDestroy = async () => {
		setIsDestroying(true);
		try {
			await destroyWorkspace({
				payload: { workspaceId: workspace.id },
			});
			toast.success(
				`Workspace "${workspace.branchName}" destroyed successfully`
			);
			setDialogOpen(false);
		} catch (error: unknown) {
			const message = extractErrorMessage(error);
			toast.error(message);
			setIsDestroying(false);
		}
	};

	const handleStartLoop = useCallback(async () => {
		setIsStartingLoop(true);
		try {
			const result = await startLoop({
				payload: { workspaceId: workspace.id },
			});
			toast.success("Ralph loop started");
			// Auto-assign the spawned terminal to a pane
			if (panelActions) {
				panelActions.assignTerminalToPane(result.id, workspace.id);
			}
			// Auto-expand the collapsible to show the new terminal
			setIsOpen(true);
		} catch (error: unknown) {
			toast.error(`Failed to start ralph loop: ${extractErrorMessage(error)}`);
		} finally {
			setIsStartingLoop(false);
		}
	}, [startLoop, workspace.id, panelActions]);

	return (
		<Card size="sm">
			<Collapsible onOpenChange={setIsOpen} open={isOpen}>
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
						<div className="flex items-center gap-1">
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
							{isActive && (
								<Button
									aria-label="Start ralph loop"
									disabled={isStartingLoop}
									onClick={handleStartLoop}
									size="icon-xs"
									title="Start Ralph Loop (rlph --once)"
									variant="ghost"
								>
									<Play
										className={cn(
											"size-3.5",
											isStartingLoop
												? "animate-pulse text-muted-foreground"
												: "text-green-600 dark:text-green-400"
										)}
									/>
								</Button>
							)}
							{isActive && (
								<CollapsibleTrigger
									render={
										<Button
											aria-label={isOpen ? "Hide terminals" : "Show terminals"}
											size="icon-xs"
											variant="ghost"
										/>
									}
								>
									<ChevronDown
										className={cn(
											"size-3.5 transition-transform",
											isOpen && "rotate-180"
										)}
									/>
								</CollapsibleTrigger>
							)}
							<AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
								<AlertDialogTrigger
									render={
										<Button
											aria-label={`Destroy workspace ${workspace.branchName}`}
											size="icon-xs"
											variant="ghost"
										/>
									}
								>
									<Trash2 className="size-3.5 text-muted-foreground" />
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Destroy workspace?</AlertDialogTitle>
										<AlertDialogDescription>
											This will permanently destroy workspace{" "}
											<strong className="font-mono text-foreground">
												{workspace.branchName}
											</strong>
											. All running processes (terminals, dev servers, agents)
											will be killed, the git worktree will be removed, and the
											allocated port will be freed. This action cannot be
											undone.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											disabled={isDestroying}
											onClick={handleDestroy}
											variant="destructive"
										>
											{isDestroying ? "Destroying..." : "Destroy"}
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-3 text-muted-foreground text-xs">
						<span>
							Port: <span className="font-mono">{workspace.port}</span>
						</span>
						<span className="truncate font-mono">{workspace.worktreePath}</span>
					</div>
					{isActive && (
						<CollapsibleContent>
							<div className="mt-2 border-t pt-2">
								<TerminalList workspaceId={workspace.id} />
							</div>
						</CollapsibleContent>
					)}
				</CardContent>
			</Collapsible>
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
