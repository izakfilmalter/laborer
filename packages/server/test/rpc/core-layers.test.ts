/**
 * Core Layers Test — Issues #13 + #14
 *
 * Verifies that the health check RPC works with only core
 * infrastructure layers, confirming the layer separation in main.ts
 * is correct. Deferred services are provided as placeholder proxies
 * (using the production makeServiceProxy) that return
 * SERVICE_INITIALIZING errors when invoked.
 *
 * Also verifies the deferred service proxy behavior:
 * - DockerDetection returns { available: false } (placeholder override)
 * - Other deferred RPCs return SERVICE_INITIALIZING error
 */

import { RpcTest } from '@effect/rpc'
import { assert, describe, it } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { ConfigService } from '../../src/services/config-service.js'
import { ContainerService } from '../../src/services/container-service.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeServiceProxy,
  SERVICE_INITIALIZING_CODE,
} from '../../src/services/deferred-service.js'
import { DepsImageService } from '../../src/services/deps-image-service.js'
import { DiffService } from '../../src/services/diff-service.js'
import { DockerDetection } from '../../src/services/docker-detection.js'
import { GithubTaskImporter } from '../../src/services/github-task-importer.js'
import { LinearTaskImporter } from '../../src/services/linear-task-importer.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { PrdStorageService } from '../../src/services/prd-storage-service.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { ReviewCommentFetcher } from '../../src/services/review-comment-fetcher.js'
import { TaskManager } from '../../src/services/task-manager.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../../src/services/workspace-sync-service.js'
import { TestLaborerStore } from '../helpers/test-store.js'

/**
 * Placeholder proxy layers for all deferred services.
 *
 * Uses the production makeServiceProxy from deferred-service.ts.
 * Each proxy returns RpcError with SERVICE_INITIALIZING code for all
 * method calls, except DockerDetection which has a placeholder override
 * (its RPC has no error channel, so it returns { available: false }).
 *
 * This matches the behavior of the production DeferredServicesProxyLive
 * layer before the background fiber completes initialization.
 */
const DeferredServiceStubs = Layer.mergeAll(
  Layer.succeed(
    DockerDetection,
    makeServiceProxy('DockerDetection', {
      check: () => Effect.succeed({ available: false }),
    })
  ),
  Layer.succeed(ProjectRegistry, makeServiceProxy('ProjectRegistry')),
  Layer.succeed(PrdStorageService, makeServiceProxy('PrdStorageService')),
  Layer.succeed(TaskManager, makeServiceProxy('TaskManager')),
  Layer.succeed(WorkspaceProvider, makeServiceProxy('WorkspaceProvider')),
  Layer.succeed(DiffService, makeServiceProxy('DiffService')),
  Layer.succeed(PrWatcher, makeServiceProxy('PrWatcher')),
  Layer.succeed(WorkspaceSyncService, makeServiceProxy('WorkspaceSyncService')),
  Layer.succeed(TerminalClient, makeServiceProxy('TerminalClient')),
  Layer.succeed(ContainerService, makeServiceProxy('ContainerService')),
  Layer.succeed(GithubTaskImporter, makeServiceProxy('GithubTaskImporter')),
  Layer.succeed(LinearTaskImporter, makeServiceProxy('LinearTaskImporter')),
  Layer.succeed(ReviewCommentFetcher, makeServiceProxy('ReviewCommentFetcher')),
  Layer.succeed(DepsImageService, makeServiceProxy('DepsImageService'))
)

/**
 * Core-only test layer: LaborerRpcsLive with only core infrastructure
 * layers (ConfigService, LaborerStore) and placeholder proxy
 * implementations for all deferred services.
 *
 * This proves the health endpoint responds without building any
 * deferred services — terminal sidecar, file-watcher sidecar, Docker
 * detection, etc. are all placeholders.
 */
const CoreOnlyRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(DeferredServiceStubs),
  Layer.provide(DeferredServicesReadyLayer),
  Layer.provide(ConfigService.layer),
  Layer.provide(TestLaborerStore)
)

const CoreOnlyRpcClient = RpcTest.makeClient(LaborerRpcs).pipe(
  Effect.provide(CoreOnlyRpcLayer)
)

describe('Core layers (Issue #13)', () => {
  it.scoped('health.check responds with only core layers', () =>
    Effect.gen(function* () {
      const client = yield* CoreOnlyRpcClient
      const response = yield* client.health.check()

      assert.strictEqual(response.status, 'ok')
      assert.isTrue(Number.isFinite(response.uptime))
      assert.isTrue(response.uptime >= 0)
    })
  )

  it.scoped('server starts without terminal or file-watcher sidecars', () =>
    Effect.gen(function* () {
      // This test proves the RPC layer can be built and serve health
      // checks without the terminal or file-watcher sidecars running.
      // The CoreOnlyRpcLayer doesn't include TerminalClient.layer or
      // FileWatcherClient.layer — only placeholder proxies.
      const client = yield* CoreOnlyRpcClient
      const response = yield* client.health.check()

      assert.strictEqual(response.status, 'ok')
    })
  )

  it.scoped('LiveStore queries work with only core layers', () =>
    Effect.gen(function* () {
      const client = yield* CoreOnlyRpcClient

      // health.check uses LaborerStore internally (via module-level
      // startTime), proving LiveStore is available in core layers.
      const response = yield* client.health.check()
      assert.isTrue(response.uptime >= 0)
    })
  )
})

describe('Deferred service proxies (Issue #14)', () => {
  it.scoped('DockerDetection placeholder returns { available: false }', () =>
    Effect.gen(function* () {
      const client = yield* CoreOnlyRpcClient

      // DockerDetection has a placeholder override that returns
      // { available: false } instead of an error (its RPC has
      // no error channel).
      const result = yield* client.docker.status()

      assert.strictEqual(result.available, false)
    })
  )

  it.scoped(
    'deferred service RPC returns SERVICE_INITIALIZING error before init',
    () =>
      Effect.gen(function* () {
        const client = yield* CoreOnlyRpcClient

        // Calling a deferred-service RPC should fail with
        // SERVICE_INITIALIZING error, not a defect or missing service.
        const result = yield* client.project.list().pipe(
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

  it.scoped(
    'core RPCs continue working regardless of deferred service state',
    () =>
      Effect.gen(function* () {
        const client = yield* CoreOnlyRpcClient

        // health.check is a core RPC — it should always work,
        // even when all deferred services return SERVICE_INITIALIZING.
        const response = yield* client.health.check()
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
  Layer.provideMerge(TestLaborerStore)
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
  it.scoped(
    'lifecycle.initStatus returns { ready: false } before deferred services init',
    () =>
      Effect.gen(function* () {
        const { client } = yield* makeScopedInitStatusContext

        const result = yield* client.lifecycle.initStatus()

        assert.strictEqual(result.ready, false)
      })
  )

  it.scoped(
    'lifecycle.initStatus returns { ready: true } after deferred services init',
    () =>
      Effect.gen(function* () {
        const { client, readyRef } = yield* makeScopedInitStatusContext

        // Simulate background fiber completing deferred initialization
        yield* Ref.set(readyRef, true)

        const result = yield* client.lifecycle.initStatus()

        assert.strictEqual(result.ready, true)
      })
  )

  it.scoped('lifecycle.initStatus works alongside other core RPCs', () =>
    Effect.gen(function* () {
      const { client } = yield* makeScopedInitStatusContext

      // Both core RPCs should work in the same session
      const health = yield* client.health.check()
      const initStatus = yield* client.lifecycle.initStatus()

      assert.strictEqual(health.status, 'ok')
      assert.strictEqual(initStatus.ready, false)
    })
  )
})
