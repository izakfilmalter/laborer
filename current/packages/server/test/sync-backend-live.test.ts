import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcTest } from '@effect/rpc'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Option, Queue, Stream, TestClock } from 'effect'
import { afterAll } from 'vitest'
import type { SyncPullResponse } from '../src/services/sync-backend.js'
import {
  makeSyncBackendServiceLayer,
  SyncBackendService,
  SyncRpcHandlersLive,
  SyncWsRpc,
} from '../src/services/sync-backend.js'

const STORE_ID = 'laborer'

const tempDirs: string[] = []

afterAll(() => {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

const makeTestLayer = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'laborer-sync-live-'))
  tempDirs.push(dataDir)
  return SyncRpcHandlersLive.pipe(
    Layer.provideMerge(
      makeSyncBackendServiceLayer({ dataDir, storeId: STORE_ID })
    )
  )
}

/**
 * Polls until `check` succeeds with true, yielding between checks. Fails
 * the test if it never becomes true (bounded retries instead of an
 * unbounded hang).
 */
const MAX_POLL_ITERATIONS = 1000

const waitUntilEffect = (check: Effect.Effect<boolean>) =>
  Effect.iterate(
    { done: false, iteration: 0 },
    {
      while: (state) => !state.done && state.iteration < MAX_POLL_ITERATIONS,
      body: (state) =>
        Effect.yieldNow().pipe(
          Effect.zipRight(check),
          Effect.map((done) => ({ done, iteration: state.iteration + 1 }))
        ),
    }
  ).pipe(
    Effect.tap((state) =>
      state.done
        ? Effect.void
        : Effect.dieMessage('waitUntilEffect: condition never became true')
    )
  )

const waitUntil = (predicate: () => boolean) =>
  waitUntilEffect(Effect.sync(predicate))

const makeEvent = (seqNum: number, parentSeqNum: number) => ({
  args: {
    id: `project-${String(seqNum)}`,
    name: `Project ${String(seqNum)}`,
    repoPath: `/repo/${String(seqNum)}`,
  },
  clientId: 'client-1',
  name: 'v1.ProjectCreated',
  parentSeqNum,
  seqNum,
  sessionId: 'session-1',
})

/**
 * Subscribes to a live pull and pipes every response into a queue so the
 * test can await responses deterministically.
 */
const subscribeLivePull = Effect.fn('subscribeLivePull')(function* (client: {
  SyncWsRpc: {
    Pull: (payload: {
      storeId: string
      live: boolean
      cursor: Option.Option<{ backendId: string; eventSequenceNumber: number }>
    }) => Stream.Stream<SyncPullResponse, unknown>
  }
}) {
  const received = yield* Queue.unbounded<SyncPullResponse>()
  yield* client.SyncWsRpc.Pull({
    cursor: Option.none(),
    live: true,
    storeId: STORE_ID,
  }).pipe(
    Stream.runForEach((res) => Queue.offer(received, res)),
    Effect.forkScoped
  )
  return received
})

describe('sync-backend live pull', () => {
  it.scoped('delivers events pushed after a live pull subscribes', () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(SyncWsRpc)

      const received = yield* subscribeLivePull(client)

      // Catch-up phase: store is empty, so the first response is an
      // empty batch. Receiving it proves the live subscription is active.
      const catchUp = yield* Queue.take(received)
      assert.deepStrictEqual([...catchUp.batch], [])

      yield* client.SyncWsRpc.Push({
        backendId: Option.none(),
        batch: [makeEvent(1, 0)],
        storeId: STORE_ID,
      })

      const live = yield* Queue.take(received)
      assert.strictEqual(live.batch.length, 1)
      assert.strictEqual(live.batch[0]?.eventEncoded.seqNum, 1)
      assert.strictEqual(live.batch[0]?.eventEncoded.name, 'v1.ProjectCreated')
    }).pipe(Effect.provide(makeTestLayer()))
  )

  it.scoped(
    'unregisters the subscriber when the live pull is interrupted and keeps accepting pushes',
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(SyncWsRpc)
        const service = yield* SyncBackendService

        const received = yield* Queue.unbounded<SyncPullResponse>()
        const pullFiber = yield* client.SyncWsRpc.Pull({
          cursor: Option.none(),
          live: true,
          storeId: STORE_ID,
        }).pipe(
          Stream.runForEach((res) => Queue.offer(received, res)),
          Effect.forkScoped
        )

        // Wait for the catch-up response — proves the subscriber is live.
        yield* Queue.take(received)
        assert.strictEqual(service.liveQueues.size, 1)

        yield* Fiber.interrupt(pullFiber)
        yield* waitUntil(() => service.liveQueues.size === 0)
        assert.strictEqual(service.liveQueues.size, 0)

        // Pushes after the subscriber is gone must still succeed.
        yield* client.SyncWsRpc.Push({
          backendId: Option.none(),
          batch: [makeEvent(1, 0)],
          storeId: STORE_ID,
        })
        assert.strictEqual(service.storage.getCurrentHead(), 1)
      }).pipe(Effect.provide(makeTestLayer()))
  )

  it.scoped(
    'emits recurring heartbeats on idle live pulls so clients can detect dead subscriptions',
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(SyncWsRpc)

        const received = yield* subscribeLivePull(client)

        // Catch-up phase completes first.
        const catchUp = yield* Queue.take(received)
        assert.deepStrictEqual([...catchUp.batch], [])

        // No pushes happen — after the heartbeat interval the subscriber
        // still receives an (empty) heartbeat response.
        yield* TestClock.adjust('20 seconds')
        yield* waitUntilEffect(
          Queue.size(received).pipe(Effect.map((size) => size >= 1))
        )
        const firstHeartbeat = yield* Queue.take(received)
        assert.deepStrictEqual([...firstHeartbeat.batch], [])

        // Heartbeats recur.
        yield* TestClock.adjust('20 seconds')
        yield* waitUntilEffect(
          Queue.size(received).pipe(Effect.map((size) => size >= 1))
        )
        const secondHeartbeat = yield* Queue.take(received)
        assert.deepStrictEqual([...secondHeartbeat.batch], [])
      }).pipe(Effect.provide(makeTestLayer()))
  )
})
