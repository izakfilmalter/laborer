/**
 * Core Layers Test — Issues #13 + #14
 *
 * Verifies that the health check RPC works with only core
 * infrastructure layers, confirming the layer separation in main.ts
 * is correct. Deferred services are provided as placeholder proxies
 * (using the production makeServiceProxy) that return
 * SERVICE_INITIALIZING errors when invoked.
 *
 * Also verifies deferred RPCs return SERVICE_INITIALIZING errors.
 */

import { assert, describe, it } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { ConfigService } from '../../src/services/config-service.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeServiceProxy,
  SERVICE_INITIALIZING_CODE,
} from '../../src/services/deferred-service.js'
import { FileService } from '../../src/services/file-service.js'
import { GithubPullRequests } from '../../src/services/github-pull-requests.js'
import { GithubViewer } from '../../src/services/github-viewer.js'
import { LaborerDatabase } from '../../src/services/laborer-database.js'
import { OpenCodeModels } from '../../src/services/opencode-models.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../../src/services/workspace-sync-service.js'

/**
 * Placeholder proxy layers for all deferred services.
 *
 * Uses the production makeServiceProxy from deferred-service.ts.
 * Each proxy returns RpcError with SERVICE_INITIALIZING code for all
 * method calls.
 *
 * This matches the behavior of the production DeferredServicesProxyLive
 * layer before the background fiber completes initialization.
 */
const DeferredServiceStubs = Layer.mergeAll(
  Layer.succeed(ProjectRegistry, makeServiceProxy('ProjectRegistry')),
  Layer.succeed(WorkspaceProvider, makeServiceProxy('WorkspaceProvider')),
  Layer.succeed(FileService, makeServiceProxy('FileService')),
  Layer.succeed(PrWatcher, makeServiceProxy('PrWatcher')),
  Layer.succeed(WorkspaceSyncService, makeServiceProxy('WorkspaceSyncService')),
  Layer.succeed(TerminalClient, makeServiceProxy('TerminalClient'))
)

/**
 * Core-only test layer: LaborerRpcsLive with only core infrastructure
 * layers (ConfigService, LaborerDatabase) and placeholder proxy
 * implementations for all deferred services.
 *
 * This proves the health endpoint responds without building any
 * deferred services — terminal and file-watcher sidecars are placeholders.
 */
const CoreOnlyRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(DeferredServiceStubs),
  Layer.provide(DeferredServicesReadyLayer),
  Layer.provide(ConfigService.layer),
  // Stubbed rather than built: the real service shells out to `gh`, and this
  // suite proves the core layers stand up without touching the network.
  Layer.provide(Layer.succeed(GithubViewer)({ login: Effect.succeed(null) })),
  Layer.provide(
    Layer.succeed(GithubPullRequests)({ list: () => Effect.succeed([]) })
  ),
  Layer.provide(
    Layer.succeed(OpenCodeModels)({ list: () => Effect.succeed([]) })
  ),
  Layer.provide(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

const CoreOnlyRpcClient = RpcTest.makeClient(LaborerRpcs).pipe(
  Effect.provide(CoreOnlyRpcLayer)
)

describe('Core layers (Issue #13)', () => {
  it.effect('health.check responds with only core layers', () =>
    Effect.gen(function* () {
      const client = yield* CoreOnlyRpcClient
      const response = yield* client['health.check']()

      assert.strictEqual(response.status, 'ok')
      assert.isTrue(Number.isFinite(response.uptime))
      assert.isTrue(response.uptime >= 0)
    })
  )

  it.effect('server starts without terminal or file-watcher sidecars', () =>
    Effect.gen(function* () {
      // This test proves the RPC layer can be built and serve health
      // checks without the terminal or file-watcher sidecars running.
      // The CoreOnlyRpcLayer doesn't include TerminalClient.layer or
      // FileWatcherClient.layer — only placeholder proxies.
      const client = yield* CoreOnlyRpcClient
      const response = yield* client['health.check']()

      assert.strictEqual(response.status, 'ok')
    })
  )

  it.effect('database-backed core RPCs work with only core layers', () =>
    Effect.gen(function* () {
      const client = yield* CoreOnlyRpcClient

      // Building and serving the core RPC proves the database layer is
      // available without any deferred services.
      const response = yield* client['health.check']()
      assert.isTrue(response.uptime >= 0)
    })
  )
})

describe('Deferred service proxies (Issue #14)', () => {
  it.effect(
    'deferred service RPC returns SERVICE_INITIALIZING error before init',
    () =>
      Effect.gen(function* () {
        const client = yield* CoreOnlyRpcClient

        // Calling a deferred-service RPC should fail with
        // SERVICE_INITIALIZING error, not a defect or missing service.
        const result = yield* client['project.list']().pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (error) => Effect.succeed(error),
          })
        )

        if (result === 'success') {
          assert.fail('Expected project.list to fail with SERVICE_INITIALIZING')
        }
        assert.strictEqual(result._tag, 'RpcError')
        assert.strictEqual(result.code, SERVICE_INITIALIZING_CODE)
        assert.include(result.message, 'still initializing')
      })
  )

  it.effect(
    'core RPCs continue working regardless of deferred service state',
    () =>
      Effect.gen(function* () {
        const client = yield* CoreOnlyRpcClient

        // health.check is a core RPC — it should always work,
        // even when all deferred services return SERVICE_INITIALIZING.
        const response = yield* client['health.check']()
        assert.strictEqual(response.status, 'ok')
      })
  )
})

