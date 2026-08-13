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

import { useAtomValue } from '@effect/atom-react/Hooks'
import { isRootWorkspaceId } from '@laborer/shared/root-workspace'
import { useEffect, useRef } from 'react'

import { workspaceViewsAtom } from '@/atoms/shared-state'
import { getDesktopBridge } from '@/lib/desktop'

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
  const runningWs = useAtomValue(workspaceViewsAtom).filter(
    ({ id, status }) => status === 'running' && !isRootWorkspaceId(id)
  )
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
