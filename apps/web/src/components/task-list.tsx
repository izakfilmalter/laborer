/**
 * Task list UI component.
 *
 * Displays a reactive list of tasks for a given project from LiveStore.
 * Each task shows its title, source (manual/linear/github/prd), and
 * status with color-coded badges: pending=yellow, in_progress=blue,
 * completed=green, cancelled=gray.
 * Updates reactively when task state changes.
 *
 * Includes:
 * - Status filter tabs (All, Pending, In Progress, Completed, Cancelled)
 * - Status update via inline dropdown (updateStatus RPC)
 * - Remove button with confirmation dialog (remove RPC)
 *
 * Accepts an optional `activeProjectId` prop to filter tasks by project.
 * When set, only tasks belonging to the selected project are shown.
 *
 * @see Issue #104: Task list UI component
 * @see Issue #113: Project switcher — filter tasks by active project
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects, tasks } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import {
	CheckCircle2,
	Circle,
	CircleDot,
	ClipboardList,
	Loader2,
	Trash2,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
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
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

const allTasks$ = queryDb(tasks, { label: "taskList" });
const allProjects$ = queryDb(projects, { label: "taskListProjects" });

const updateTaskStatusMutation = LaborerClient.mutation("task.updateStatus");
const removeTaskMutation = LaborerClient.mutation("task.remove");

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TaskSource = "manual" | "linear" | "github" | "prd";

const STATUS_OPTIONS: readonly {
	readonly value: TaskStatus;
	readonly label: string;
}[] = [
	{ value: "pending", label: "Pending" },
	{ value: "in_progress", label: "In Progress" },
	{ value: "completed", label: "Completed" },
	{ value: "cancelled", label: "Cancelled" },
];

/**
 * Returns Tailwind classes for a task status badge.
 */
function getStatusClasses(status: string): string {
	switch (status as TaskStatus) {
		case "pending":
			return "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
		case "in_progress":
			return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400";
		case "completed":
			return "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400";
		case "cancelled":
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
		default:
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
	}
}

/**
 * Returns a status icon component for the given task status.
 */
function StatusIcon({ status }: { readonly status: string }) {
	switch (status as TaskStatus) {
		case "pending":
			return <Circle className="size-3.5 text-yellow-500" />;
		case "in_progress":
			return <Loader2 className="size-3.5 animate-spin text-blue-500" />;
		case "completed":
			return <CheckCircle2 className="size-3.5 text-green-500" />;
		case "cancelled":
			return <XCircle className="size-3.5 text-muted-foreground" />;
		default:
			return <Circle className="size-3.5 text-muted-foreground" />;
	}
}

/**
 * Returns Tailwind classes for a task source badge.
 */
function getSourceClasses(source: string): string {
	switch (source as TaskSource) {
		case "manual":
			return "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400";
		case "linear":
			return "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400";
		case "github":
			return "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400";
		case "prd":
			return "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400";
		default:
			return "border-muted-foreground/30 bg-muted text-muted-foreground";
	}
}

/**
 * Format a status string for display (e.g. "in_progress" → "in progress").
 */
function formatStatus(status: string): string {
	return status.replace(/_/g, " ");
}

interface TaskItemProps {
	readonly projectName: string;
	readonly task: {
		readonly id: string;
		readonly projectId: string;
		readonly source: string;
		readonly externalId: string | null;
		readonly title: string;
		readonly status: string;
	};
}

