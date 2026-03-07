export type TaskSourceFilter = 'linear' | 'github'

interface FilterableTask {
  readonly projectId: string
  readonly source: string
}

function canImportTasks(
  _source: TaskSourceFilter,
  activeProjectId?: string | null
): boolean {
  return !!activeProjectId
}

function filterTasksByProjectAndSource<T extends FilterableTask>(
  tasks: readonly T[],
  activeProjectId?: string | null,
  sourceFilter?: TaskSourceFilter
): T[] {
  return tasks.filter((task) => {
    if (activeProjectId && task.projectId !== activeProjectId) {
      return false
    }

    if (sourceFilter && task.source !== sourceFilter) {
      return false
    }

    return true
  })
}

export { canImportTasks, filterTasksByProjectAndSource }
