import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { PROJECT_COLORS } from '@laborer/shared/project-colors'
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
import { createTempDir, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

const tempRoots: string[] = []
const originalXdgStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = createTempDir(
  'project-appearance-task-state',
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

/**
 * Repositories created by `initRepo` share a name prefix, so their derived
 * short names collide. Naming each one explicitly keeps the fixture about
 * appearance rather than about the identifier namespace.
 */
const repositoryNamed = (name: string, shortName: string): string => {
  const repoPath = initRepo(name, tempRoots)
  writeFileSync(
    join(repoPath, 'laborer.json'),
    JSON.stringify({ shortName }, null, 2)
  )
  return repoPath
}

describe('project appearance at registration', () => {
  it.effect('gives each project an accent no sibling is already using', () =>
    Effect.gen(function* () {
      const registry = yield* ProjectRegistry
      const first = yield* registry.addProject(
        repositoryNamed('appearance-first', 'APPONE')
      )
      const second = yield* registry.addProject(
        repositoryNamed('appearance-second', 'APPTWO')
      )

      assert.include(PROJECT_COLORS, first.color)
      assert.include(PROJECT_COLORS, second.color)
      assert.notStrictEqual(first.color, second.color)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("stores the repository's favicon as the project icon", () =>
    Effect.gen(function* () {
      const repoPath = repositoryNamed('appearance-favicon', 'APPICO')
      mkdirSync(join(repoPath, 'public'), { recursive: true })
      writeFileSync(join(repoPath, 'public', 'favicon.svg'), '<svg />')

      const registry = yield* ProjectRegistry
      const project = yield* registry.addProject(repoPath)

      const database = yield* LaborerDatabase
      const stored = yield* database
        .run('find project', (native) => native.findProject(project.id))
        .pipe(Effect.orDie)

      assert.isNotNull(stored)
      assert.include(stored?.iconDataUrl ?? '', 'image/svg+xml')
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('leaves the icon empty for a repository shipping none', () =>
    Effect.gen(function* () {
      const registry = yield* ProjectRegistry
      const project = yield* registry.addProject(
        repositoryNamed('appearance-no-favicon', 'APPNIL')
      )

      const database = yield* LaborerDatabase
      const stored = yield* database
        .run('find project', (native) => native.findProject(project.id))
        .pipe(Effect.orDie)

      assert.strictEqual(stored?.iconDataUrl ?? null, null)
    }).pipe(Effect.provide(TestLayer))
  )
})
