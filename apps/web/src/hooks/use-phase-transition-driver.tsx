/**
 * Phase transition driver — connects sidecar status events to lifecycle
 * phase transitions.
 *
 * Subscribes to sidecar statuses (via Electron IPC) and advances the
 * lifecycle phase when conditions are met:
 *
 * - **Starting -> Ready:** Server sidecar reports `healthy`
 * - **Ready -> Restored:** Terminal + file-watcher sidecars both report `healthy`
 * - **Restored -> Eventually:** Server's `lifecycle.initStatus` RPC reports
 *   all deferred services ready
 *
 * Rendered as a renderless component in the app root, inside the
 * `LifecyclePhaseProvider`.
 *
 * @see Issue #7: Wire sidecar status events to lifecycle phase transitions
 * @see Issue #12: Renderer server UI wired to MessagePort
 * @see Issue #15: Server "fully initialized" event
 * @see apps/web/src/components/lifecycle-phase-context.tsx — phase system
 * @see apps/web/src/hooks/use-sidecar-statuses.ts — sidecar status source
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { useEffect, useMemo } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'
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
 *
 * The Restored -> Eventually transition uses the `lifecycle.initStatus` RPC
 * via MessagePort to the server utility process.
 */
function usePhaseTransitionDriver(): void {
  const { phase, advanceTo } = useLifecyclePhase()
  const statuses = useSidecarStatuses()

  // Starting -> Ready / Ready -> Restored: driven by sidecar health events
  useEffect(() => {
    const serverHealthy = statuses.server.state === 'healthy'
    const terminalHealthy = statuses.terminal.state === 'healthy'
    const fileWatcherHealthy = statuses['file-watcher'].state === 'healthy'

    // Ready -> Restored: terminal + file-watcher both healthy
    // (advanceTo is forward-only, so this implicitly also covers Starting -> Ready)
    if (serverHealthy && terminalHealthy && fileWatcherHealthy) {
      advanceTo(LifecyclePhase.Restored)
      return
    }

    // Starting -> Ready: server is healthy
    if (serverHealthy) {
      advanceTo(LifecyclePhase.Ready)
    }
  }, [statuses, advanceTo])

  // Restored -> Eventually: poll server's init-status via RPC
  useInitStatusPoll(phase, advanceTo)
}

// ---------------------------------------------------------------------------
// Restored -> Eventually: init-status via RPC
// ---------------------------------------------------------------------------

/**
 * Subscribe to the server's init-status to detect when all deferred services
 * are ready. Uses the `lifecycle.initStatus` RPC via the LaborerClient
 * (MessagePort to server utility process).
 */
function useInitStatusPoll(
  phase: LifecyclePhase,
  advanceTo: (target: LifecyclePhase) => void
): void {
  const shouldPoll =
    phase >= LifecyclePhase.Restored && phase < LifecyclePhase.Eventually

  // Subscribe to the RPC query atom for init status.
  const initStatusAtom = useMemo(
    () =>
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
      LaborerClient.query('lifecycle.initStatus', undefined as void),
    []
  )
  const rpcResult = useAtomValue(initStatusAtom)

  // Advance when the RPC returns ready: true
  useEffect(() => {
    if (!shouldPoll) {
      return
    }

    if (rpcResult._tag === 'Success' && rpcResult.value.ready === true) {
      advanceTo(LifecyclePhase.Eventually)
    }
  }, [rpcResult, shouldPoll, advanceTo])
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
