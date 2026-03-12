import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { ContainerService } from '../src/services/container-service.js'
import { DepsImageService } from '../src/services/deps-image-service.js'
import { FileWatcher } from '../src/services/file-watcher.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { RepositoryEventBus } from '../src/services/repository-event-bus.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const tempRoots: string[] = []

const TestLayer = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(DepsImageService.layer),
  Layer.provideMerge(ContainerService.layer),
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(RepositoryWatchCoordinator.layer),
  Layer.provideMerge(BranchStateTracker.layer),
  Layer.provideMerge(RepositoryEventBus.layer),
  Layer.provideMerge(FileWatcher.layer),
  Layer.provideMerge(WorktreeReconciler.layer),
  Layer.provideMerge(WorktreeDetector.layer),
  Layer.provideMerge(RepositoryIdentity.layer),
  Layer.provideMerge(ConfigService.layer),
  Layer.provideMerge(PortAllocator.make(4300, 4300)),
  Layer.provideMerge(TestLaborerStore)
)

/**
 * Poll until the workspace row is removed from LiveStore.
 * destroyWorktree forks cleanup into a background daemon fiber, so the
 * workspace row deletion (the last step) signals that all cleanup is done.
 */
const waitForWorkspaceRemoval = (workspaceId: string) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore
    const maxAttempts = 100
    for (let i = 0; i < maxAttempts; i++) {
      yield* Effect.sleep('100 millis')
      const rows = store.query(tables.workspaces.where('id', workspaceId))
      if (rows.length === 0) {
        return
      }
    }
    assert.fail('Timed out waiting for workspace row to be removed')
  })

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('WorkspaceProvider.destroyWorktree origin behavior', () => {
  it.scopedLive('removes git worktree and branch for external workspaces', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('destroy-external', tempRoots)
      const branchName = 'feature/external'
      const worktreePath = join(repoPath, '.worktrees', 'external')
      git(`worktree add -b ${branchName} ${worktreePath}`, repoPath)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const allocator = yield* PortAllocator
      const allocatedPort = yield* allocator.allocate()

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: projectId,
          repoPath,
          name: 'destroy-external',
          rlphConfig: null,
        })
      )
      store.commit(
        events.workspaceCreated({
          id: workspaceId,
          projectId,
          taskSource: null,
          branchName,
          worktreePath,
          port: allocatedPort,
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const provider = yield* WorkspaceProvider
      yield* provider.destroyWorktree(workspaceId)

      // destroyWorktree forks cleanup into a background daemon fiber.
      // Poll until the workspace row is removed (last step in the fiber).
      yield* waitForWorkspaceRemoval(workspaceId)

      assert.isFalse(existsSync(worktreePath))
      assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')

      const reallocatedPort = yield* allocator.allocate()
      assert.strictEqual(reallocatedPort, allocatedPort)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scopedLive('removes git worktree and branch for laborer workspaces', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('destroy-laborer', tempRoots)
      const branchName = 'feature/laborer'
      const worktreePath = join(repoPath, '.worktrees', 'laborer')
      git(`worktree add -b ${branchName} ${worktreePath}`, repoPath)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: projectId,
          repoPath,
          name: 'destroy-laborer',
          rlphConfig: null,
        })
      )
      store.commit(
        events.workspaceCreated({
          id: workspaceId,
          projectId,
          taskSource: null,
          branchName,
          worktreePath,
          port: 0,
          status: 'stopped',
          origin: 'laborer',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const provider = yield* WorkspaceProvider
      yield* provider.destroyWorktree(workspaceId)

      // destroyWorktree forks cleanup into a background daemon fiber.
      // Poll until the workspace row is removed (last step in the fiber).
      yield* waitForWorkspaceRemoval(workspaceId)

      assert.isFalse(existsSync(worktreePath))
      assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
    }).pipe(Effect.provide(TestLayer))
  )
})
