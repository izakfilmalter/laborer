import { existsSync, rmSync } from 'node:fs'
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
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

const tempRoots: string[] = []
const originalXdgStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = createTempDir(
  'project-registry-task-state',
  tempRoots
)

const DatabaseTestLayer = LaborerDatabase.testLayer().pipe(Layer.orDie)

const TestLayer = ProjectRegistry.layer.pipe(
  Layer.provide(RepositoryWatchCoordinator.layer),
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(TestFileWatcherClientLayer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provideMerge(WorktreeDetector.layer),
  Layer.provideMerge(DatabaseTestLayer)
)

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

describe('ProjectRegistry integration with worktree detection', () => {
  it.scoped(
    'addProject registers the project and detects main and linked worktrees',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('project-registry-detect', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'feature-d')
        git(`worktree add -b feature/d ${linkedPath}`, repoPath)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)

        const detector = yield* WorktreeDetector
        const rows = yield* detector.detect(project.repoPath)

        assert.strictEqual(rows.length, 2)
        assert.isTrue(rows.some((row) => row.isMain))
        assert.deepInclude(
          rows.find((row) => !row.isMain),
          { branch: 'feature/d', path: linkedPath }
        )
      }).pipe(Effect.provide(TestLayer))
  )
})
