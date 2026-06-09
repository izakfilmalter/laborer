import { assert, describe, it } from '@effect/vitest'
import { Effect, Option, Queue, Stream, TestClock } from 'effect'
import { withLivePullWatchdog } from '../src/live-pull-watchdog.js'

interface TestPage {
  readonly batch: readonly {
    readonly eventEncoded: { readonly seqNum: number }
    readonly metadata: Option.Option<unknown>
  }[]
  readonly pageInfo: { readonly _tag: string }
}

const makePage = (seqNums: readonly number[]): TestPage => ({
  batch: seqNums.map((seqNum) => ({
    eventEncoded: { seqNum },
    metadata: Option.none(),
  })),
  pageInfo: { _tag: 'NoMore' },
})

const cursorFromPage = (page: TestPage): Option.Option<number> => {
  const lastEvent = page.batch.at(-1)
  return lastEvent === undefined
    ? Option.none()
    : Option.some(lastEvent.eventEncoded.seqNum)
}

/**
 * Sequence numbers of the page at `index`, or undefined when no page was
 * delivered at that position — keeps assertions free of non-null
 * assertions while still failing loudly on missing pages.
 */
const pageSeqNumsAt = (
  pages: readonly TestPage[],
  index: number
): readonly number[] | undefined =>
  pages[index]?.batch.map((item) => item.eventEncoded.seqNum)

/**
 * Polls until `predicate` holds, yielding between checks. Fails the test
 * if it never becomes true (bounded retries instead of an unbounded hang).
 */
const MAX_POLL_ITERATIONS = 1000

const waitUntil = (predicate: () => boolean) =>
  Effect.iterate(0, {
    body: (iteration) => Effect.yieldNow().pipe(Effect.as(iteration + 1)),
    while: (iteration) => !predicate() && iteration < MAX_POLL_ITERATIONS,
  }).pipe(
    Effect.tap((iterations) =>
      iterations < MAX_POLL_ITERATIONS
        ? Effect.void
        : Effect.dieMessage('waitUntil: condition never became true')
    )
  )

