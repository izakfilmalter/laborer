/**
 * Project list UI component.
 *
 * Displays a reactive list of registered projects from LiveStore.
 * Each project shows its name, repo path, and workspace count.
 * Updates reactively when projects are added or removed.
 *
 * @see Issue #26: Project list UI component
 */

import { projects, workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { FolderGit2 } from "lucide-react";
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
import { useLaborerStore } from "@/livestore/store";

const allProjects$ = queryDb(projects, { label: "projectList" });
const allWorkspaces$ = queryDb(workspaces, { label: "projectListWorkspaces" });

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
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<FolderGit2 className="size-4 text-muted-foreground" />
					{project.name}
				</CardTitle>
				<CardDescription className="font-mono">
					{project.repoPath}
				</CardDescription>
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
