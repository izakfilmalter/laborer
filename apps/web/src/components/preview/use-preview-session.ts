import { useAtomRefresh, useAtomValue } from '@effect/atom-react/Hooks'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import { useEffect, useMemo } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import { usePreviewStateStore } from '@/preview-state-store'
import { useRightPanelStore } from '@/right-panel-store'

const listAtom = Atom.family((workspaceId: string) =>
  BrowserDaemonClient.query('preview.list', { workspaceId })
)

const eventsAtom = BrowserDaemonClient.query(
  'preview.events',
  undefined as undefined
)

export function usePreviewSession(workspaceId: string): void {
  const workspaceListAtom = listAtom(workspaceId)
  const list = useAtomValue(workspaceListAtom)
  const refreshList = useAtomRefresh(workspaceListAtom)
  const events = useAtomValue(eventsAtom)

  useEffect(() => {
    if (!AsyncResult.isSuccess(list)) {
      return
    }
    usePreviewStateStore.getState().reconcile(workspaceId, list.value)
  }, [list, workspaceId])

  useEffect(() => {
    if (!AsyncResult.isSuccess(events)) {
      return
    }
    for (const event of events.value.items) {
      if (event.workspaceId !== workspaceId) {
        continue
      }
      const state = usePreviewStateStore.getState().byWorkspaceId[workspaceId]
      if (state?.serverEpoch && state.serverEpoch !== event.serverEpoch) {
        refreshList()
        continue
      }
      usePreviewStateStore.getState().applyEvent(event)
    }
  }, [events, refreshList, workspaceId])

  const sessions = usePreviewStateStore(
    (state) => state.byWorkspaceId[workspaceId]?.sessions
  )
  const tabIds = useMemo(() => Object.keys(sessions ?? {}), [sessions])
  useEffect(() => {
    useRightPanelStore.getState().reconcileBrowserSurfaces(workspaceId, tabIds)
  }, [tabIds, workspaceId])
}
