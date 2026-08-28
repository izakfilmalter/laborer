import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo } from 'react'
import { cancelBrowserRecording } from '@/browser/browser-recording'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import {
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'
import { BrowserAutomationHost } from './browser-automation-host'
import { usePreviewSession } from './use-preview-session'

export function cleanupWorkspacePreview(workspaceId: string): void {
  const state = usePreviewStateStore.getState().byWorkspaceId[workspaceId]
  for (const tabId of Object.keys(state?.sessions ?? {})) {
    cancelBrowserRecording(
      previewRuntimeTabId(workspaceId, state?.serverEpoch ?? null, tabId)
    ).catch(() => undefined)
  }
  usePreviewStateStore.getState().removeWorkspace(workspaceId)
  usePreviewMiniPlayerStore.getState().removeWorkspace(workspaceId)
}

function WorkspacePreviewSession({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  usePreviewSession(workspaceId)
  useEffect(() => () => cleanupWorkspacePreview(workspaceId), [workspaceId])
  return null
}

/** Keeps daemon sessions alive and reconciled even while the right panel is hidden. */
export function PreviewSessionHosts() {
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const workspaceIds = useMemo(
    () => workspaceViewsFromRows(tasks, projects).map(({ id }) => id),
    [projects, tasks]
  )
  return workspaceIds.map((workspaceId) => (
    <span className="contents" key={workspaceId}>
      <WorkspacePreviewSession workspaceId={workspaceId} />
      <BrowserAutomationHost workspaceId={workspaceId} />
    </span>
  ))
}