function TaskItem({ task, projectName }: TaskItemProps) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const [isUpdating, setIsUpdating] = useState(false);

	const updateTaskStatus = useAtomSet(updateTaskStatusMutation, {
		mode: "promise",
	});
	const removeTask = useAtomSet(removeTaskMutation, {
		mode: "promise",
	});

	const handleStatusChange = async (newStatus: string | null) => {
		if (!newStatus || newStatus === task.status) {
			return;
		}
		setIsUpdating(true);
		try {
			await updateTaskStatus({
				payload: { taskId: task.id, status: newStatus },
			});
			toast.success(`Task status updated to "${formatStatus(newStatus)}"`);
		} catch (error: unknown) {
			toast.error(`Failed to update task: ${extractErrorMessage(error)}`);
		} finally {
			setIsUpdating(false);
		}
	};

	const handleRemove = async () => {
		setIsRemoving(true);
		try {
			await removeTask({
				payload: { taskId: task.id },
			});
			toast.success(`Task "${task.title}" removed`);
			setDialogOpen(false);
		} catch (error: unknown) {
			toast.error(extractErrorMessage(error));
			setIsRemoving(false);
		}
	};

	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0 flex-1">
						<CardTitle className="flex items-center gap-2">
							<StatusIcon status={task.status} />
							<span className="truncate text-sm">{task.title}</span>
						</CardTitle>
						<CardDescription className="mt-0.5">{projectName}</CardDescription>
					</div>
					<div className="flex items-center gap-1">
						<Badge
							className={cn(
								"shrink-0 border text-[10px]",
								getSourceClasses(task.source)
							)}
							variant="outline"
						>
							{task.source}
						</Badge>
						<AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
							<AlertDialogTrigger
								render={
									<Button
										aria-label={`Remove task ${task.title}`}
										size="icon-xs"
										variant="ghost"
									/>
								}
							>
								<Trash2 className="size-3.5 text-muted-foreground" />
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Remove task?</AlertDialogTitle>
									<AlertDialogDescription>
										This will permanently remove the task{" "}
										<strong className="text-foreground">{task.title}</strong>.
										This action cannot be undone.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										disabled={isRemoving}
										onClick={handleRemove}
										variant="destructive"
									>
										{isRemoving ? "Removing..." : "Remove"}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-2">
					<Select
						disabled={isUpdating}
						onValueChange={handleStatusChange}
						value={task.status}
					>
						<SelectTrigger
							className={cn(
								"h-7 w-auto gap-1.5 border px-2 text-xs",
								getStatusClasses(task.status)
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{STATUS_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									<div className="flex items-center gap-1.5">
										<StatusIcon status={option.value} />
										{option.label}
									</div>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{task.externalId && (
						<span className="truncate font-mono text-muted-foreground text-xs">
							{task.externalId}
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

type FilterTab = "all" | TaskStatus;

interface TaskListProps {
	/** When set, only tasks belonging to this project are shown. */
	readonly activeProjectId?: string | null;
}

function TaskList({ activeProjectId }: TaskListProps) {
	const store = useLaborerStore();
	const allTaskList = store.useQuery(allTasks$);
	const projectList = store.useQuery(allProjects$);
	const [activeFilter, setActiveFilter] = useState<FilterTab>("all");

	// Build a map of project IDs to names for display
	const projectNameMap = useMemo(
		() => new Map(projectList.map((p) => [p.id, p.name] as const)),
		[projectList]
	);

	// Filter tasks by project if an active project is set
	const taskList = useMemo(() => {
		if (!activeProjectId) {
			return allTaskList;
		}
		return allTaskList.filter((t) => t.projectId === activeProjectId);
	}, [allTaskList, activeProjectId]);

	// Filter tasks by status if a filter is active
	const filteredTasks = useMemo(() => {
		if (activeFilter === "all") {
			return taskList;
		}
		return taskList.filter((t) => t.status === activeFilter);
	}, [taskList, activeFilter]);

	// Count tasks per status for the filter badges
	const statusCounts = useMemo(() => {
		const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
		for (const task of taskList) {
			const status = task.status as TaskStatus;
			if (status in counts) {
				counts[status]++;
			}
		}
		return counts;
	}, [taskList]);

	if (taskList.length === 0) {
		return (
			<Empty className="border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<ClipboardList />
					</EmptyMedia>
					<EmptyTitle>No tasks</EmptyTitle>
					<EmptyDescription>
						Create a task to track work across your workspaces. Tasks can be
						created manually or sourced from Linear, GitHub, or PRDs.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="grid gap-2">
			<Tabs
				onValueChange={(value) => setActiveFilter(value as FilterTab)}
				value={activeFilter}
			>
				<TabsList className="w-full">
					<TabsTrigger className="flex-1 text-xs" value="all">
						All
						<Badge className="ml-1" variant="secondary">
							{taskList.length}
						</Badge>
					</TabsTrigger>
					<TabsTrigger className="flex-1 text-xs" value="pending">
						<CircleDot className="mr-0.5 size-3" />
						{statusCounts.pending}
					</TabsTrigger>
					<TabsTrigger className="flex-1 text-xs" value="in_progress">
						<Loader2 className="mr-0.5 size-3" />
						{statusCounts.in_progress}
					</TabsTrigger>
					<TabsTrigger className="flex-1 text-xs" value="completed">
						<CheckCircle2 className="mr-0.5 size-3" />
						{statusCounts.completed}
					</TabsTrigger>
					<TabsTrigger className="flex-1 text-xs" value="cancelled">
						<XCircle className="mr-0.5 size-3" />
						{statusCounts.cancelled}
					</TabsTrigger>
				</TabsList>
			</Tabs>
			{filteredTasks.length === 0 ? (
				<p className="py-4 text-center text-muted-foreground text-sm">
					No {activeFilter === "all" ? "" : formatStatus(activeFilter)} tasks
				</p>
			) : (
				filteredTasks.map((task) => (
					<TaskItem
						key={task.id}
						projectName={projectNameMap.get(task.projectId) ?? "Unknown"}
						task={task}
					/>
				))
			)}
		</div>
	);
}

export { TaskList };