// ---------------------------------------------------------------------------
// Lifecycle init status RPC (Issue #15)
// ---------------------------------------------------------------------------

/**
 * Layer that exposes both the RPC client and the DeferredServicesReady Ref,
 * so tests can verify the relationship between the Ref state and the RPC
 * response. Uses provideMerge for DeferredServicesReadyLayer so it appears
 * in the output context for extraction.
 */
const CoreOnlyRpcWithReadyRefLayer = LaborerRpcsLive.pipe(
  Layer.provide(DeferredServiceStubs),
  Layer.provideMerge(DeferredServicesReadyLayer),
  Layer.provide(ConfigService.layer),
  Layer.provide(Layer.succeed(GithubViewer)({ login: Effect.succeed(null) })),
  Layer.provide(
    Layer.succeed(GithubPullRequests)({ list: () => Effect.succeed([]) })
  ),
  Layer.provide(
    Layer.succeed(OpenCodeModels)({ list: () => Effect.succeed([]) })
  ),
  Layer.provide(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

const makeScopedInitStatusContext = Effect.gen(function* () {
  const context = yield* Layer.build(CoreOnlyRpcWithReadyRefLayer)
  const client = yield* RpcTest.makeClient(LaborerRpcs).pipe(
    Effect.provide(Layer.succeedContext(context))
  )
  const { ref: readyRef } = Context.get(context, DeferredServicesReady)
  return { client, readyRef }
})

describe('Lifecycle init status (Issue #15)', () => {
  it.effect(
    'lifecycle.initStatus stream emits { ready: false } initially',
    () =>
      Effect.gen(function* () {
        const { client } = yield* makeScopedInitStatusContext

        // The stream emits the current readiness state immediately.
        // Since no one has set the ref to true, the first item is false.
        const first = yield* client['lifecycle.initStatus']().pipe(
          Stream.take(1),
          Stream.runHead
        )
        const result = Option.getOrThrow(first)

        assert.strictEqual(result.ready, false)
      })
  )

  it.effect(
    'lifecycle.initStatus stream completes with { ready: true } after deferred services init',
    () =>
      Effect.gen(function* () {
        const { client, readyRef } = yield* makeScopedInitStatusContext

        // Fork the stream collection before setting the ref.
        // The stream uses takeUntil(ready), so it will collect
        // [{ ready: false }, { ready: true }] then complete.
        const fiber = yield* client['lifecycle.initStatus']().pipe(
          Stream.runCollect,
          Effect.forkChild
        )

        // Simulate background fiber completing deferred initialization
        yield* SubscriptionRef.set(readyRef, true)

        const items = yield* Fiber.join(fiber)

        assert.isTrue(items.length >= 1)
        assert.strictEqual(items.at(-1)?.ready, true)
      })
  )

  it.effect('lifecycle.initStatus works alongside other core RPCs', () =>
    Effect.gen(function* () {
      const { client } = yield* makeScopedInitStatusContext

      // Both core RPCs should work in the same session
      const health = yield* client['health.check']()
      const first = yield* client['lifecycle.initStatus']().pipe(
        Stream.take(1),
        Stream.runHead
      )
      const initStatus = Option.getOrThrow(first)

      assert.strictEqual(health.status, 'ok')
      assert.strictEqual(initStatus.ready, false)
    })
  )
})
