/**
 * Workspace list UI component.
 *
 * Displays a reactive list of workspaces for a given project from LiveStore.
 * Each workspace shows its branch name, port, and status with color-coded
 * badges: creating=yellow, running=green, stopped=gray, errored=red,
 * destroyed=dim.
 * Workspaces with "creating" status show a spinner and progress description
 * to indicate that worktree creation, port allocation, and setup scripts
 * are in progress.
 * Updates reactively when workspace state changes.
 * Includes a destroy button with confirmation dialog per workspace.
 * Includes rlph action buttons (Start Ralph Loop, Write PRD, Review PR,
 * Fix Findings) on every non-destroyed workspace for triggering agent
 * workflows.
 *
 * When no workspaces exist (all destroyed or none created), shows an empty
 * state with guidance text and a CTA button to create the first workspace.
 *
 * Accepts an optional `activeProjectId` prop to filter workspaces by project.
 * When set, only workspaces belonging to the selected project are shown.
 *
 * @see Issue #41: Workspace list UI component
 * @see Issue #48: Destroy Workspace button + confirmation dialog
 * @see Issue #93: "Start Ralph Loop" button UI
 * @see Issue #95: PRD writing form + writePRD button
 * @see Issue #97: "Review PR" button + PR number input
 * @see Issue #99: "Fix Findings" button + PR number input
 * @see Issue #119: Empty state — no workspaces
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #113: Project switcher — filter workspaces by active project
 * @see Issue #160: UI for detected workspaces
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects, workspaces } from "@laborer/shared/schema";
import type { WorkspaceOrigin } from "@laborer/shared/types";
import { queryDb } from "@livestore/livestore";
import { ChevronDown, GitBranch, Layers, Play, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { FixFindingsForm } from "@/components/fix-findings-form";
import { ReviewPrForm } from "@/components/review-pr-form";
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
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { WritePrdForm } from "@/components/write-prd-form";
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

/**
 * Returns a small colored status indicator for the workspace.
 * Uses a spinning loader for "creating" status to emphasize the
 * in-progress operation, and a colored dot for all other statuses.
 */
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

interface WorkspaceItemProps {
	readonly projectName: string;
	readonly workspace: {
		readonly id: string;
		readonly projectId: string;
		readonly branchName: string;
		readonly worktreePath: string;
		readonly port: number;
		readonly status: string;
		readonly origin: WorkspaceOrigin | string;
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
	const isDetectedWorkspace =
		(workspace.origin as WorkspaceOrigin) === "external";

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
				<CardHeader className="gap-2">
					<div className="flex items-start justify-between gap-2">
						<div className="flex min-w-0 items-start gap-2">
							<GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<CardTitle className="min-w-0">
								<span className="line-clamp-2 break-all font-mono text-sm">
									{workspace.branchName}
								</span>
							</CardTitle>
							{isDetectedWorkspace && (
								<span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground uppercase">
									Detected
								</span>
							)}
						</div>
						<Badge
							className={cn(
								"shrink-0 border",
								getStatusClasses(workspace.status)
							)}
							title={
								isDetectedWorkspace && workspace.status === "stopped"
									? "Detected from existing git worktree — never activated in Laborer"
									: undefined
							}
							variant="outline"
						>
							<StatusDot status={workspace.status} />
							{workspace.status}
						</Badge>
					</div>
					<CardDescription>{projectName}</CardDescription>
					<div className="flex flex-wrap items-center gap-1">
						<WritePrdForm
							onTerminalSpawned={() => setIsOpen(true)}
							workspaceId={workspace.id}
						/>
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
										: "text-success"
								)}
							/>
						</Button>
						<ReviewPrForm
							onTerminalSpawned={() => setIsOpen(true)}
							workspaceId={workspace.id}
						/>
						<FixFindingsForm
							onTerminalSpawned={() => setIsOpen(true)}
							workspaceId={workspace.id}
						/>
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
										{isDetectedWorkspace ? (
											<>
												This will remove workspace{" "}
												<strong className="font-mono text-foreground">
													{workspace.branchName}
												</strong>{" "}
												from Laborer. Running processes in this workspace will
												be stopped and any allocated port will be freed, but the
												git worktree on disk at{" "}
												<strong className="font-mono text-foreground">
													{workspace.worktreePath}
												</strong>{" "}
												will not be changed.
											</>
										) : (
											<>
												This will permanently destroy workspace{" "}
												<strong className="font-mono text-foreground">
													{workspace.branchName}
												</strong>
												. All running processes (terminals, dev servers, agents)
												will be killed, the git worktree will be removed, and
												the allocated port will be freed. This action cannot be
												undone.
											</>
										)}
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
				</CardHeader>
				<CardContent>
					<div className="flex items-start gap-3 text-muted-foreground text-xs">
						{workspace.port > 0 && (
							<span>
								Port: <span className="font-mono">{workspace.port}</span>
							</span>
						)}
						<span className="line-clamp-2 break-all font-mono">
							{workspace.worktreePath}
						</span>
					</div>
					{workspace.status === "creating" && (
						<div className="mt-2 flex items-center gap-2 text-warning text-xs">
							<Spinner className="size-3 text-warning" />
							Setting up workspace...
						</div>
					)}
					<CollapsibleContent>
						<div className="mt-2 border-t pt-2">
							<TerminalList workspaceId={workspace.id} />
						</div>
					</CollapsibleContent>
				</CardContent>
			</Collapsible>
		</Card>
	);
}

interface WorkspaceListProps {
	/** When set, only workspaces belonging to this project are shown. */
	readonly activeProjectId?: string | null;
}

function WorkspaceList({ activeProjectId }: WorkspaceListProps) {
	const store = useLaborerStore();
	const workspaceList = store.useQuery(allWorkspaces$);
	const projectList = store.useQuery(allProjects$);

	// Build a map of project IDs to names for display
	const projectNameMap = new Map(
		projectList.map((p) => [p.id, p.name] as const)
	);

	// Filter out destroyed workspaces, and optionally filter by active project
	const activeWorkspaces = workspaceList.filter(
		(ws) =>
			ws.status !== "destroyed" &&
			(!activeProjectId || ws.projectId === activeProjectId)
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
				<EmptyContent>
					<CreateWorkspaceForm />
				</EmptyContent>
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
