/**
 * Shared, ref-counted polling of daemon-owned capability health.
 *
 * Every consumer of `useSidecarStatuses` mounts `sidecarStatusesPollerAtom`
 * and reads `sidecarStatusesAtom`; the atom registry ref-counts the poller so
 * N consumers share one poll loop. The loop pauses while the page is hidden
 * and refreshes immediately when it becomes visible again.
 *
 * @see apps/web/src/hooks/use-sidecar-statuses.ts — the consuming hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see packages/server/src/daemon-main.ts — capability health aliases
 */

import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { Duration, Effect } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import {
  areSidecarStatusesEqual,
  deriveSidecarStatuses,
  type SidecarStatuses,
} from '@/lib/sidecar-statuses'

import { pollWhileVisible } from './page-visibility'

/** Polling interval for daemon health checks (ms). */
export const SIDECAR_POLL_INTERVAL_MS = 3000

/** Timeout for a single health fetch (ms). */
const HEALTH_FETCH_TIMEOUT_MS = 2000

/** Health aliases for each daemon-owned capability. */
const HEALTH_ENDPOINTS: readonly (readonly [SidecarName, string])[] = [
  ['server', '/server-health'],
  ['terminal', '/terminal-health'],
  ['file-watcher', '/file-watcher-health'],
]

/**
 * The shared statuses every consumer reads. Custom equality skips listener
 * notifications when a poll observed no change, so unchanged polls do not
 * re-render consumers.
 */
export const sidecarStatusesAtom = Atom.make<SidecarStatuses>(
  deriveSidecarStatuses([])
).pipe(Atom.withEquality<SidecarStatuses>(areSidecarStatusesEqual))

/**
 * Consecutive-failure tracker preserving the 3-strikes crash semantics:
 * a service crashes on the first failure after being healthy, or after three
 * consecutive failures from an unknown state. Recovery emits `healthy` once.
 */
export interface SidecarHealthTracker {
  readonly report: (
    name: SidecarName,
    healthy: boolean
  ) => SidecarStatusEvent | undefined
}

export const createSidecarHealthTracker = (): SidecarHealthTracker => {
  const healthState = new Map<SidecarName, boolean>()
  const failureCount = new Map<SidecarName, number>()
  return {
    report(name, healthy) {
      if (healthy) {
        failureCount.set(name, 0)
        if (healthState.get(name)) {
          return undefined
        }
        healthState.set(name, true)
        return { name, state: 'healthy' }
      }
      const failures = (failureCount.get(name) ?? 0) + 1
      failureCount.set(name, failures)
      const wasHealthy = healthState.get(name) === true
      if (wasHealthy || failures >= 3) {
        healthState.set(name, false)
        return { error: 'Service unreachable', name, state: 'crashed' }
      }
      return undefined
    },
  }
}

/** Attempt to fetch a health endpoint. Succeeds with whether it responded ok. */
const tryFetchHealth = (endpoint: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        HEALTH_FETCH_TIMEOUT_MS
      )
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      return response.ok
    } catch {
      return false
    }
  })

/**
 * One shared poll loop, ref-counted by atom subscription: it starts when the
 * first consumer mounts it and stops when the last one unmounts.
 */
export const sidecarStatusesPollerAtom = Atom.make((get) => {
  // Keep the shared value (and its last derived state) alive while polling,
  // even if consumers briefly unsubscribe from the value atom.
  get.mount(sidecarStatusesAtom)

  const events: SidecarStatusEvent[] = []
  const tracker = createSidecarHealthTracker()

  const emit = (event: SidecarStatusEvent | undefined) => {
    if (event === undefined) {
      return
    }
    events.push(event)
    const next = deriveSidecarStatuses(events)
    if (areSidecarStatusesEqual(get.once(sidecarStatusesAtom), next)) {
      // No visible change — drop the event so the log cannot grow unbounded
      // while a service stays crashed.
      events.pop()
      return
    }
    get.set(sidecarStatusesAtom, next)
  }

  const pollAll = Effect.forEach(
    HEALTH_ENDPOINTS,
    ([name, endpoint]) =>
      Effect.map(
        // The fetch aborts itself after the timeout, but an endpoint that
        // ignores the signal must still count as a failure instead of
        // stalling every other service's poll.
        tryFetchHealth(endpoint).pipe(
          Effect.timeout(Duration.millis(HEALTH_FETCH_TIMEOUT_MS)),
          Effect.orElseSucceed(() => false)
        ),
        (ok) => emit(tracker.report(name, ok))
      ),
    { concurrency: 'unbounded', discard: true }
  )

  return Effect.suspend(() => {
    // Emit initial "starting" events for pollable services so the UI shows
    // yellow/starting instead of gray/unknown while we wait for the first
    // poll result.
    for (const [name] of HEALTH_ENDPOINTS) {
      emit({ name, state: 'starting' })
    }
    return pollWhileVisible(pollAll, SIDECAR_POLL_INTERVAL_MS)
  })
})
