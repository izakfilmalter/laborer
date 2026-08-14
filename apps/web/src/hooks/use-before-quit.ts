/**
 * Renderer-side quit handler — subscribes to the main process's before-quit
 * signal and responds with a veto decision.
 *
 * When the main process wants to quit (Cmd+Q, tray Quit, app.quit()), it
 * sends a `BeforeQuitPayload` to the renderer window participating in quit
 * negotiation. That window must respond with `respondToQuit(id, veto)`.
 *
 * This hook:
 * 1. Subscribes to `onBeforeQuit` via the DesktopBridge.
 * 2. Checks the shared terminal list for running terminals with child processes.
 * 3. If running terminals exist, vetoes the quit and returns dialog state
 *    so a confirmation dialog can be shown.
 * 4. If no running terminals (or user confirmed), allows the quit.
 *
 * Only active when running inside the Electron desktop shell. In browser
 * mode, the hook is a no-op.
 *
 * @see packages/shared/src/desktop-bridge.ts — BeforeQuitPayload
 * @see apps/desktop/src/ipc.ts — askRenderersBeforeQuit
 */

import { useCallback, useEffect, useState } from 'react'
import { getRunningTerminalCount } from '@/hooks/use-terminal-list'
import { localApi } from '@/lib/local-api'

interface PendingQuit {
  readonly id: string
}

interface UseBeforeQuitResult {
  /** User cancelled — veto the quit. */
  readonly cancelQuit: () => void
  /** User confirmed — allow the quit to proceed. */
  readonly confirmQuit: () => void
  /** Whether the quit confirmation dialog should be shown. */
  readonly isQuitDialogOpen: boolean
  /** Number of running terminals that will be killed on quit. */
  readonly runningTerminalCount: number
}

/**
 * Module-level flag: when true, the next `onBeforeQuit` message will be
 * allowed through without checking for running terminals. Set when the
 * user confirms the quit dialog, cleared after use.
 *
 * This avoids an infinite loop: user confirms → window.close → main
 * re-asks → hook checks terminals → still running → veto again.
 */
let forceAllowNextQuit = false

function useBeforeQuit(): UseBeforeQuitResult {
  const [pendingQuit, setPendingQuit] = useState<PendingQuit | null>(null)
  const [runningTerminalCount, setRunningTerminalCount] = useState(0)

  useEffect(() => {
    const bridge = localApi.desktopBridge
    if (!bridge) {
      return
    }

    const unsubscribe = bridge.onBeforeQuit((payload) => {
      // If the user already confirmed via the dialog, allow immediately.
      if (forceAllowNextQuit) {
        forceAllowNextQuit = false
        console.info(
          `[renderer] Received before-quit (id=${payload.id}) — user confirmed, allowing`
        )
        bridge.respondToQuit(payload.id, false)
        return
      }

      const count = getRunningTerminalCount()

      if (count === 0) {
        // No running terminals — allow the quit immediately.
        console.info(
          `[renderer] Received before-quit (id=${payload.id}) — no running terminals, allowing`
        )
        bridge.respondToQuit(payload.id, false)
        return
      }

      // Running terminals exist — veto the quit and show the dialog.
      console.info(
        `[renderer] Received before-quit (id=${payload.id}) — ${count} running terminal(s), showing dialog`
      )
      setRunningTerminalCount(count)
      setPendingQuit({ id: payload.id })
      bridge.respondToQuit(payload.id, true)
    })

    return unsubscribe
  }, [])

  const confirmQuit = useCallback(() => {
    setPendingQuit(null)
    setRunningTerminalCount(0)

    // Set the force flag so the next before-quit round allows the quit
    // without re-checking for running terminals.
    forceAllowNextQuit = true

    // Trigger quit via the bridge. We need to add a quitApp method to
    // the bridge for this. For now, use ipcSend to tell the main process
    // to re-trigger app.quit().
    const bridge = localApi.desktopBridge
    if (bridge) {
      bridge.ipcSend('desktop:quit-confirmed')
    }
  }, [])

  const cancelQuit = useCallback(() => {
    setPendingQuit(null)
    setRunningTerminalCount(0)
  }, [])

  return {
    cancelQuit,
    confirmQuit,
    isQuitDialogOpen: pendingQuit !== null,
    runningTerminalCount,
  }
}

export { useBeforeQuit }
export type { UseBeforeQuitResult }
