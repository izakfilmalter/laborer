/**
 * Phase transition driver — connects sidecar status events to lifecycle
 * phase transitions.
 *
 * Subscribes to sidecar statuses (via Electron IPC) and advances the
 * lifecycle phase when conditions are met:
 *
 * - **Starting -> Ready:** Server sidecar reports `healthy`
 * - **Ready -> Restored:** Terminal + file-watcher sidecars both report `healthy`
 * - **Restored -> Eventually:** Server's `lifecycle.initStatus` streaming RPC
 *   pushes `{ ready: true }` when all deferred services are initialized
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

import { Result } from '@effect-atom/atom'
import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { useEffect, useMemo, useRef } from 'react'

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
 * The Restored -> Eventually transition subscribes to the `lifecycle.initStatus`
 * streaming RPC. The server pushes `{ ready: true }` when all deferred services
 * complete initialization — no client-side polling needed.
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

  // Restored -> Eventually: subscribe to server's init-status stream
  useInitStatusStream(phase, advanceTo)
}

// ---------------------------------------------------------------------------
// Restored -> Eventually: init-status streaming RPC
// ---------------------------------------------------------------------------

/**
 * Subscribe to the server's init-status streaming RPC to detect when all
 * deferred services are ready. The server pushes `{ ready: true }` when
 * initialization completes — no polling or manual refresh needed.
 *
 * Uses `LaborerClient.query` which creates a pull-based stream atom.
 * The atom receives pushed values from the server and re-renders the
 * component when new items arrive.
 */
function useInitStatusStream(
  phase: LifecyclePhase,
  advanceTo: (target: LifecyclePhase) => void
): void {
  const shouldAdvance =
    phase >= LifecyclePhase.Restored && phase < LifecyclePhase.Eventually

  // Subscribe to the streaming RPC. The atom receives pushed values
  // from the server as the SubscriptionRef changes.
  const initStatusAtom = useMemo(
    () =>
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
      LaborerClient.query('lifecycle.initStatus', undefined as void),
    []
  )
  const rpcResult = useAtomValue(initStatusAtom)

  // The pull-based stream atom only auto-fetches the first item.
  // Subsequent items require writing `void` to the atom to trigger
  // the next pull. We poll every 500ms while waiting for ready=true.
  const pullNext = useAtomSet(initStatusAtom)
  const pullIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Only poll while we're in the Restored phase waiting for Eventually
    if (!shouldAdvance) {
      return
    }

    // Already got ready=true — no need to poll
    if (
      Result.isSuccess(rpcResult) &&
      rpcResult.value.items.at(-1)?.ready === true
    ) {
      return
    }

    // Start polling for the next stream item
    if (pullIntervalRef.current === null) {
      pullIntervalRef.current = setInterval(() => {
        // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
        pullNext(undefined as void)
      }, 500)
    }

    return () => {
      if (pullIntervalRef.current !== null) {
        clearInterval(pullIntervalRef.current)
        pullIntervalRef.current = null
      }
    }
  }, [shouldAdvance, rpcResult, pullNext])

  // Advance when the stream pushes { ready: true }.
  // The pull-based atom accumulates items — check the latest.
  useEffect(() => {
    if (!shouldAdvance) {
      return
    }

    if (Result.isInitial(rpcResult) || rpcResult.waiting) {
      return
    }

    if (Result.isSuccess(rpcResult)) {
      const latestItem = rpcResult.value.items.at(-1)
      if (latestItem?.ready === true) {
        advanceTo(LifecyclePhase.Eventually)
      }
    }
  }, [rpcResult, shouldAdvance, advanceTo])
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
