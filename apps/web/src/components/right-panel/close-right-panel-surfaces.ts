/**
 * Closing right-panel surfaces, including the resources behind them.
 *
 * A surface descriptor in the right-panel store is only half of a browser
 * tab: the other half is a preview session owned by the browser daemon.
 * Dropping the descriptor without ending that session leaks the tab, so
 * every close path — the tab strip's buttons and context menu, and the
 * Cmd+W hotkey — goes through here.
 */

import { usePreviewStateStore } from '@/preview-state-store'
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from '@/right-panel-store'

/** The browser-daemon `preview.close` mutation, as the atom hook exposes it. */
export type ClosePreview = (args: {
  payload: { tabId: string; workspaceId: string }
}) => Promise<unknown>

/**
 * End the preview sessions behind the given surfaces. Non-browser surfaces
 * are ignored. The optimistic close is rolled back if the daemon rejects.
 */
export function closePreviewResources({
  closePreview,
  surfaces,
  workspaceId,
}: {
  readonly closePreview: ClosePreview
  readonly surfaces: readonly RightPanelSurface[]
  readonly workspaceId: string
}): void {
  for (const surface of surfaces) {
    if (surface.kind !== 'preview' || !surface.resourceId) {
      continue
    }
    const tabId = surface.resourceId
    const snapshot =
      usePreviewStateStore.getState().byWorkspaceId[workspaceId]?.sessions[
        tabId
      ]
    usePreviewStateStore.getState().beginClose(workspaceId, tabId)
    closePreview({ payload: { workspaceId, tabId } }).catch(() => {
      usePreviewStateStore.getState().cancelClose(workspaceId, tabId, snapshot)
    })
  }
}

/**
 * Close the active right-panel surface, if the window's panel is showing
 * this workspace and has one.
 *
 * Returns whether a surface was closed, so callers with a fallback (Cmd+W's
 * progressive close) know whether the keystroke was consumed here.
 */
export function closeActiveRightPanelSurface({
  closePreview,
  workspaceId,
}: {
  readonly closePreview: ClosePreview
  readonly workspaceId: string
}): boolean {
  const store = useRightPanelStore.getState()
  const activeSurface = selectActiveRightPanelSurface(store, workspaceId)
  if (!activeSurface) {
    return false
  }
  closePreviewResources({
    closePreview,
    surfaces: [activeSurface],
    workspaceId,
  })
  store.closeSurface(workspaceId, activeSurface.id)
  return true
}
