import type { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import type { TerminalManager } from '@laborer/terminal/services/terminal-manager'
import {
  Context,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect'

import { BackgroundFetchService } from './services/background-fetch-service.js'
import { BranchStateTracker } from './services/branch-state-tracker.js'
import { ConfigService } from './services/config-service.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeRefDelegatingService,
  serviceInitializingError,
} from './services/deferred-service.js'
import { registerInitialDevProject } from './services/dev-project-bootstrap.js'
import { FileService } from './services/file-service.js'
import type { FileWatcherClient } from './services/file-watcher-client.js'
import { GithubPullRequests } from './services/github-pull-requests.js'
import { GithubViewer } from './services/github-viewer.js'
import {
  LaborerDatabase,
  LaborerDatabaseLive,
} from './services/laborer-database.js'
import { OpenCodeModels } from './services/opencode-models.js'
import { PowerProfileService } from './services/power-profile.js'
import { PrTaskTransitions } from './services/pr-task-transitions.js'
import { PrWatcher } from './services/pr-watcher.js'
import { PreviewManager } from './services/preview-manager.js'
import { PreviewPortDiscovery } from './services/preview-port-discovery.js'
import { ProjectRegistry } from './services/project-registry.js'
import { RepositoryIdentity } from './services/repository-identity.js'
import { RepositoryWatchCoordinator } from './services/repository-watch-coordinator.js'
import { TerminalClient } from './services/terminal-client.js'
import { WorkspaceProvider } from './services/workspace-provider.js'
import { WorkspaceSyncService } from './services/workspace-sync-service.js'
import { WorktreeDetector } from './services/worktree-detector.js'
import { WorktreeReconciler } from './services/worktree-reconciler.js'

// ---------------------------------------------------------------------------
// Deferred Layers — Real implementations built in background fibers
// ---------------------------------------------------------------------------

/**
 * Leaf services have no inter-service dependencies, but some perform I/O or
 * establish lazy sidecar clients. Build them off the HTTP startup path.
 */
/**
 * Services depending on the shared database + leaf layers.
 */
const DeferredGroup1aLayers = Layer.mergeAll(
  BranchStateTracker.layer,
  FileService.layer,
  PrWatcher.layer.pipe(Layer.provide(PrTaskTransitions.layer))
)

/**
 * Builds WorktreeReconciler on top of Group 1a.
 */
const DeferredGroup1Layers = WorktreeReconciler.layer.pipe(
  Layer.provideMerge(DeferredGroup1aLayers)
)

const DeferredGroup1WithSync = WorkspaceSyncService.layer.pipe(
  Layer.provide(BackgroundFetchService.layer),
  Layer.provideMerge(DeferredGroup1Layers)
)

const DeferredGroup2Layers = Layer.mergeAll(RepositoryWatchCoordinator.layer)

const DeferredServiceStack = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(DeferredGroup2Layers),
  Layer.provideMerge(DeferredGroup1WithSync)
)

/**
 * Provides cheap Ref-backed proxies immediately, then swaps each proxy to the
 * real implementation as the background service groups finish building.
 */
const makeDeferredServicesProxyLayer = <
  FileWatcherInput,
  TerminalInput,
