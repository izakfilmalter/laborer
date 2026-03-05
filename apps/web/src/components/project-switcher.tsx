/**
 * Project switcher component.
 *
 * A compact Select dropdown that lets the user filter the sidebar's
 * workspace and task lists by the active project context. Selecting
 * "All Projects" shows everything; selecting a specific project filters
 * workspaces and tasks to that project only.
 *
 * Placed at the top of the sidebar, above the Projects section.
 *
 * @see Issue #113: Project switcher component
 */

import { projects } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { FolderGit2 } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useLaborerStore } from "@/livestore/store";

const allProjects$ = queryDb(projects, { label: "projectSwitcherProjects" });

/** Sentinel value representing "All Projects" (no filter). */
const ALL_PROJECTS = "__all__";

interface ProjectSwitcherProps {
	/** The currently selected project ID, or null for "All Projects". */
	readonly activeProjectId: string | null;
	/** Called when the user selects a project (or "All Projects"). */
	readonly onProjectChange: (projectId: string | null) => void;
}

function ProjectSwitcher({
	activeProjectId,
	onProjectChange,
}: ProjectSwitcherProps) {
	const store = useLaborerStore();
	const projectList = store.useQuery(allProjects$);

	const handleChange = (value: string | null) => {
		if (!value || value === ALL_PROJECTS) {
			onProjectChange(null);
		} else {
			onProjectChange(value);
		}
	};

	return (
		<Select
			onValueChange={handleChange}
			value={activeProjectId ?? ALL_PROJECTS}
		>
			<SelectTrigger className="w-full" size="sm">
				<FolderGit2 className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
				<SelectValue placeholder="All Projects" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL_PROJECTS}>All Projects</SelectItem>
				{projectList.length > 0 && <SelectSeparator />}
				{projectList.map((project) => (
					<SelectItem key={project.id} value={project.id}>
						{project.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export { ProjectSwitcher, ALL_PROJECTS };
