/**
 * Page-visibility primitives for pausing background polling.
 *
 * Status polls that only feed advisory UI should not burn CPU while the
 * window is hidden. `pageVisibleAtom` is the shared "is the page visible"
 * signal, and `pollWhileVisible` turns any poll effect into a loop that
 * pauses while hidden and refreshes immediately when visibility returns.
 */

import { Duration, Effect, Fiber, Stream } from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'

/**
 * Whether the document is currently visible. Kept alive so the single DOM
 * listener pair survives across poll iterations instead of churning
 * subscribe/unsubscribe every interval. Environments without a `document`
 * (SSR, workers) are treated as always visible.
 */
export const pageVisibleAtom: Atom.Atom<boolean> = Atom.readable<boolean>(
  (get) => {
    if (typeof document === 'undefined') {
      return true
    }
    const update = () => {
      get.setSelf(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    get.addFinalizer(() => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
    })
    return document.visibilityState === 'visible'
  }
).pipe(Atom.keepAlive)

/** Resolves once the page is visible; immediately when it already is. */
const awaitPageVisible: Effect.Effect<void, never, AtomRegistry.AtomRegistry> =
  Atom.toStream(pageVisibleAtom).pipe(
    Stream.filter((visible) => visible),
    Stream.take(1),
    Stream.runDrain
  )

/**
 * Resolves when the page transitions hidden → visible. Never resolves while
 * the page stays visible, so racing it against a sleep leaves the sleep in
 * charge on the happy path.
 */
const pageBecameVisible: Effect.Effect<void, never, AtomRegistry.AtomRegistry> =
  Atom.toStream(pageVisibleAtom).pipe(
    Stream.dropWhile((visible) => visible),
    Stream.filter((visible) => visible),
    Stream.take(1),
    Stream.runDrain
  )

/**
 * Run `poll` immediately, then at a fixed `intervalMs` rate while the page is
 * visible. The tick starts alongside the poll, so slow polls do not stretch
 * the period, and polls never overlap.
 *
 * While the document is hidden the loop parks without timers; when it becomes
 * visible again the next poll fires immediately, even mid-interval. The
 * visible-path check is synchronous so polls are not delayed by stream
 * scheduling. Callers own error handling: a failing `poll` fails the loop.
 */
export const pollWhileVisible = <A, E, R>(
  poll: Effect.Effect<A, E, R>,
  intervalMs: number
): Effect.Effect<never, E, R | AtomRegistry.AtomRegistry> =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    while (true) {
      if (!registry.get(pageVisibleAtom)) {
        yield* awaitPageVisible
      }
      const tick = yield* Effect.forkChild(
        Effect.race(
          Effect.sleep(Duration.millis(intervalMs)),
          pageBecameVisible
        )
      )
      yield* poll
      yield* Fiber.join(tick)
    }
  })
