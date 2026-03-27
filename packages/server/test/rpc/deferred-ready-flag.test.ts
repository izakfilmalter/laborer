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

import { RpcTest } from '@effect/rpc'
import { assert, describe, it } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Effect } from 'effect'
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
  it.scoped(
    'lifecycle.initStatus returns ready=true when all services are built',
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(LaborerRpcs).pipe(
          Effect.provide(TestLaborerRpcLayer)
        )

        const result = yield* client.lifecycle.initStatus()

        // All services are built and available — the RPC should report
        // ready=true so the client advances to LifecyclePhase.Eventually
        // and the file tree becomes visible.
        assert.strictEqual(result.ready, true)
      })
  )
})