describe('withLivePullWatchdog', () => {
  it.effect(
    're-pulls from the last seen cursor when a live pull goes silent past the timeout',
    () =>
      Effect.gen(function* () {
        const pullCursors: Option.Option<number>[] = []

        const pull = (
          cursor: Option.Option<number>,
          _options?: { live?: boolean }
        ): Stream.Stream<TestPage> => {
          pullCursors.push(cursor)
          // First subscription delivers one event then goes silent
          // (simulating the server-side live queue being dropped).
          // The re-pull delivers the missed event and stays healthy.
          return pullCursors.length === 1
            ? Stream.concat(Stream.make(makePage([1])), Stream.never)
            : Stream.concat(Stream.make(makePage([2])), Stream.never)
        }

        const wrappedPull = withLivePullWatchdog({
          cursorFromPage,
          pull,
          silenceTimeoutMs: 60_000,
        })

        const received: TestPage[] = []
        yield* wrappedPull(Option.none(), { live: true }).pipe(
          Stream.runForEach((page) =>
            Effect.sync(() => {
              received.push(page)
            })
          ),
          Effect.fork
        )

        yield* waitUntil(() => received.length === 1)
        assert.deepStrictEqual(pageSeqNumsAt(received, 0), [1])

        // Silence: no events, no heartbeats. The watchdog must tear the
        // pull down and resubscribe from the last seen cursor.
        yield* TestClock.adjust('60 seconds')
        yield* waitUntil(() => received.length === 2)

        assert.deepStrictEqual(pullCursors, [Option.none(), Option.some(1)])
        assert.deepStrictEqual(pageSeqNumsAt(received, 1), [2])
      })
  )

  it.effect(
    'heartbeats keep the live pull alive and are filtered from downstream',
    () =>
      Effect.gen(function* () {
        const pullCursors: Option.Option<number>[] = []
        const pages = yield* Queue.unbounded<TestPage>()

        const pull = (
          cursor: Option.Option<number>,
          _options?: { live?: boolean }
        ): Stream.Stream<TestPage> => {
          pullCursors.push(cursor)
          return Stream.fromQueue(pages)
        }

        const wrappedPull = withLivePullWatchdog({
          cursorFromPage,
          pull,
          silenceTimeoutMs: 60_000,
        })

        const received: TestPage[] = []
        yield* wrappedPull(Option.none(), { live: true }).pipe(
          Stream.runForEach((page) =>
            Effect.sync(() => {
              received.push(page)
            })
          ),
          Effect.fork
        )

        yield* Queue.offer(pages, makePage([1]))
        yield* waitUntil(() => received.length === 1)

        // 50s of silence, then a heartbeat — under the 60s timeout.
        yield* TestClock.adjust('50 seconds')
        yield* Queue.offer(pages, makePage([]))
        yield* waitUntil(() => Effect.runSync(Queue.size(pages)) === 0)

        // Another 50s of silence. Total silence since the last real event
        // is 100s, but the heartbeat reset the watchdog — no resubscribe.
        yield* TestClock.adjust('50 seconds')
        yield* Queue.offer(pages, makePage([2]))
        yield* waitUntil(() => received.length >= 2)

        assert.deepStrictEqual(pullCursors, [Option.none()])
        // The heartbeat (empty page) was filtered: downstream saw only
        // the two real event pages.
        assert.strictEqual(received.length, 2)
        assert.deepStrictEqual(pageSeqNumsAt(received, 0), [1])
        assert.deepStrictEqual(pageSeqNumsAt(received, 1), [2])
      })
  )

  it.effect(
    'delivers the initial empty catch-up page but filters later empty pages',
    () =>
      Effect.gen(function* () {
        const pages = yield* Queue.unbounded<TestPage>()

        const pull = (
          _cursor: Option.Option<number>,
          _options?: { live?: boolean }
        ): Stream.Stream<TestPage> => Stream.fromQueue(pages)

        const wrappedPull = withLivePullWatchdog({
          cursorFromPage,
          pull,
          silenceTimeoutMs: 60_000,
        })

        const received: TestPage[] = []
        yield* wrappedPull(Option.none(), { live: true }).pipe(
          Stream.runForEach((page) =>
            Effect.sync(() => {
              received.push(page)
            })
          ),
          Effect.fork
        )

        // Empty store: the server's catch-up phase emits a single empty
        // page so the client knows catch-up completed. It must reach the
        // consumer.
        yield* Queue.offer(pages, makePage([]))
        yield* waitUntil(() => received.length === 1)
        assert.deepStrictEqual(pageSeqNumsAt(received, 0), [])

        // A heartbeat after the catch-up is filtered.
        yield* TestClock.adjust('20 seconds')
        yield* Queue.offer(pages, makePage([]))
        yield* waitUntil(() => Effect.runSync(Queue.size(pages)) === 0)

        yield* Queue.offer(pages, makePage([1]))
        yield* waitUntil(() => received.length >= 2)

        assert.strictEqual(received.length, 2)
        assert.deepStrictEqual(pageSeqNumsAt(received, 1), [1])
      })
  )

  it.effect('passes non-live pulls through untouched', () =>
    Effect.gen(function* () {
      const pullCursors: Option.Option<number>[] = []

      const pull = (
        cursor: Option.Option<number>,
        _options?: { live?: boolean }
      ): Stream.Stream<TestPage> => {
        pullCursors.push(cursor)
        return Stream.make(makePage([1]), makePage([]))
      }

      const wrappedPull = withLivePullWatchdog({
        cursorFromPage,
        pull,
        silenceTimeoutMs: 60_000,
      })

      const pages = yield* wrappedPull(Option.none()).pipe(Stream.runCollect)

      // Non-live pulls are finite catch-up reads — no watchdog, no
      // filtering, every page (including empty ones) passes through.
      assert.strictEqual([...pages].length, 2)
      assert.deepStrictEqual(pullCursors, [Option.none()])
    })
  )
})
