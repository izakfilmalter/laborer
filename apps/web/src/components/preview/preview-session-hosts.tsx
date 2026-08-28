import { useRightPanelStore } from '@/right-panel-store'
import { usePreviewSession } from './use-preview-session'

function WorkspacePreviewSession({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  usePreviewSession(workspaceId)
  return null
}

/** Keeps daemon sessions alive and reconciled even while the right panel is hidden. */
export function PreviewSessionHosts() {
  const byWorkspaceId = useRightPanelStore((state) => state.byWorkspaceId)
  const workspaceIds = Object.keys(byWorkspaceId)
  return workspaceIds.map((workspaceId) => (
    <WorkspacePreviewSession key={workspaceId} workspaceId={workspaceId} />
  ))
}
