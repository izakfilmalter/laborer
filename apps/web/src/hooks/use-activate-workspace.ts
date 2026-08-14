/**
 * Hook that subscribes to "activate workspace" events from the desktop main
 * process. When another window calls `focusWindowForWorkspace`, the main
 * process focuses this window and sends an `activate-workspace` event.
 * This hook finds the first pane belonging to that workspace and sets it
 * as the active pane.
 *
 * In browser mode (no Electron), the hook is a no-op.
 *
 * @see packages/shared/src/desktop-bridge.ts — onActivateWorkspace
 * @see apps/desktop/src/ipc.ts — ACTIVATE_WORKSPACE_CHANNEL
 */

import type { WorkspaceActivationIntent } from '@laborer/shared/desktop-bridge'
import { useEffect, useRef } from 'react'

import { localApi } from '@/lib/local-api'

/**
 * Subscribe to workspace activation events from the desktop main process
 * and invoke the callback so the caller can focus the workspace's pane.
 *
 * @param onActivate - Callback receiving the workspaceId to activate
 */
function useActivateWorkspace(
  onActivate?: (intent: WorkspaceActivationIntent) => void
): void {
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate

  useEffect(() => {
    const bridge = localApi.desktopBridge
    if (!bridge?.onActivateWorkspace) {
      return
    }

    const unsubscribe = bridge.onActivateWorkspace((intent) => {
      onActivateRef.current?.(intent)
    })

    return unsubscribe
  }, [])
}

export { useActivateWorkspace }