>(options: {
  readonly initialProjectPath?: string | undefined
  readonly fileWatcherClientLayer: Layer.Layer<
    FileWatcherClient,
    never,
    FileWatcherInput
  >
  readonly terminalClientLayer: Layer.Layer<
    TerminalClient,
    never,
    TerminalInput
  >
}) => {
  const DeferredLeafLayers = Layer.mergeAll(
    options.fileWatcherClientLayer,
    WorktreeDetector.layer
  )

  return Layer.effectContext(
    Effect.gen(function* () {
      const fileService = yield* makeRefDelegatingService(FileService, {
        watcherSubscribe: () =>
          Stream.fail(serviceInitializingError('@laborer/FileService')),
      })
      const prWatcher = yield* makeRefDelegatingService(PrWatcher)
      const projectRegistry = yield* makeRefDelegatingService(ProjectRegistry)
      const terminalClient = yield* makeRefDelegatingService(TerminalClient)
      const workspaceProvider =
        yield* makeRefDelegatingService(WorkspaceProvider)
      const workspaceSyncService =
        yield* makeRefDelegatingService(WorkspaceSyncService)

      yield* Effect.gen(function* () {
        yield* Effect.logInfo(
          'Starting background initialization of deferred services...'
        )

        const laborerDatabase = yield* LaborerDatabase
        const config = yield* ConfigService
        const repoId = yield* RepositoryIdentity
        const ready = yield* DeferredServicesReady
        const powerProfile = yield* PowerProfileService

        const CoreDeps = Layer.mergeAll(
          Layer.succeed(LaborerDatabase, laborerDatabase),
          Layer.succeed(ConfigService, config),
          Layer.succeed(RepositoryIdentity, repoId),
          Layer.succeed(DeferredServicesReady, ready),
          Layer.succeed(PowerProfileService, powerProfile)
        )

        yield* Effect.logInfo('[deferred-init] Building leaf layers...')
        const leafCtx = yield* Layer.build(
          DeferredLeafLayers.pipe(Layer.provide(CoreDeps))
        )
        yield* Effect.logInfo('[deferred-init] Leaf layers built OK')

        const stackFiber = yield* Effect.gen(function* () {
          yield* Effect.logInfo('[deferred-init] Building service stack...')
          const stackCtx = yield* Layer.build(
            DeferredServiceStack.pipe(
              Layer.provide(Layer.succeedContext(leafCtx)),
              Layer.provide(CoreDeps),
              Layer.provide(Layer.succeed(TerminalClient, terminalClient.proxy))
            )
          )
          yield* Effect.logInfo(
            '[deferred-init] Service stack built OK — swapping Refs'
          )
          yield* Ref.set(fileService.ref, Context.get(stackCtx, FileService))
          yield* Ref.set(prWatcher.ref, Context.get(stackCtx, PrWatcher))
          yield* Ref.set(
            projectRegistry.ref,
            Context.get(stackCtx, ProjectRegistry)
          )
          yield* Ref.set(
            workspaceProvider.ref,
            Context.get(stackCtx, WorkspaceProvider)
          )
          yield* Ref.set(
            workspaceSyncService.ref,
            Context.get(stackCtx, WorkspaceSyncService)
          )
          if (options.initialProjectPath !== undefined) {
            yield* registerInitialDevProject(options.initialProjectPath).pipe(
              Effect.provideService(
                ProjectRegistry,
                Context.get(stackCtx, ProjectRegistry)
              )
            )
          }
        }).pipe(Effect.forkScoped)

        const terminalFiber = yield* Effect.gen(function* () {
          yield* Effect.logInfo('[deferred-init] Building TerminalClient...')
          const termCtx = yield* Layer.build(
            options.terminalClientLayer.pipe(
              Layer.provide(CoreDeps),
              Layer.provide(
                Layer.succeed(WorkspaceProvider, workspaceProvider.proxy)
              )
            )
          )
          yield* Effect.logInfo(
            '[deferred-init] TerminalClient built OK — swapping Ref'
          )
          yield* Ref.set(
            terminalClient.ref,
            Context.get(termCtx, TerminalClient)
          )
        }).pipe(Effect.forkScoped)

        yield* Fiber.join(stackFiber)
        yield* Fiber.join(terminalFiber)
        yield* SubscriptionRef.set(ready.ref, true)
        yield* Effect.logInfo(
          '[deferred-init] All groups complete — DeferredServicesReady set to true'
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError('Deferred services failed to initialize')
            yield* Effect.logError(cause)
          })
        ),
        Effect.forkScoped,
        Effect.withSpan('deferred.init.all')
      )

      return pipe(
        Context.empty(),
        Context.add(FileService, fileService.proxy),
        Context.add(PrWatcher, prWatcher.proxy),
        Context.add(ProjectRegistry, projectRegistry.proxy),
        Context.add(TerminalClient, terminalClient.proxy),
        Context.add(WorkspaceProvider, workspaceProvider.proxy),
        Context.add(WorkspaceSyncService, workspaceSyncService.proxy)
      )
    })
  )
}

const provideInfrastructureCore = <ROut, RIn>(
  layer: Layer.Layer<ROut, never, RIn>
) =>
  layer.pipe(
    Layer.provideMerge(DeferredServicesReadyLayer),
    // A cached `gh api user` lookup: no dependencies, no work until first
    // asked, so it costs nothing to build on the startup path.
    Layer.provideMerge(GithubViewer.layer),
    // A cached `gh pr list` per project root, on the same terms: nothing runs
    // until the sidebar asks for an author's open pull requests.
    Layer.provideMerge(GithubPullRequests.layer),
    // A cached `opencode2 models` listing, on the same terms: nothing is
    // spawned until settings asks which models the operator can pick.
    Layer.provideMerge(OpenCodeModels.layer),
    Layer.provideMerge(PowerProfileService.layer),
    Layer.provideMerge(PreviewManager.layer),
    Layer.provideMerge(PreviewPortDiscovery.live),
    Layer.provideMerge(ConfigService.layer),
    Layer.provideMerge(RepositoryIdentity.layer),
    Layer.provideMerge(LaborerDatabaseLive.pipe(Layer.orDie))
  )

export const makeInfrastructureLayer = (options: {
  readonly initialProjectPath?: string | undefined
  readonly fileWatcherClientLayer: Layer.Layer<
    FileWatcherClient,
    never,
    WatcherManager
  >
  readonly terminalClientLayer: Layer.Layer<
    TerminalClient,
    never,
    TerminalManager | WorkspaceProvider
  >
}) => provideInfrastructureCore(makeDeferredServicesProxyLayer(options))
