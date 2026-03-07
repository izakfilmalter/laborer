import { RpcTest } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'
import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { BranchStateTracker } from '../../src/services/branch-state-tracker.js'
import { ConfigService } from '../../src/services/config-service.js'
import { ContainerService } from '../../src/services/container-service.js'
import { DiffService } from '../../src/services/diff-service.js'
import { DockerDetection } from '../../src/services/docker-detection.js'
import { FileWatcher } from '../../src/services/file-watcher.js'
import { GithubTaskImporter } from '../../src/services/github-task-importer.js'
import { LaborerStore } from '../../src/services/laborer-store.js'
import { LinearTaskImporter } from '../../src/services/linear-task-importer.js'
import { PortAllocator } from '../../src/services/port-allocator.js'
import { PrdStorageService } from '../../src/services/prd-storage-service.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { RepositoryEventBus } from '../../src/services/repository-event-bus.js'
import { RepositoryIdentity } from '../../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../../src/services/repository-watch-coordinator.js'
import { TaskManager } from '../../src/services/task-manager.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorktreeDetector } from '../../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../../src/services/worktree-reconciler.js'
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

export const TestLaborerRpcLayer = LaborerRpcsLive.pipe(
  Layer.provide(LinearTaskImporter.layer),
  Layer.provide(GithubTaskImporter.layer),
  Layer.provide(TaskManager.layer),
  Layer.provide(PrdStorageService.layer),
  Layer.provide(DiffService.layer),
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(WorkspaceProvider.layer),
  Layer.provide(ContainerService.layer),
  Layer.provide(TestDockerDetection),
  Layer.provide(ConfigService.layer),
  Layer.provide(ProjectRegistry.layer),
  Layer.provide(RepositoryWatchCoordinator.layer),
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(RepositoryEventBus.layer),
  Layer.provide(FileWatcher.layer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provide(PortAllocator.make(4100, 4199)),
  Layer.provide(TestLaborerStore)
)

const TestLaborerRpcWithStoreLayer = LaborerRpcsLive.pipe(
  Layer.provide(LinearTaskImporter.layer),
  Layer.provide(GithubTaskImporter.layer),
  Layer.provide(TaskManager.layer),
  Layer.provide(PrdStorageService.layer),
  Layer.provide(DiffService.layer),
  Layer.provide(TestTerminalClient),
  Layer.provideMerge(TestTerminalClientRecorderLayer),
  Layer.provide(WorkspaceProvider.layer),
  Layer.provide(ContainerService.layer),
  Layer.provide(TestDockerDetection),
  Layer.provide(ConfigService.layer),
  Layer.provide(ProjectRegistry.layer),
  Layer.provide(RepositoryWatchCoordinator.layer),
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(RepositoryEventBus.layer),
  Layer.provide(FileWatcher.layer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provide(PortAllocator.make(4100, 4199)),
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
