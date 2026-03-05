export type TaskSourceFilter = "manual" | "linear" | "github";

interface FilterableTask {
	readonly projectId: string;
	readonly source: string;
}

function isImportSource(
	source: TaskSourceFilter
): source is Exclude<TaskSourceFilter, "manual"> {
	return source !== "manual";
}

function canImportTasks(
	source: TaskSourceFilter,
	activeProjectId?: string | null
): boolean {
	return isImportSource(source) && !!activeProjectId;
}

function filterTasksByProjectAndSource<T extends FilterableTask>(
	tasks: readonly T[],
	activeProjectId?: string | null,
	sourceFilter?: TaskSourceFilter
): T[] {
	return tasks.filter((task) => {
		if (activeProjectId && task.projectId !== activeProjectId) {
			return false;
		}

		if (sourceFilter && task.source !== sourceFilter) {
			return false;
		}

		return true;
	});
}

export { canImportTasks, filterTasksByProjectAndSource, isImportSource };
