import { RpcTest } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { BranchStateTracker } from '../../src/services/branch-state-tracker.js'
import { ConfigService } from '../../src/services/config-service.js'
import { ContainerService } from '../../src/services/container-service.js'
import { DepsImageService } from '../../src/services/deps-image-service.js'
import { DiffService } from '../../src/services/diff-service.js'
import { DockerDetection } from '../../src/services/docker-detection.js'
import { GithubTaskImporter } from '../../src/services/github-task-importer.js'
import { LaborerStore } from '../../src/services/laborer-store.js'
import { LinearTaskImporter } from '../../src/services/linear-task-importer.js'
import { PortAllocator } from '../../src/services/port-allocator.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { PrdStorageService } from '../../src/services/prd-storage-service.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { RepositoryIdentity } from '../../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../../src/services/repository-watch-coordinator.js'
import { TaskManager } from '../../src/services/task-manager.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
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

/**
 * Test stub for DockerDetection — always reports Docker as available.
 * Avoids running actual `which docker` / `docker info` commands in tests.
 */
const TestDockerDetection = Layer.succeed(
  DockerDetection,
  DockerDetection.of({
    check: () => Effect.succeed({ available: true }),
  })
)

/**
 * Test stub for DepsImageService — always returns null (no lockfile found).
 * Prevents Docker commands from running in test workers, which would crash
 * tinypool when the test scope exits before the background fiber finishes.
 */
const TestDepsImageService = Layer.succeed(
  DepsImageService,
  DepsImageService.of({
    ensureDepsImage: () => Effect.succeed(null),
  })
)

/**
 * Leaf layers with no service dependencies (Group 0).
 */
const LeafLayers = Layer.mergeAll(
  ConfigService.layer,
  TestFileWatcherClientLayer,
  RepositoryIdentity.layer,
  WorktreeDetector.layer,
  TestDepsImageService,
  TestDockerDetection,
  PortAllocator.make(4100, 4199)
)

/**
 * Layers that depend only on LaborerStore + leaf layers (Group 1).
 */
const Group1Layers = Layer.mergeAll(
  TaskManager.layer,
  BranchStateTracker.layer,
  ContainerService.layer,
  PrdStorageService.layer,
  DiffService.layer,
  PrWatcher.layer,
  WorktreeReconciler.layer
)

/**
 * Layers that depend on Group 1 (Group 2).
 */
const Group2Layers = Layer.mergeAll(
  GithubTaskImporter.layer,
  LinearTaskImporter.layer,
  RepositoryWatchCoordinator.layer
)

/**
 * Full service dependency stack built bottom-up.
 * Each group uses provideMerge so all services remain available as outputs.
 */
const ServiceLayers = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(Group2Layers),
  Layer.provideMerge(Group1Layers)
)

export const TestLaborerRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(ServiceLayers),
  Layer.provide(LeafLayers),
  Layer.provide(TestLaborerStore)
)

const TestLaborerRpcWithStoreLayer = LaborerRpcsLive.pipe(
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(ServiceLayers),
  Layer.provide(LeafLayers),
  Layer.provideMerge(TestLaborerStore)
)

export const TestLaborerRpcClient = RpcTest.makeClient(LaborerRpcs)

export const makeTestRpcClient = TestLaborerRpcClient.pipe(
  Effect.provide(TestLaborerRpcLayer)
)

export const makeScopedTestRpcContext = Effect.gen(function* () {
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
