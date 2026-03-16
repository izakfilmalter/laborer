/**
 * Electron sidecar crash detection and restart hook.
 *
 * Listens for sidecar status events via the Electron DesktopBridge.
 * When a backend service crashes, a persistent error toast is shown
 * with a "Restart" action button. When the service recovers, the
 * error toast is dismissed.
 *
 * Only active when running inside the Electron desktop shell. In browser
 * mode, the hook is a no-op.
 *
 * @see packages/shared/src/desktop-bridge.ts — DesktopBridge contract
 * @see apps/desktop/src/health.ts — HealthMonitor event emission
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { getDesktopBridge } from '@/lib/desktop'

/** Human-readable display names for sidecar services. */
const DISPLAY_NAMES: Record<SidecarName, string> = {
  server: 'Server',
  terminal: 'Terminal',
  mcp: 'MCP',
}

/**
 * Listen for sidecar crash events and show toast notifications with restart.
 *
 * Call this hook once at the app root level. It:
 * 1. Subscribes to sidecar status events — shows a persistent error toast
 *    when a service crashes with a "Restart" action button.
 * 2. Dismisses the error toast when the service recovers (healthy state).
 * 3. On "Restart" click, invokes `desktopBridge.restartSidecar()` and
 *    shows a loading toast while the service restarts.
 */
function useSidecarCrashListener(): void {
  /** Track active error toast IDs by sidecar name for dismissal. */
  const toastIdsRef = useRef<Map<SidecarName, string | number>>(new Map())

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    const unsubscribe = bridge.onSidecarStatus((status) => {
      const { name } = status
      const displayName = DISPLAY_NAMES[name]

      if (status.state === 'crashed') {
        // Dismiss any existing error toast for this service
        const existingId = toastIdsRef.current.get(name)
        if (existingId !== undefined) {
          toast.dismiss(existingId)
        }

        const id = toast.error(`${displayName} service crashed`, {
          description: status.error,
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: 'Restart',
            onClick: () => {
              toast.dismiss(id)
              toastIdsRef.current.delete(name)

              const restartId = toast.loading(`Restarting ${displayName}...`)

              bridge.restartSidecar(name).catch((restartError: unknown) => {
                toast.dismiss(restartId)
                toast.error(`Failed to restart ${displayName}`, {
                  description: String(restartError),
                })
              })
            },
          },
        })

        toastIdsRef.current.set(name, id)
      }

      if (status.state === 'healthy') {
        // Dismiss the error toast if there was one
        const existingId = toastIdsRef.current.get(name)
        if (existingId !== undefined) {
          toast.dismiss(existingId)
          toastIdsRef.current.delete(name)
        }

        toast.success(`${displayName} service recovered`)
      }
    })

    return unsubscribe
  }, [])
}

export { useSidecarCrashListener }
