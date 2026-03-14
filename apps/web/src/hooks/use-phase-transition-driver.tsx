/**
 * Phase transition driver — connects sidecar status events to lifecycle
 * phase transitions.
 *
 * Subscribes to sidecar statuses (via Electron IPC or dev health polling)
 * and advances the lifecycle phase when conditions are met:
 *
 * - **Starting → Ready:** Server sidecar reports `healthy`
 * - **Ready → Restored:** Terminal + file-watcher sidecars both report `healthy`
 * - **Restored → Eventually:** Server "fully initialized" event (Issue #15)
 *
 * Rendered as a renderless component in the app root, inside the
 * `LifecyclePhaseProvider`.
 *
 * @see Issue #7: Wire sidecar status events to lifecycle phase transitions
 * @see apps/web/src/components/lifecycle-phase-context.tsx — phase system
 * @see apps/web/src/hooks/use-sidecar-statuses.ts — sidecar status source
 */

import { useEffect } from 'react'
import {
  LifecyclePhase,
  useLifecyclePhase,
} from '@/components/lifecycle-phase-context'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'

/**
 * Hook that drives lifecycle phase transitions based on sidecar status events.
 *
 * Must be rendered inside a `LifecyclePhaseProvider`. Uses `useSidecarStatuses()`
 * to reactively track service health and calls `advanceTo()` when transition
 * conditions are met.
 */
function usePhaseTransitionDriver(): void {
  const { advanceTo } = useLifecyclePhase()
  const statuses = useSidecarStatuses()

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
