/**
 * Freshness for the pull request panel, carried over from the retired
 * comments pane: GitHub has no local watcher to subscribe to, so the panel
 * re-reads on an interval while it is visible and widens after
 * consecutive failures.
 *
 * Polling costs GitHub API requests against a 5,000/hour budget shared
 * with the rest of the app, so the loop only runs while the document is
 * visible.
 */
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { useEffect, useRef, useState } from 'react'

/** How often the panel re-reads while open and visible. */
export const POLL_INTERVAL_MS = 30_000

/**
 * The widest the poll interval may grow after repeated failures. A revoked
 * token fails every time; five minutes still notices when it is fixed.
 */
const MAX_POLL_INTERVAL_MS = 300_000

/** How long to wait before the next read, given the failures since the last success. */
export const pollIntervalFor = (consecutiveFailures: number) =>
  Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_POLL_INTERVAL_MS)

/** How often the rendered ages tick, so "just now" does not go stale. */
const CLOCK_INTERVAL_MS = 60_000

/**
 * A clock that ticks slowly enough to be free and often enough that a
 * rendered age is never more than a minute wrong.
 */
export function useSlowClock(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return now
}

/**
 * Re-reads on a cadence GitHub can afford. A hidden document is not being
 * read by anyone, so the loop stops until the panel is looked at again;
 * returning to a panel that went stale meanwhile reads immediately. A run
 * of failures widens the gap.
 */
export function usePolledRefresh(
  refresh: () => void,
  failureStreak: number
): void {
  // Held in a ref so a new function identity per render does not restart
  // the loop; the interval is a dependency because a changed cadence
  // means an outcome just landed and the countdown should start over.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const interval = pollIntervalFor(failureStreak)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastReadAt = Date.now()

    const stop = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const scheduleIn = (delay: number) => {
      stop()
      timer = setTimeout(() => {
        lastReadAt = Date.now()
        refreshRef.current()
        scheduleIn(interval)
      }, delay)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      // Resume where the loop left off: a panel hidden past its interval
      // owes the reader a read now, one hidden briefly does not.
      scheduleIn(Math.max(interval - (Date.now() - lastReadAt), 0))
    }

    if (document.visibilityState !== 'hidden') {
      scheduleIn(interval)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [interval])
}

/**
 * How many reads in a row have failed since the last one that worked.
 * Only settled reads count: a refresh in flight still carries the previous
 * outcome, and counting that would double every failure.
 */
export function useFailureStreak(
  result: Result.AsyncResult<unknown, unknown>
): number {
  const [streak, setStreak] = useState(0)
  const isFailure = Result.isFailure(result)

  useEffect(() => {
    if (result.waiting) {
      return
    }
    setStreak((previous) => (isFailure ? previous + 1 : 0))
  }, [result, isFailure])

  return streak
}
