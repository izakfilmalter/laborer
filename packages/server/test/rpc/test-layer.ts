import { LaborerRpcs } from '@laborer/shared/rpc'
import {
  Context,
  Effect,
  Layer,
  Ref,
  type Scope,
  SubscriptionRef,
} from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { BackgroundFetchService } from '../../src/services/background-fetch-service.js'
import { BranchStateTracker } from '../../src/services/branch-state-tracker.js'
import { ConfigService } from '../../src/services/config-service.js'
import { DeferredServicesReady } from '../../src/services/deferred-service.js'
import { FileService } from '../../src/services/file-service.js'
import { GithubPullRequests } from '../../src/services/github-pull-requests.js'
import { GithubViewer } from '../../src/services/github-viewer.js'
import { LaborerDatabase } from '../../src/services/laborer-database.js'
import { PowerProfileService } from '../../src/services/power-profile.js'
import { PrTaskTransitions } from '../../src/services/pr-task-transitions.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { RepositoryIdentity } from '../../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../../src/services/repository-watch-coordinator.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../../src/services/workspace-sync-service.js'
import { WorktreeDetector } from '../../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../../src/services/worktree-reconciler.js'
import { TestFileWatcherClientLayer } from '../helpers/test-file-watcher-client.js'

class TestTerminalClientRecorder extends Context.Service<
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
>()('@laborer/test/TestTerminalClientRecorder') {}

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
      spawnInDirectory: (ownerId) =>
        Effect.succeed({
          id: crypto.randomUUID(),
          workspaceId: ownerId,
          command: 'test-shell',
          status: 'running' as const,
        }),
      spawnInWorkspace: (workspaceId, command) =>
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
/**
 * Nobody is logged in, without asking `gh`.
 *
 * The real service shells out, which tests must not do. Reporting no login
 * also exercises the branch every author-grouping consumer has to handle
 * anyway: an unresolved viewer attributes nothing to the current user.
 */
const TestGithubViewerLayer = Layer.succeed(GithubViewer)({
  login: Effect.succeed(null),
})

/**
 * No pull requests are open, without asking `gh`.
 *
 * Same reasoning as the viewer stub: shelling out is not allowed here, and an
 * empty listing is the branch every consumer already handles for a repository
 * with no GitHub remote.
 */
const TestGithubPullRequestsLayer = Layer.succeed(GithubPullRequests)({
  list: () => Effect.succeed([]),
})

const CoreLeafLayers = Layer.mergeAll(
  ConfigService.layer,
  RepositoryIdentity.layer,
  TestGithubPullRequestsLayer,
  TestGithubViewerLayer
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
 * Deferred Group 1 — services depending on the shared database + leaf layers.
 */
const DeferredGroup1aLayers = Layer.mergeAll(
  BranchStateTracker.layer,
  FileService.layer,
  PrWatcher.layer.pipe(
    Layer.provide(PowerProfileService.layer),
    Layer.provide(PrTaskTransitions.noopLayer)
  )
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
const DeferredGroup2Layers = Layer.mergeAll(RepositoryWatchCoordinator.layer)

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
  Layer.provide(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

const TestLaborerRpcWithDatabaseLayer = LaborerRpcsLive.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(DeferredServiceStackWithTerminal),
  Layer.provide(DeferredLeafLayers),
  Layer.provide(CoreLeafLayers),
  Layer.provide(DeferredServicesReadyTrueLayer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

export const TestLaborerRpcClient = RpcTest.makeClient(LaborerRpcs)

interface ScopedTestRpcContext {
  readonly client: Effect.Success<typeof TestLaborerRpcClient>
  readonly database: LaborerDatabase['Service']['database']
  readonly terminalClientRecorder: TestTerminalClientRecorder['Service']
}

export const makeTestRpcClient = TestLaborerRpcClient.pipe(
  Effect.provide(TestLaborerRpcLayer)
)

export const makeScopedTestRpcContext: Effect.Effect<
  ScopedTestRpcContext,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const context = yield* Layer.build(TestLaborerRpcWithDatabaseLayer)
  const client = yield* TestLaborerRpcClient.pipe(
    Effect.provide(Layer.succeedContext(context))
  )
  const { database } = Context.get(context, LaborerDatabase)
  const terminalClientRecorder = Context.get(
    context,
    TestTerminalClientRecorder
  )

  return { client, database, terminalClientRecorder }
})
