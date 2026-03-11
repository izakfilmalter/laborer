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

import { workspaces } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { useEffect, useRef } from 'react'

import { getDesktopBridge } from '@/lib/desktop'
import { useLaborerStore } from '@/livestore/store'

/** LiveStore query for all non-destroyed workspaces with "running" status. */
const runningWorkspaces$ = queryDb(workspaces.where({ status: 'running' }), {
  label: 'trayRunningWorkspaces',
})

/**
 * Sync the running workspace count to the Electron system tray tooltip.
 *
 * Call this hook once at the app root level. It subscribes to the LiveStore
 * `workspaces` table, counts rows with status "running", and invokes
 * `desktopBridge.updateTrayWorkspaceCount()` when the count changes.
 */
function useTrayWorkspaceCount(): void {
  const store = useLaborerStore()
  const runningWs = store.useQuery(runningWorkspaces$)
  const count = runningWs.length
  const prevCountRef = useRef<number>(-1)

  useEffect(() => {
    const bridge = getDesktopBridge()
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
