import { RpcTest } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import {
  Context,
  Effect,
  Layer,
  Ref,
  type Scope,
  SubscriptionRef,
} from 'effect'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { BackgroundFetchService } from '../../src/services/background-fetch-service.js'
import { BranchStateTracker } from '../../src/services/branch-state-tracker.js'
import { ConfigService } from '../../src/services/config-service.js'
import { DeferredServicesReady } from '../../src/services/deferred-service.js'
import { FileService } from '../../src/services/file-service.js'
import { GithubTaskImporter } from '../../src/services/github-task-importer.js'
import { LaborerStore } from '../../src/services/laborer-store.js'
import { LinearTaskImporter } from '../../src/services/linear-task-importer.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { PrdStorageService } from '../../src/services/prd-storage-service.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { RepositoryIdentity } from '../../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../../src/services/repository-watch-coordinator.js'
import { ReviewCommentFetcher } from '../../src/services/review-comment-fetcher.js'
import { TaskManager } from '../../src/services/task-manager.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../../src/services/workspace-sync-service.js'
import { WorktreeDetector } from '../../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../../src/services/worktree-reconciler.js'
import { TestFileWatcherClientLayer } from '../helpers/test-file-watcher-client.js'
import { TestLaborerStore } from '../helpers/test-store.js'

class TestTerminalClientRecorder extends Context.Tag(
  '@laborer/test/TestTerminalClientRecorder'
)<
  TestTerminalClientRecorder,
  {
    readonly killAllForWorkspaceCalls: Ref.Ref<readonly string[]>
    readonly spawnInWorkspaceCalls: Ref.Ref<
      readonly {
        readonly command: string | undefined
        readonly workspaceId: string
      }[]
    >
  }
>() {}

const TestTerminalClientRecorderLayer = Layer.effect(
  TestTerminalClientRecorder,
  Effect.gen(function* () {
    return TestTerminalClientRecorder.of({
      killAllForWorkspaceCalls: yield* Ref.make<readonly string[]>([]),
      spawnInWorkspaceCalls: yield* Ref.make<
        readonly {
          readonly command: string | undefined
          readonly workspaceId: string
        }[]
      >([]),
    })
  })
)

const TestTerminalClient = Layer.effect(
  TerminalClient,
  Effect.gen(function* () {
    const recorder = yield* TestTerminalClientRecorder

    return TerminalClient.of({
      spawnInWorkspace: (workspaceId, command, _autoRun) =>
        Effect.gen(function* () {
          yield* Ref.update(recorder.spawnInWorkspaceCalls, (calls) => [
            ...calls,
            { command, workspaceId },
          ])

          return {
            id: crypto.randomUUID(),
            workspaceId,
            command: command ?? 'test-shell',
            status: 'running' as const,
          }
        }),
      killAllForWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* Ref.update(recorder.killAllForWorkspaceCalls, (calls) => [
            ...calls,
            workspaceId,
          ])
          return 0
        }),
    })
  })
)

// ---------------------------------------------------------------------------
// Core layers (match main.ts CoreHttpLive — fast-building, no I/O)
// ---------------------------------------------------------------------------

/**
 * Core infrastructure layers that build fast and have no external
 * I/O dependencies. These mirror the core layers in main.ts.
 */
const CoreLeafLayers = Layer.mergeAll(
  ConfigService.layer,
  RepositoryIdentity.layer
)

// ---------------------------------------------------------------------------
// Deferred layers (match main.ts DeferredServicesLive — heavy I/O)
// ---------------------------------------------------------------------------

/**
 * Deferred leaf layers with test stubs for external services.
 * Mirrors DeferredLeafLayers in main.ts but with test-safe stubs.
 */
const DeferredLeafLayers = Layer.mergeAll(
  TestFileWatcherClientLayer,
  WorktreeDetector.layer
)

/**
 * Deferred Group 1 — services depending on LaborerStore + leaf layers.
 */
