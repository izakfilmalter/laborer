/**
 * Tauri sidecar crash detection and restart hook.
 *
 * Listens for `sidecar:error` and `sidecar:healthy` Tauri events emitted by
 * the Rust `SidecarManager`. When a backend service crashes, a persistent
 * error toast is shown with a "Restart" action button. When the service
 * recovers (either via restart or independently), the error toast is dismissed.
 *
 * Only active when running inside the Tauri desktop shell. In browser mode,
 * the hook is a no-op.
 *
 * @see Issue 7: Frontend crash notification and restart UI
 * @see apps/web/src-tauri/src/sidecar.rs — SidecarManager event emission
 */

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { isTauri } from '@/lib/tauri'

/** Matches `SidecarName` serialization from Rust (`#[serde(rename_all = "lowercase")]`). */
type SidecarName = 'server' | 'terminal'

/** Matches `SidecarErrorPayload` from Rust. */
interface SidecarErrorPayload {
  error: string
  last_stderr: string
  name: SidecarName
}

/** Matches `SidecarHealthyPayload` from Rust. */
interface SidecarHealthyPayload {
  name: SidecarName
}

/** Human-readable display names for sidecar services. */
const DISPLAY_NAMES: Record<SidecarName, string> = {
  server: 'Server',
  terminal: 'Terminal',
}

/**
 * Listen for sidecar crash events and show toast notifications with restart.
 *
 * Call this hook once at the app root level. It:
 * 1. Subscribes to `sidecar:error` — shows a persistent error toast with
 *    service name, error summary, and a "Restart" action button.
 * 2. Subscribes to `sidecar:healthy` — dismisses the error toast for
 *    the recovered service.
 * 3. On "Restart" click, invokes the `restart_sidecar` Tauri command
 *    and shows a loading toast while the service restarts.
 */
function useSidecarCrashListener(): void {
  /** Track active error toast IDs by sidecar name for dismissal. */
  const toastIdsRef = useRef<Map<SidecarName, string | number>>(new Map())

  useEffect(() => {
    if (!isTauri()) {
      return
    }

    let cancelled = false
    const unlisteners: Array<() => void> = []

    async function setup(): Promise<void> {
      // Dynamic import — @tauri-apps/api is only available in Tauri context.
      const { listen } = await import('@tauri-apps/api/event')
      const { invoke } = await import('@tauri-apps/api/core')

      if (cancelled) {
        return
      }

      const unlistenError = await listen<SidecarErrorPayload>(
        'sidecar:error',
        (event) => {
          const { name, error } = event.payload
          const displayName = DISPLAY_NAMES[name]

          // Dismiss any existing error toast for this service
          const existingId = toastIdsRef.current.get(name)
          if (existingId !== undefined) {
            toast.dismiss(existingId)
          }

          const id = toast.error(`${displayName} service crashed`, {
            description: error,
            duration: Number.POSITIVE_INFINITY,
            action: {
              label: 'Restart',
              onClick: () => {
                toast.dismiss(id)
                toastIdsRef.current.delete(name)

                const restartId = toast.loading(`Restarting ${displayName}...`)

                invoke('restart_sidecar', { name }).catch(
                  (restartError: unknown) => {
                    toast.dismiss(restartId)
                    toast.error(`Failed to restart ${displayName}`, {
                      description: String(restartError),
                    })
                  }
                )
              },
            },
          })

          toastIdsRef.current.set(name, id)
        }
      )
      unlisteners.push(unlistenError)

      const unlistenHealthy = await listen<SidecarHealthyPayload>(
        'sidecar:healthy',
        (event) => {
          const { name } = event.payload

          // Dismiss the error toast if there was one
          const existingId = toastIdsRef.current.get(name)
          if (existingId !== undefined) {
            toast.dismiss(existingId)
            toastIdsRef.current.delete(name)
          }

          // Dismiss any "Restarting..." loading toasts — they don't have
          // tracked IDs, but the healthy event means the service is back.
          // Sonner will auto-dismiss loading toasts we don't track.

          const displayName = DISPLAY_NAMES[name]
          toast.success(`${displayName} service recovered`)
        }
      )
      unlisteners.push(unlistenHealthy)
    }

    setup()

    return () => {
      cancelled = true
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }, [])
}

export { useSidecarCrashListener }
