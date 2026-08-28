/**
 * Which full-height side panels a workspace is showing.
 *
 * Only the file tree remains here: the diff and pull-request conversation
 * moved into the workspace right panel, whose per-workspace state lives in
 * `@/right-panel-store` and persists across reloads. Tree visibility stays
 * transient and keyed by workspace, because the panel belongs to the work,
 * not to whichever pane happened to ask for it.
 *
 * The layout is the authority on which workspaces exist, so open panels are
 * pruned against it. A workspace that leaves the window takes its panels
 * with it instead of springing them open again the next time it returns.
 */

import type { WindowLayout } from '@laborer/shared/types'
import { useCallback, useEffect, useState } from 'react'
import { getAllWorkspaceTileLeaves } from '@/panels/window-layout-utils'

const toggleWorkspacePanel = (
  workspaceIds: readonly string[],
  workspaceId: string
): readonly string[] =>
  workspaceIds.includes(workspaceId)
    ? workspaceIds.filter((id) => id !== workspaceId)
    : [...workspaceIds, workspaceId]

/** Returns the same array when nothing was pruned, so state stays put. */
const filterOpenWorkspacePanels = (
  workspaceIds: readonly string[],
  openWorkspaceIds: ReadonlySet<string>
): readonly string[] => {
  const nextWorkspaceIds = workspaceIds.filter((id) => openWorkspaceIds.has(id))

  return nextWorkspaceIds.length === workspaceIds.length
    ? workspaceIds
    : nextWorkspaceIds
}

interface WorkspacePanelVisibility {
  /** @returns Whether the file tree is now shown. */
  readonly toggleTree: (workspaceId: string) => boolean
  /** Workspaces currently showing the file tree. */
  readonly treeWorkspaceIds: readonly string[]
}

function useWorkspacePanelVisibility({
  windowLayout,
}: {
  readonly windowLayout: WindowLayout | undefined
}): WorkspacePanelVisibility {
  const [treeWorkspaceIds, setTreeWorkspaceIds] = useState<readonly string[]>(
    []
  )

  // Close panels whose workspace no longer exists anywhere in the window
  // layout, so a closed workspace does not leave its panels behind.
  useEffect(() => {
    if (!(treeWorkspaceIds.length > 0 && windowLayout)) {
      return
    }

    const openWorkspaceIds = new Set(
      getAllWorkspaceTileLeaves(windowLayout).map((leaf) => leaf.workspaceId)
    )

    setTreeWorkspaceIds((current) =>
      filterOpenWorkspacePanels(current, openWorkspaceIds)
    )
  }, [treeWorkspaceIds, windowLayout])

  const toggleTree = useCallback(
    (workspaceId: string): boolean => {
      const isOpen = treeWorkspaceIds.includes(workspaceId)

      setTreeWorkspaceIds((current) =>
        toggleWorkspacePanel(current, workspaceId)
      )

      return !isOpen
    },
    [treeWorkspaceIds]
  )

  return {
    toggleTree,
    treeWorkspaceIds,
  }
}

export { useWorkspacePanelVisibility }
export type { WorkspacePanelVisibility }
