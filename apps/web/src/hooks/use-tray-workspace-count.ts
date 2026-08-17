/**
 * Electron system tray workspace count sync hook.
 *
 * Keeps the system tray tooltip in sync with the number of running workspaces
 * by calling `desktopBridge.updateTrayWorkspaceCount()` whenever the
 * reactive workspace count changes.
 *
 * Only runs when the app is inside the Electron desktop shell (detected via
 * `window.desktopBridge`). In browser mode, the hook is a no-op.
 *
 * @see packages/shared/src/desktop-bridge.ts — DesktopBridge contract
 */

import { isRootWorkspaceId } from '@laborer/shared/root-workspace'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo, useRef } from 'react'

import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { localApi } from '@/lib/local-api'

/**
 * Sync the running workspace count to the Electron system tray tooltip.
 *
 * Call this hook once at the app root level. It reads the shared task stream,
 * counts task-backed workspaces with status "running", and invokes
 * `desktopBridge.updateTrayWorkspaceCount()` when the count changes.
 */
function useTrayWorkspaceCount(): void {
  // Synthetic root workspaces (one per project, always present) are not
  // running work — only task-backed workspaces count toward the tray badge.
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const workspaces = useMemo(
    () => workspaceViewsFromRows(tasks, projects),
    [projects, tasks]
  )
  const runningWs = workspaces.filter(
    ({ id, status }) => status === 'running' && !isRootWorkspaceId(id)
  )
  const count = runningWs.length
  const prevCountRef = useRef<number>(-1)

  useEffect(() => {
    const bridge = localApi.desktopBridge
    if (!bridge) {
      return
    }
    if (count === prevCountRef.current) {
      return
    }
    prevCountRef.current = count

    bridge.updateTrayWorkspaceCount(count).catch(() => {
      // Silently ignore — tray may not be available in all environments
    })
  }, [count])
}

export { useTrayWorkspaceCount }
