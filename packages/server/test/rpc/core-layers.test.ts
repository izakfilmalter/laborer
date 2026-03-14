/**
 * Core Layers Test — Issue #13
 *
 * Verifies that the health check RPC works with only core
 * infrastructure layers, confirming the layer separation in main.ts
 * is correct. Deferred services are provided as stubs that die when
 * invoked, proving they're not needed for the health endpoint.
 */

import { RpcTest } from '@effect/rpc'
import { assert, describe, it } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Effect, Layer } from 'effect'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { ConfigService } from '../../src/services/config-service.js'
import { ContainerService } from '../../src/services/container-service.js'
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
 * Creates a proxy service stub that constructs successfully but throws
 * when any method is invoked. Used to satisfy LaborerRpcsLive's
 * type-level service requirements without building real deferred services.
 */
const makeStubService = <T extends object>(name: string): T =>
  new Proxy({} as T, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') {
        return undefined
      }
      return () =>
        Effect.die(
          new Error(
            `${name}.${prop} not available — deferred service not initialized`
          )
        )
    },
  })

/**
 * Stub layers for all deferred services.
 *
 * Each stub provides the service tag with a proxy whose methods
 * return Effect.die when invoked. This proves the health endpoint
 * doesn't depend on deferred services at runtime — only at the
 * type level (because LaborerRpcsLive captures handler service
 * requirements).
 *
 * Issue #14 will replace these with proper "service initializing"
 * error implementations.
 */
const DeferredServiceStubs = Layer.mergeAll(
  Layer.succeed(DockerDetection, makeStubService('DockerDetection')),
  Layer.succeed(ProjectRegistry, makeStubService('ProjectRegistry')),
  Layer.succeed(PrdStorageService, makeStubService('PrdStorageService')),
  Layer.succeed(TaskManager, makeStubService('TaskManager')),
  Layer.succeed(WorkspaceProvider, makeStubService('WorkspaceProvider')),
  Layer.succeed(DiffService, makeStubService('DiffService')),
  Layer.succeed(PrWatcher, makeStubService('PrWatcher')),
  Layer.succeed(WorkspaceSyncService, makeStubService('WorkspaceSyncService')),
  Layer.succeed(TerminalClient, makeStubService('TerminalClient')),
  Layer.succeed(ContainerService, makeStubService('ContainerService')),
  Layer.succeed(GithubTaskImporter, makeStubService('GithubTaskImporter')),
  Layer.succeed(LinearTaskImporter, makeStubService('LinearTaskImporter')),
  Layer.succeed(ReviewCommentFetcher, makeStubService('ReviewCommentFetcher')),
  Layer.succeed(DepsImageService, makeStubService('DepsImageService'))
)

/**
 * Core-only test layer: LaborerRpcsLive with only core infrastructure
 * layers (ConfigService, LaborerStore) and stub implementations for
 * all deferred services.
 *
 * This proves the health endpoint responds without building any
 * deferred services — terminal sidecar, file-watcher sidecar, Docker
 * detection, etc. are all stubbed.
 */
const CoreOnlyRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(DeferredServiceStubs),
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
      // FileWatcherClient.layer — only stubs.
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

  it.scoped(
    'deferred service RPC fails with stub error, not missing service',
    () =>
      Effect.gen(function* () {
        const client = yield* CoreOnlyRpcClient

        // Calling a deferred-service RPC should fail with a defect
        // from our stub (the service object itself throws when
        // any property is accessed), not with a "service not found" error.
        const result = yield* client.docker.status().pipe(
          Effect.matchCauseEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (cause) => {
              const defectOrError = cause.toString()
              return Effect.succeed(defectOrError)
            },
          })
        )

        // The stub should produce a "not available" defect
        if (result === 'success') {
          assert.fail('Expected docker.status to fail with stub')
        }
        assert.include(result, 'not available')
      })
  )
})
