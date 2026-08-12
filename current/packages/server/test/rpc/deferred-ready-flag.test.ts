/**
 * Deferred Services Ready Flag — Integration Test
 *
 * Verifies that when all deferred services are built and available,
 * `lifecycle.initStatus` returns `{ ready: true }`.
 *
 * The bug: `utility-main.ts` forks two background fibers (service stack +
 * TerminalClient) but never calls `Ref.set(ready.ref, true)` when both
 * complete. The `lifecycle.initStatus` handler reads this ref and always
 * returns `{ ready: false }`, leaving the client stuck in "Loading files..."
 *
 * The fix has two parts:
 * 1. `utility-main.ts` must set `DeferredServicesReady` to `true` after
 *    both forked fibers complete
 * 2. The `TestLaborerRpcLayer` (which builds services eagerly) must also
 *    set the ready flag to `true` so integration tests reflect production
 *    behavior
 *
 * @see utility-main.ts — DeferredServicesProxyLive (lines 349-544)
 * @see Issue #15: Server "fully initialized" event
 * @see File tree git status: DeferredServicesReady never set to true
 */

import { assert, describe, it } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Effect, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { TestLaborerRpcLayer } from './test-layer.js'

describe('DeferredServicesReady flag (file-tree-git-status)', () => {
  /**
   * This test verifies the end-to-end behavior: when all deferred
   * services are fully initialized, `lifecycle.initStatus` should
   * return `{ ready: true }`.
   *
   * TestLaborerRpcLayer builds all services eagerly (no deferred proxy),
   * so it represents the state AFTER deferred initialization completes.
   * The ready flag should reflect this.
   *
   * EXPECTED: FAIL (RED) — TestLaborerRpcLayer uses DeferredServicesReadyLayer
   * which starts at `false` and is never set to `true`.
   */
  it.effect(
    'lifecycle.initStatus stream emits ready=true when all services are built',
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(LaborerRpcs).pipe(
          Effect.provide(TestLaborerRpcLayer)
        )

        // The stream uses takeUntil(ready), so when DeferredServicesReady
        // starts at true (as in TestLaborerRpcLayer), the stream emits
        // [{ ready: true }] and completes immediately.
        const items = yield* client['lifecycle.initStatus']().pipe(
          Stream.runCollect
        )

        // All services are built and available — the stream should emit
        // ready=true so the client advances to LifecyclePhase.Eventually
        // and the file tree becomes visible.
        assert.isTrue(items.length >= 1)
        assert.strictEqual(items.at(-1)?.ready, true)
      })
  )
})
