/**
 * Grouping for the right panel's workspace tab strip.
 *
 * The strip reads as an address: each project, then the workspaces open
 * under it. Projects keep Laborer's durable presentation order
 * (`orderedProjectsFromRows`) so the strip matches the sidebar, while the
 * workspaces inside a project keep the window's layout order so a tab sits
 * where its frame does. Only projects with an open workspace appear, and a
 * workspace id whose view has not landed yet (or has been destroyed) is
 * skipped rather than rendered as an unnamed tab.
 */

import type { SharedProjectRow } from '@laborer/shared/rpc'
import { orderedProjectsFromRows, type WorkspaceView } from '@/db/shared-state'

export interface RightPanelProjectGroup {
  readonly project: SharedProjectRow
  readonly workspaces: readonly WorkspaceView[]
}

export function groupOpenWorkspacesByProject({
  openWorkspaceIds,
  projects,
  workspaces,
}: {
  /** Workspaces tiled in the active window tab, in layout order. */
  readonly openWorkspaceIds: readonly string[]
  readonly projects: readonly SharedProjectRow[]
  readonly workspaces: readonly WorkspaceView[]
}): readonly RightPanelProjectGroup[] {
  const viewsById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace])
  )
  const byProjectId = new Map<string, WorkspaceView[]>()
  for (const workspaceId of openWorkspaceIds) {
    const workspace = viewsById.get(workspaceId)
    if (workspace === undefined) {
      continue
    }
    const group = byProjectId.get(workspace.projectId)
    if (group === undefined) {
      byProjectId.set(workspace.projectId, [workspace])
    } else {
      group.push(workspace)
    }
  }
  return orderedProjectsFromRows(projects).flatMap((project) => {
    const groupWorkspaces = byProjectId.get(project.id)
    return groupWorkspaces === undefined || groupWorkspaces.length === 0
      ? []
      : [{ project, workspaces: groupWorkspaces }]
  })
}
