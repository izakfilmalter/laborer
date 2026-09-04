/**
 * The window's one right panel.
 *
 * Mounted once beside `<main>` — level with the project sidebar, spanning the
 * full window height — rather than inside each workspace frame, so the panel
 * keeps its width and scroll position as focus moves between workspaces and
 * stays reachable while a pane is fullscreened.
 *
 * The store says whether the panel is open and which workspace it is pinned
 * to; `resolveRightPanelWorkspaceId` turns that plus the focused workspace
 * into the workspace whose surfaces are shown.
 */

import { useEffect } from 'react'
import {
  resolveRightPanelWorkspaceId,
  useRightPanelStore,
} from '@/right-panel-store'
import {
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  RightPanelShell,
} from './right-panel-shell'
import { RightPanelWorkspaceTabsContainer } from './right-panel-workspace-tabs-container'
import { WorkspaceRightPanel } from './workspace-right-panel'

export function GlobalRightPanel({
  activeWorkspaceId,
  openWorkspaceIds,
}: {
  /** The workspace owning the focused pane, or null while nothing is focused. */
  readonly activeWorkspaceId: string | null
  /** Workspaces tiled in the active window tab, in layout order. */
  readonly openWorkspaceIds: readonly string[]
}) {
  const isOpen = useRightPanelStore((store) => store.isOpen)
  const selectedWorkspaceId = useRightPanelStore(
    (store) => store.selectedWorkspaceId
  )

  const focusedWorkspaceId =
    activeWorkspaceId !== null && openWorkspaceIds.includes(activeWorkspaceId)
      ? activeWorkspaceId
      : null

  // Selection follows focus: moving focus to another open workspace repoints
  // the panel at it. The focused workspace lives in the window layout, not in
  // this store, so keeping the two in step is synchronization with an
  // external system. Depending on the resolved id (not the array) means the
  // effect fires only when focus actually moves, so an explicit workspace-tab
  // click stays selected until it does.
  useEffect(() => {
    if (focusedWorkspaceId === null) {
      return
    }
    useRightPanelStore.getState().selectWorkspace(focusedWorkspaceId)
  }, [focusedWorkspaceId])

  if (!isOpen || openWorkspaceIds.length === 0) {
    return null
  }

  const workspaceId = resolveRightPanelWorkspaceId(
    { selectedWorkspaceId },
    activeWorkspaceId,
    openWorkspaceIds
  )
  if (workspaceId === null) {
    return null
  }

  return (
    <RightPanelShell
      widthStorageKey={RIGHT_PANEL_WIDTH_STORAGE_KEY}
      workspaceId={workspaceId}
    >
      <RightPanelWorkspaceTabsContainer
        openWorkspaceIds={openWorkspaceIds}
        selectedWorkspaceId={workspaceId}
      />
      <WorkspaceRightPanel workspaceId={workspaceId} />
    </RightPanelShell>
  )
}
