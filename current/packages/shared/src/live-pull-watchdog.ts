/**
 * Live-pull watchdog for LiveStore sync backends.
 *
 * Detects the "silent live-pull drop" failure mode: the server-side live
 * subscription dies (its events stop flowing) while the underlying
 * transport stays open, so the client's connection-level ping keeps
 * succeeding and nothing notices that sync is frozen.
 *
 * The sync backend emits heartbeat responses on live pull streams at a
 * fixed interval (see `SYNC_HEARTBEAT_INTERVAL_MS` in the server's
 * sync-backend service). This wrapper watches the live pull stream for
 * silence: if no element (event batch or heartbeat) arrives within
 * `silenceTimeoutMs`, it tears the pull down and resubscribes from the
 * last cursor it has seen, so missed events are caught up.
 */

import { Duration, Effect, Option, Ref, Stream } from 'effect'

interface LivePullPageLike {
  readonly batch: readonly unknown[]
}

interface LivePullWatchdogOptions<A extends LivePullPageLike, TCursor, E, R> {
  /**
   * Derives a resume cursor from a delivered page. Returns `None` for
   * pages with no events (e.g. heartbeats), in which case the previous
   * cursor is kept.
   */
  readonly cursorFromPage: (page: A) => Option.Option<TCursor>
  /** Invoked before each watchdog-triggered resubscribe (e.g. logging). */
  readonly onSilenceTimeout?: (cursor: Option.Option<TCursor>) => void
  /** The underlying sync backend pull function being wrapped. */
  readonly pull: (
    cursor: Option.Option<TCursor>,
    options?: { readonly live?: boolean }
  ) => Stream.Stream<A, E, R>
  /**
   * Maximum time without any stream element before the live pull is
   * considered dead and resubscribed. Must be comfortably larger than
   * the server's heartbeat interval.
   */
  readonly silenceTimeoutMs: number
}

/**
 * Wraps a sync backend `pull` function with silence detection on live
 * pulls. Non-live pulls (finite catch-up reads) pass through untouched.
 */
const withLivePullWatchdog =
  <A extends LivePullPageLike, TCursor, E, R>(
    options: LivePullWatchdogOptions<A, TCursor, E, R>
  ) =>
  (
    cursor: Option.Option<TCursor>,
    pullOptions?: { readonly live?: boolean }
  ): Stream.Stream<A, E, R> => {
    if (pullOptions?.live !== true) {
      return options.pull(cursor, pullOptions)
    }

    const silenceTimeout = Duration.millis(options.silenceTimeoutMs)

    return Stream.unwrap(
      Effect.gen(function* () {
        const lastCursor = yield* Ref.make(cursor)
        const anyPageDelivered = yield* Ref.make(false)

        const trackCursor = (page: A) =>
          Option.match(options.cursorFromPage(page), {
            onNone: () => Effect.void,
            onSome: (pageCursor) =>
              Ref.set(lastCursor, Option.some(pageCursor)),
          })

        const resubscribe: Stream.Stream<A, E, R> = Stream.unwrap(
          Ref.get(lastCursor).pipe(
            Effect.map((resumeCursor) => {
              options.onSilenceTimeout?.(resumeCursor)
              return pullWithWatchdog(resumeCursor)
            })
          )
        )

        const pullWithWatchdog = (
          from: Option.Option<TCursor>
        ): Stream.Stream<A, E, R> =>
          options
            .pull(from, pullOptions)
            .pipe(
              Stream.tap(trackCursor),
              Stream.timeoutTo(silenceTimeout, resubscribe)
            )

        // Heartbeats are a transport-liveness concern only — they reset
        // the watchdog above but must not reach the sync consumer. The
        // very first page is always delivered: an empty store's catch-up
        // phase emits a single empty page that signals catch-up completed.
        return pullWithWatchdog(cursor).pipe(
          Stream.filterEffect((page) =>
            Ref.getAndSet(anyPageDelivered, true).pipe(
              Effect.map(
                (alreadyDelivered) => page.batch.length > 0 || !alreadyDelivered
              )
            )
          )
        )
      })
    )
  }

export type { LivePullWatchdogOptions }
export { withLivePullWatchdog }
