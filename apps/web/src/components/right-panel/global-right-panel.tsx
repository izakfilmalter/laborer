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
 * into the workspace whose surfaces are shown. Focus changes never repoint
 * the panel; only an explicit selection or the pinned workspace closing does.
 */

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

  // The panel does not follow focus. An explicit selection (workspace tab
  // strip, or opening a surface for a workspace) sticks until that workspace
  // closes; only then does the resolver fall back to the focused workspace.

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
