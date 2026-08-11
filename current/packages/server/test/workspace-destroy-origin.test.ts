import { existsSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

const tempRoots: string[] = []
const originalXdgStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = createTempDir(
  'workspace-destroy-task-state',
  tempRoots
)

const DatabaseTestLayer = LaborerDatabase.testLayer().pipe(Layer.orDie)

const TestLayer = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(RepositoryWatchCoordinator.layer),
  Layer.provideMerge(BranchStateTracker.layer),
  Layer.provideMerge(TestFileWatcherClientLayer),
  Layer.provideMerge(WorktreeReconciler.layer),
  Layer.provideMerge(WorktreeDetector.layer),
  Layer.provideMerge(RepositoryIdentity.layer),
  Layer.provideMerge(ConfigService.layer),
  Layer.provideMerge(DatabaseTestLayer)
)

const waitForWorkspaceRemoval = (workspaceId: string) =>
  Effect.gen(function* () {
    const { database } = yield* LaborerDatabase
    const maxAttempts = 100
    for (let i = 0; i < maxAttempts; i++) {
      yield* Effect.sleep('100 millis')
      if (database.findTask(workspaceId)?.worktreePath === null) {
        return
      }
    }
    assert.fail('Timed out waiting for task worktree facts to be cleared')
  })

afterAll(() => {
  if (originalXdgStateHome === undefined) {
    process.env.XDG_STATE_HOME = undefined
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome
  }
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

      const workspaceId = crypto.randomUUID()
      const { database } = yield* LaborerDatabase
      database.insertTask({
        branchName,
        id: workspaceId,
        rootPath: realpathSync(repoPath),
        source: 'worktree',
        status: 'in_progress',
        title: branchName,
        worktreePath: realpathSync(worktreePath),
        worktreeStatus: 'ready',
      })
      const registry = yield* ProjectRegistry
      yield* registry.addProject(repoPath)

      const provider = yield* WorkspaceProvider
      yield* provider.destroyWorktree(workspaceId)
      yield* waitForWorkspaceRemoval(workspaceId)

      assert.isFalse(existsSync(worktreePath))
      assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
    }).pipe(Effect.provide(TestLayer))
  )

  it.scopedLive('removes git worktree and branch for laborer workspaces', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('destroy-laborer', tempRoots)
      const branchName = 'feature/laborer'
      const worktreePath = join(repoPath, '.worktrees', 'laborer')
      git(`worktree add -b ${branchName} ${worktreePath}`, repoPath)

      const workspaceId = crypto.randomUUID()
      const { database } = yield* LaborerDatabase
      database.insertTask({
        branchName,
        id: workspaceId,
        rootPath: realpathSync(repoPath),
        source: 'manual',
        status: 'in_progress',
        title: branchName,
        worktreePath: realpathSync(worktreePath),
        worktreeStatus: 'ready',
      })
      const registry = yield* ProjectRegistry
      yield* registry.addProject(repoPath)

      const provider = yield* WorkspaceProvider
      yield* provider.destroyWorktree(workspaceId)
      yield* waitForWorkspaceRemoval(workspaceId)

      assert.isFalse(existsSync(worktreePath))
      assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
    }).pipe(Effect.provide(TestLayer))
  )
})
