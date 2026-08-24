/**
 * React hook that tracks the live status of daemon-owned capabilities.
 *
 * All mounted consumers share one ref-counted poll loop backed by atoms, so
 * mounting this hook N times still yields a single set of health fetches.
 * Polling pauses while the page is hidden and refreshes immediately when it
 * becomes visible again.
 *
 * @see apps/web/src/atoms/sidecar-statuses.ts — shared poll loop and state
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 */

import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'

import {
  sidecarStatusesAtom,
  sidecarStatusesPollerAtom,
} from '@/atoms/sidecar-statuses'
import type { SidecarStatuses } from '@/lib/sidecar-statuses'

/**
 * Track the live status of all daemon-owned capabilities.
 *
 * Returns a `SidecarStatuses` record mapping each service name to its
 * current state (unknown | starting | healthy | crashed | restarting).
 */
function useSidecarStatuses(): SidecarStatuses {
  useAtomMount(sidecarStatusesPollerAtom)
  return useAtomValue(sidecarStatusesAtom)
}

export { useSidecarStatuses }
