/**
 * Project list UI component.
 *
 * Displays a reactive list of registered projects from LiveStore.
 * Each project shows its name, repo path, workspace count, and a
 * delete button with a confirmation dialog.
 * Updates reactively when projects are added or removed.
 *
 * When no projects are registered, shows an empty state with a CTA button
 * to add the first project (via Tauri's native folder picker).
 *
 * @see Issue #26: Project list UI component
 * @see Issue #28: Remove Project button + confirmation dialog
 * @see Issue #118: Empty state — no projects
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects, workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { FolderGit2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { AddProjectForm } from "@/components/add-project-form";
import { ProjectSettingsModal } from "@/components/project-settings-modal";
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
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

const allProjects$ = queryDb(projects, { label: "projectList" });
const allWorkspaces$ = queryDb(workspaces, { label: "projectListWorkspaces" });

const removeProjectMutation = LaborerClient.mutation("project.remove");

interface ProjectItemProps {
	readonly project: {
		readonly id: string;
		readonly name: string;
		readonly repoPath: string;
		readonly rlphConfig: string | null;
	};
	readonly workspaceCount: number;
}

function ProjectItem({ project, workspaceCount }: ProjectItemProps) {
	const [open, setOpen] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const removeProject = useAtomSet(removeProjectMutation, {
		mode: "promise",
	});

	const handleRemove = async () => {
		setIsRemoving(true);
		try {
			await removeProject({
				payload: { projectId: project.id },
			});
			toast.success(`Project "${project.name}" removed`);
			setOpen(false);
		} catch (error: unknown) {
			const message = extractErrorMessage(error);
			toast.error(message);
			setIsRemoving(false);
		}
	};

	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2">
							<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
							{project.name}
						</CardTitle>
						<CardDescription className="font-mono">
							{project.repoPath}
						</CardDescription>
					</div>
					<div className="flex items-center gap-1">
						<ProjectSettingsModal
							projectId={project.id}
							projectName={project.name}
						/>
						<AlertDialog onOpenChange={setOpen} open={open}>
							<AlertDialogTrigger
								render={
									<Button
										aria-label={`Remove project ${project.name}`}
										size="icon-sm"
										variant="ghost"
									/>
								}
							>
								<Trash2 className="size-3.5 text-muted-foreground" />
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Remove project?</AlertDialogTitle>
									<AlertDialogDescription>
										This will unregister{" "}
										<strong className="text-foreground">{project.name}</strong>{" "}
										from Laborer. Existing workspaces and worktrees will not be
										deleted from disk.
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
					<Badge variant="secondary">
						{workspaceCount} workspace{workspaceCount !== 1 ? "s" : ""}
					</Badge>
				</div>
			</CardContent>
		</Card>
	);
}

function ProjectList() {
	const store = useLaborerStore();
	const projectList = store.useQuery(allProjects$);
	const workspaceList = store.useQuery(allWorkspaces$);

	if (projectList.length === 0) {
		return (
			<Empty className="border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<FolderGit2 />
					</EmptyMedia>
					<EmptyTitle>No projects</EmptyTitle>
					<EmptyDescription>
						Add a project to get started. A project is a git repository where
						laborer will create isolated workspaces for your agents.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<AddProjectForm />
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="grid gap-2">
			{projectList.map((project) => {
				const workspaceCount = workspaceList.filter(
					(ws) => ws.projectId === project.id
				).length;
				return (
					<ProjectItem
						key={project.id}
						project={project}
						workspaceCount={workspaceCount}
					/>
				);
			})}
		</div>
	);
}

export { ProjectList };
