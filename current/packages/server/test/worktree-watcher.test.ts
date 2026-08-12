import { existsSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { listWorkspaceRecords } from '../src/services/workspace-records.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientRealLayer } from './helpers/test-file-watcher-client.js'
import { delay, waitForWithNudge } from './helpers/timing-helpers.js'

const tempRoots: string[] = []
const TestDatabaseLayer = LaborerDatabase.testLayer().pipe(Layer.orDie)

const TestLayer = RepositoryWatchCoordinator.layer.pipe(
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(TestFileWatcherClientRealLayer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provideMerge(TestDatabaseLayer)
)

const createProject = (
  database: NativeLaborerDatabase,
  projectId: string,
  repoPath: string
) =>
  database.insertProject({
    canonicalGitCommonDir: realpathSync(join(repoPath, '.git')),
    id: projectId,
    name: projectId,
    repoId: projectId,
    rootPath: realpathSync(repoPath),
  })

const createWorkspace = (
  database: NativeLaborerDatabase,
  repoPath: string,
  workspaceId: string,
  branchName: string,
  worktreePath: string
) =>
  database.insertTask({
    branchName,
    id: workspaceId,
    rootPath: realpathSync(repoPath),
    source: 'worktree',
    status: 'in_progress',
    title: branchName,
    worktreePath,
    worktreeStatus: 'ready',
  })

const projectWorkspaces = (
  database: NativeLaborerDatabase,
  projectId: string
) =>
  listWorkspaceRecords(database).filter(
    (workspace) => workspace.projectId === projectId
  )

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('RepositoryWatchCoordinator', () => {
  it.effect('reconciles on worktree add and remove', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('watcher-add-remove', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'watcher-one')

      const coordinator = yield* RepositoryWatchCoordinator
      const { database } = yield* LaborerDatabase
      createProject(database, 'project-watch-1', repoPath)
      createWorkspace(
        database,
        repoPath,
        'workspace-missing-before-add',
        'watcher/missing',
        join(repoPath, '.worktrees', 'missing')
      )
      yield* coordinator.watchProject('project-watch-1', repoPath)
      // Allow @parcel/watcher FSEvents subscription to fully initialize
      yield* Effect.promise(() => delay(500))

      git(`worktree add -b watcher/one ${linkedPath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              projectWorkspaces(database, 'project-watch-1').length === 0
            ),
          repoPath
        )
      )

      createWorkspace(
        database,
        repoPath,
        'workspace-watcher-one',
        'watcher/one',
        realpathSync(linkedPath)
      )

      git(`worktree remove --force ${linkedPath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              projectWorkspaces(database, 'project-watch-1').length === 0
            ),
          repoPath
        )
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('unwatchProject stops future reconciliation', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('watcher-unwatch', tempRoots)
      const linkedA = join(repoPath, '.worktrees', 'watcher-a')
      const linkedB = join(repoPath, '.worktrees', 'watcher-b')

      const coordinator = yield* RepositoryWatchCoordinator
      const { database } = yield* LaborerDatabase
      createProject(database, 'project-watch-2', repoPath)
      yield* coordinator.watchProject('project-watch-2', repoPath)
      // Allow @parcel/watcher FSEvents subscription to fully initialize
      yield* Effect.promise(() => delay(500))

      git(`worktree add -b watcher/a ${linkedA}`, repoPath)
      createWorkspace(
        database,
        repoPath,
        'workspace-watcher-a',
        'watcher/a',
        realpathSync(linkedA)
      )

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              projectWorkspaces(database, 'project-watch-2').length === 1
            ),
          repoPath
        )
      )

      yield* coordinator.unwatchProject('project-watch-2')

      createWorkspace(
        database,
        repoPath,
        'workspace-unwatched-missing',
        'watcher/unwatched-missing',
        join(repoPath, '.worktrees', 'unwatched-missing')
      )
      git(`worktree add -b watcher/b ${linkedB}`, repoPath)
      yield* Effect.promise(() => delay(1500))

      const rows = projectWorkspaces(database, 'project-watch-2')
      assert.strictEqual(rows.length, 2)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('watchAll reconciles existing projects and starts watchers', () =>
    Effect.gen(function* () {
      const repoA = initRepo('watcher-all-a', tempRoots)
      const repoB = initRepo('watcher-all-b', tempRoots)
      const linkedA = join(repoA, '.worktrees', 'watcher-all-a-one')
      git(`worktree add -b watcher/all-a ${linkedA}`, repoA)

      const coordinator = yield* RepositoryWatchCoordinator
      const { database } = yield* LaborerDatabase

      // Allow the daemon watchAll (fired during layer construction)
      // to complete on the empty store before seeding projects.
      yield* Effect.promise(() => delay(200))

      createProject(database, 'project-watch-all-a', repoA)
      createProject(database, 'project-watch-all-b', repoB)
      createWorkspace(
        database,
        repoA,
        'workspace-watch-all-a',
        'watcher/all-a',
        realpathSync(linkedA)
      )
      createWorkspace(
        database,
        repoB,
        'workspace-watch-all-b-missing',
        'watcher/all-b-missing',
        join(repoB, '.worktrees', 'missing')
      )

      yield* coordinator.watchAll()

      // After watchAll, reconciliation retains the linked worktree and
      // releases the missing worktree record.
      const rowsA = projectWorkspaces(database, 'project-watch-all-a')
      const rowsB = projectWorkspaces(database, 'project-watch-all-b')
      assert.strictEqual(
        rowsA.length,
        1,
        'watchAll should retain the linked worktree for repoA'
      )
      assert.strictEqual(
        rowsB.length,
        0,
        'watchAll should release the missing worktree for repoB'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'handles repos with no .git/worktrees until first linked worktree',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('watcher-missing-worktrees', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'watcher-late-create')

        const coordinator = yield* RepositoryWatchCoordinator
        const { database } = yield* LaborerDatabase
        createProject(database, 'project-watch-3', repoPath)
        createWorkspace(
          database,
          repoPath,
          'workspace-watch-late-missing',
          'watcher/late-missing',
          join(repoPath, '.worktrees', 'missing')
        )
        yield* coordinator.watchProject('project-watch-3', repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        git(`worktree add -b watcher/late ${linkedPath}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(
            () =>
              Promise.resolve(
                projectWorkspaces(database, 'project-watch-3').length === 0
              ),
            repoPath
          )
        )
      }).pipe(Effect.provide(TestLayer))
  )
})
