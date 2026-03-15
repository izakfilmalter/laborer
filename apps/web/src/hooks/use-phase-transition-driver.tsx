/**
 * Phase transition driver — connects sidecar status events to lifecycle
 * phase transitions.
 *
 * Subscribes to sidecar statuses (via Electron IPC or dev health polling)
 * and advances the lifecycle phase when conditions are met:
 *
 * - **Starting → Ready:** Server sidecar reports `healthy`
 * - **Ready → Restored:** Terminal + file-watcher sidecars both report `healthy`
 * - **Restored → Eventually:** Server's `/init-status` endpoint reports
 *   all deferred services ready (polled after phase reaches Restored)
 *
 * Rendered as a renderless component in the app root, inside the
 * `LifecyclePhaseProvider`.
 *
 * @see Issue #7: Wire sidecar status events to lifecycle phase transitions
 * @see Issue #15: Server "fully initialized" event
 * @see apps/web/src/components/lifecycle-phase-context.tsx — phase system
 * @see apps/web/src/hooks/use-sidecar-statuses.ts — sidecar status source
 */

import { useEffect } from 'react'
import {
  LifecyclePhase,
  useLifecyclePhase,
} from '@/components/lifecycle-phase-context'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'
import { serverInitStatusUrl } from '@/lib/desktop'

/** Polling interval for the init-status endpoint (ms). */
const INIT_STATUS_POLL_INTERVAL_MS = 2000

/**
 * Hook that drives lifecycle phase transitions based on sidecar status events.
 *
 * Must be rendered inside a `LifecyclePhaseProvider`. Uses `useSidecarStatuses()`
 * to reactively track service health and calls `advanceTo()` when transition
 * conditions are met.
 */
function usePhaseTransitionDriver(): void {
  const { phase, advanceTo } = useLifecyclePhase()
  const statuses = useSidecarStatuses()

  // Starting → Ready / Ready → Restored: driven by sidecar health events
  useEffect(() => {
    const serverHealthy = statuses.server.state === 'healthy'
    const terminalHealthy = statuses.terminal.state === 'healthy'
    const fileWatcherHealthy = statuses['file-watcher'].state === 'healthy'

    // Ready → Restored: terminal + file-watcher both healthy
    // (advanceTo is forward-only, so this implicitly also covers Starting → Ready)
    if (serverHealthy && terminalHealthy && fileWatcherHealthy) {
      advanceTo(LifecyclePhase.Restored)
      return
    }

    // Starting → Ready: server is healthy
    if (serverHealthy) {
      advanceTo(LifecyclePhase.Ready)
    }
  }, [statuses, advanceTo])

  // Restored → Eventually: poll server's init-status endpoint
  useEffect(() => {
    // Only poll between Restored and Eventually — not before Restored
    // (server may not be ready) and not after Eventually (already reached).
    if (phase < LifecyclePhase.Restored || phase >= LifecyclePhase.Eventually) {
      return
    }

    const url = serverInitStatusUrl()
    const controller = new AbortController()

    async function pollInitStatus() {
      try {
        const timeoutId = setTimeout(() => controller.abort(), 2000)
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'error',
        })
        clearTimeout(timeoutId)

        if (!response.ok || controller.signal.aborted) {
          return
        }

        const data: unknown = await response.json()
        if (
          typeof data === 'object' &&
          data !== null &&
          'ready' in data &&
          (data as { ready: unknown }).ready === true &&
          !controller.signal.aborted
        ) {
          advanceTo(LifecyclePhase.Eventually)
        }
      } catch {
        // Server not reachable or request aborted — retry on next poll
      }
    }

    // Poll immediately, then on interval
    pollInitStatus()

    const intervalId = setInterval(pollInitStatus, INIT_STATUS_POLL_INTERVAL_MS)

    return () => {
      controller.abort()
      clearInterval(intervalId)
    }
  }, [phase, advanceTo])
}

/**
 * Renderless component that drives lifecycle phase transitions.
 * Place inside `LifecyclePhaseProvider` in the app root.
 */
function PhaseTransitionDriver(): null {
  usePhaseTransitionDriver()
  return null
}

export { PhaseTransitionDriver, usePhaseTransitionDriver }
