/**
 * Hook that returns `true` once the specified lifecycle phase has been reached.
 *
 * Components use this to conditionally render or enable features based on
 * the current lifecycle phase. Returns `false` until the phase is reached,
 * then `true` from that point forward (phase transitions are irreversible).
 *
 * ```tsx
 * const isReady = useWhenPhase(LifecyclePhase.Ready)
 * return <button disabled={!isReady}>Create Workspace</button>
 * ```
 *
 * @see Issue #5: useWhenPhase hook and service status hook
 */

import type { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useLifecyclePhase } from '@/components/lifecycle-phase-context'

/**
 * Returns `true` once the current lifecycle phase is at or past the
 * specified target phase. Returns `false` before.
 */
function useWhenPhase(targetPhase: LifecyclePhase): boolean {
  const { phase } = useLifecyclePhase()
  return phase >= targetPhase
}

export { useWhenPhase }