const DeferredGroup1aLayers = Layer.mergeAll(
  TaskManager.layer,
  BranchStateTracker.layer,
  PrdStorageService.layer,
  FileService.layer,
  PrWatcher.layer
)

const DeferredGroup1Layers = WorktreeReconciler.layer.pipe(
  Layer.provideMerge(DeferredGroup1aLayers)
)

const TestBackgroundFetchLayer = Layer.succeed(
  BackgroundFetchService,
  BackgroundFetchService.of({
    startFetching: () => Effect.void,
    stopFetching: () => Effect.void,
    stopAllFetching: () => Effect.void,
    fetchNow: () => Effect.succeed(false),
  })
)

const DeferredGroup1WithSync = WorkspaceSyncService.layer.pipe(
  Layer.provide(TestBackgroundFetchLayer),
  Layer.provideMerge(DeferredGroup1Layers)
)

/**
 * Deferred Group 2 — services depending on Group 1.
 */
const DeferredGroup2Layers = Layer.mergeAll(
  GithubTaskImporter.layer,
  LinearTaskImporter.layer,
  ReviewCommentFetcher.layer,
  RepositoryWatchCoordinator.layer
)

/**
 * Full deferred service stack built bottom-up.
 * Each group uses provideMerge so all services remain available as outputs.
 */
const DeferredServiceStack = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(DeferredGroup2Layers),
  Layer.provideMerge(DeferredGroup1WithSync)
)

// ---------------------------------------------------------------------------
// Combined test layers
// ---------------------------------------------------------------------------

/**
 * Layer that provides DeferredServicesReady with the ref already set
 * to `true`. Used in test layers where all services are built eagerly
 * (no deferred proxy pattern). This matches the production state where
 * all deferred services have completed initialization.
 */
const DeferredServicesReadyTrueLayer = Layer.effect(
  DeferredServicesReady,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(true)
    return DeferredServicesReady.of({ ref })
  })
)

/**
 * All layers (core + deferred) composed for full RPC testing.
 * Uses DeferredServicesReadyTrueLayer because all services are built
 * eagerly, matching the production state after deferred init completes.
 */
/**
 * DeferredServiceStack with TestTerminalClient baked in.
 */
const DeferredServiceStackWithTerminal = DeferredServiceStack.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provide(TestTerminalClientRecorderLayer)
)

export const TestLaborerRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(DeferredServiceStackWithTerminal),
  Layer.provide(DeferredLeafLayers),
  Layer.provide(CoreLeafLayers),
  Layer.provide(DeferredServicesReadyTrueLayer),
  Layer.provide(TestLaborerStore)
)

const TestLaborerRpcWithStoreLayer = LaborerRpcsLive.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(DeferredServiceStackWithTerminal),
  Layer.provide(DeferredLeafLayers),
  Layer.provide(CoreLeafLayers),
  Layer.provide(DeferredServicesReadyTrueLayer),
  Layer.provideMerge(TestLaborerStore)
)

export const TestLaborerRpcClient = RpcTest.makeClient(LaborerRpcs)

interface ScopedTestRpcContext {
  readonly client: Effect.Effect.Success<typeof TestLaborerRpcClient>
  readonly store: LaborerStore['Type']['store']
  readonly terminalClientRecorder: TestTerminalClientRecorder['Type']
}

export const makeTestRpcClient = TestLaborerRpcClient.pipe(
  Effect.provide(TestLaborerRpcLayer)
)

export const makeScopedTestRpcContext: Effect.Effect<
  ScopedTestRpcContext,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const context = yield* Layer.build(TestLaborerRpcWithStoreLayer)
  const client = yield* TestLaborerRpcClient.pipe(
    Effect.provide(Layer.succeedContext(context))
  )
  const { store } = Context.get(context, LaborerStore)
  const terminalClientRecorder = Context.get(
    context,
    TestTerminalClientRecorder
  )

  return { client, store, terminalClientRecorder }
})
