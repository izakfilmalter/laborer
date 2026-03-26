/**
 * Phase transition driver — connects sidecar status events to lifecycle
 * phase transitions.
 *
 * Subscribes to sidecar statuses (via Electron IPC or dev health polling)
 * and advances the lifecycle phase when conditions are met:
 *
 * - **Starting → Ready:** Server sidecar reports `healthy`
 * - **Ready → Restored:** Terminal + file-watcher sidecars both report `healthy`
 * - **Restored → Eventually:** Server's `lifecycle.initStatus` RPC (Electron)
 *   or `/init-status` HTTP endpoint (browser dev) reports all deferred
 *   services ready (polled after phase reaches Restored)
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
import { isElectron, serverInitStatusUrl } from '@/lib/desktop'

/** Polling interval for the init-status endpoint (ms). */
const INIT_STATUS_POLL_INTERVAL_MS = 2000

/**
 * Whether to use the MessagePort-based RPC for init-status checks.
 * In Electron mode, the server runs as a utility process without an HTTP
 * endpoint, so we use the `lifecycle.initStatus` RPC via MessagePort.
 * In browser dev mode, we fall back to HTTP polling.
 */
const USE_RPC_INIT_STATUS = isElectron()

/**
 * Hook that drives lifecycle phase transitions based on sidecar status events.
 *
 * Must be rendered inside a `LifecyclePhaseProvider`. Uses `useSidecarStatuses()`
 * to reactively track service health and calls `advanceTo()` when transition
 * conditions are met.
 *
 * The Restored → Eventually transition uses the `lifecycle.initStatus` RPC
 * in Electron mode (MessagePort) or HTTP polling in browser dev mode.
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

  // Restored → Eventually: poll server's init-status via RPC or HTTP
  useInitStatusPoll(phase, advanceTo)
}

// ---------------------------------------------------------------------------
// Restored → Eventually: init-status polling
// ---------------------------------------------------------------------------

/**
 * Poll the server's init-status to detect when all deferred services are ready.
 *
 * In Electron mode, uses the `lifecycle.initStatus` RPC via the LaborerClient
 * (MessagePort). In browser dev mode, falls back to HTTP polling of the
 * `/init-status` endpoint (Vite proxy).
 */
function useInitStatusPoll(
  phase: LifecyclePhase,
  advanceTo: (target: LifecyclePhase) => void
): void {
  const shouldPoll =
    phase >= LifecyclePhase.Restored && phase < LifecyclePhase.Eventually

  // Subscribe to the RPC query atom for init status. In Electron mode the
  // result drives the phase transition; in browser dev mode it's unused but
  // the hook is always called to satisfy React's rules of hooks.
  const initStatusAtom = useMemo(
    () =>
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
      LaborerClient.query('lifecycle.initStatus', undefined as void),
    []
  )
  const rpcResult = useAtomValue(initStatusAtom)

  // Electron: advance when the RPC returns ready: true
  useEffect(() => {
    if (!(USE_RPC_INIT_STATUS && shouldPoll)) {
      return
    }

    if (rpcResult._tag === 'Success' && rpcResult.value.ready === true) {
      advanceTo(LifecyclePhase.Eventually)
    }
  }, [rpcResult, shouldPoll, advanceTo])

  // Browser dev: poll HTTP endpoint
  useEffect(() => {
    if (USE_RPC_INIT_STATUS || !shouldPoll) {
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
  }, [shouldPoll, advanceTo])
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
