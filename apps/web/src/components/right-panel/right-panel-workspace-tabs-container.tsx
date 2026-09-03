/**
 * Data wiring for the right panel's workspace tab strip.
 *
 * Keeps the collection queries and the store reads in one place so
 * `GlobalRightPanel` stays a layout component: it hands over the window tab's
 * open workspaces, this resolves them into project groups and surface counts.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import {
  selectRightPanelSurfaceCount,
  useRightPanelStore,
} from '@/right-panel-store'
import { groupOpenWorkspacesByProject } from './right-panel-workspace-groups'
import { RightPanelWorkspaceTabs } from './right-panel-workspace-tabs'

export function RightPanelWorkspaceTabsContainer({
  openWorkspaceIds,
  selectedWorkspaceId,
}: {
  /** Workspaces tiled in the active window tab, in layout order. */
  readonly openWorkspaceIds: readonly string[]
  /** The workspace whose surfaces the panel is showing. */
  readonly selectedWorkspaceId: string | null
}) {
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const byWorkspaceId = useRightPanelStore((store) => store.byWorkspaceId)

  const groups = useMemo(
    () =>
      groupOpenWorkspacesByProject({
        openWorkspaceIds,
        projects,
        workspaces: workspaceViewsFromRows(tasks, projects),
      }),
    [openWorkspaceIds, projects, tasks]
  )

  const surfaceCounts = useMemo(
    () =>
      Object.fromEntries(
        openWorkspaceIds.map((workspaceId) => [
          workspaceId,
          selectRightPanelSurfaceCount(byWorkspaceId, workspaceId),
        ])
      ),
    [byWorkspaceId, openWorkspaceIds]
  )

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    useRightPanelStore.getState().selectWorkspace(workspaceId)
  }, [])

  return (
    <RightPanelWorkspaceTabs
      groups={groups}
      onSelectWorkspace={handleSelectWorkspace}
      selectedWorkspaceId={selectedWorkspaceId}
      surfaceCounts={surfaceCounts}
    />
  )
}
