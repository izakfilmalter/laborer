import { createHash } from 'node:crypto'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Layer, Scope } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type {
  LaborerTask,
  NativeLaborerDatabase,
} from '../src/services/native-laborer-database.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientRealLayer } from './helpers/test-file-watcher-client.js'
import { delay, waitFor, waitForWithNudge } from './helpers/timing-helpers.js'

const tempRoots: string[] = []

/**
 * Derive the canonical repo identity for a freshly-inited repo.
 * Mirrors the logic in RepositoryIdentity.resolve: the canonical
 * git common dir is `realpathSync(<repoPath>/.git)` and the repo
 * id is `SHA-256(canonicalGitCommonDir).slice(0, 16)`.
 */
const deriveIdentity = (repoPath: string) => {
  const canonicalGitCommonDir = realpathSync(join(repoPath, '.git'))
  const repoId = createHash('sha256')
    .update(canonicalGitCommonDir)
    .digest('hex')
    .slice(0, 16)
  return {
    canonicalGitCommonDir,
    repoId,
    canonicalRoot: realpathSync(repoPath),
  }
}

const insertProject = (
  database: NativeLaborerDatabase,
  id: string,
  repoPath: string,
  name: string
) => {
  const identity = deriveIdentity(repoPath)
  return database.insertProject({
    canonicalGitCommonDir: identity.canonicalGitCommonDir,
    id,
    name,
    repoId: identity.repoId,
    rootPath: identity.canonicalRoot,
  }).row
}

const listProjectWorkspaces = (
  database: NativeLaborerDatabase,
  projectId: string
): readonly LaborerTask[] => {
  const project = database.findProject(projectId)
  if (project === null) {
    return []
  }
  return database
    .listTasks()
    .filter(
      (task) =>
        task.rootPath === project.rootPath &&
        task.worktreePath !== null &&
        task.branchName !== null
    )
}

/**
 * Full service stack matching production layer composition.
 * ProjectRegistry sits at the top, consuming all repo-watching services.
 */
const TestLayer = ProjectRegistry.layer.pipe(
  Layer.provide(RepositoryWatchCoordinator.layer),
  Layer.provide(BranchStateTracker.layer),
  Layer.provide(ConfigService.layer),
  Layer.provide(TestFileWatcherClientRealLayer),
  Layer.provide(WorktreeReconciler.layer),
  Layer.provide(WorktreeDetector.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('Startup bootstrap and project lifecycle integration', () => {
  it.effect(
    'project add performs canonical discovery and initial refresh before returning ready state',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-add-ready', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'boot-feature')
        git(`worktree add -b feature/boot-test ${worktreePath}`, repoPath)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)
        const { database } = yield* LaborerDatabase

        // After addProject returns, workspace records should already
        // exist with correct branch names — no waiting needed.
        const workspaces = listProjectWorkspaces(database, project.id)

        // Both the main worktree and the linked worktree should be present
        assert.strictEqual(
          workspaces.length,
          1,
          'The linked worktree should be reconciled before project is ready'
        )

        // Branch names should already be populated from initial refresh
        const branchNames = workspaces.map((w) => w.branchName).sort()
        assert.isTrue(
          branchNames.includes('feature/boot-test'),
          'Linked worktree branch should be set'
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect('project add starts the repository watcher coordinator', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('boot-add-watcher', tempRoots)

      const registry = yield* ProjectRegistry
      const project = yield* registry.addProject(repoPath)
      // Allow @parcel/watcher FSEvents subscription to fully initialize
      yield* Effect.promise(() => delay(500))

      const { database } = yield* LaborerDatabase

      // After addProject, the watcher should be running. Creating a
      // worktree should be detected automatically via the coordinator.
      const worktreePath = join(repoPath, '.worktrees', 'boot-watcher')
      git(`worktree add -b feature/boot-watcher ${worktreePath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              listProjectWorkspaces(database, project.id).length === 1
            ),
          repoPath
        )
      )

      const workspaces = listProjectWorkspaces(database, project.id)
      assert.strictEqual(
        workspaces.length,
        1,
        'Watcher should detect new worktree after addProject'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('server boot restores watchers for all persisted projects', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('boot-restore', tempRoots)
      const existingWorktreePath = join(
        repoPath,
        '.worktrees',
        'boot-restore-existing'
      )
      git(
        `worktree add -b feature/boot-restore-existing ${existingWorktreePath}`,
        repoPath
      )

      // Simulate a prior server session: seed a project directly
      // into the database before building the coordinator layer.
      const laborerDatabase = yield* LaborerDatabase
      const { database } = laborerDatabase
      const projectId = 'project-boot-restore'
      insertProject(database, projectId, repoPath, 'boot-restore')

      // Build the coordinator layer (which calls watchAll at startup)
      const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
        Layer.provide(BranchStateTracker.layer),
        Layer.provide(ConfigService.layer),
        Layer.provide(TestFileWatcherClientRealLayer),
        Layer.provide(WorktreeReconciler.layer),
        Layer.provide(WorktreeDetector.layer),
        Layer.provide(RepositoryIdentity.layer)
      )

      // Use a manual scope to simulate server lifecycle
      const scope = yield* Scope.make()

      const databaseLayer = Layer.succeed(LaborerDatabase, laborerDatabase)
      const fullLayer = CoordinatorLayer.pipe(Layer.provide(databaseLayer))

      yield* Layer.buildWithScope(fullLayer, scope)

      // watchAll is forked as a daemon so the layer completes
      // before reconciliation finishes — poll until it does.
      yield* Effect.promise(() =>
        waitFor(
          () =>
            Promise.resolve(
              listProjectWorkspaces(database, projectId).length === 1
            ),
          10_000,
          'watchAll reconciliation for persisted project'
        )
      )

      const workspaces = listProjectWorkspaces(database, projectId)
      assert.isAbove(
        workspaces.length,
        0,
        'Startup should reconcile worktrees for persisted projects'
      )

      // The watcher should be running — adding a worktree should
      // be detected automatically
      const worktreePath = join(repoPath, '.worktrees', 'boot-restore-wt')
      git(`worktree add -b feature/boot-restore ${worktreePath}`, repoPath)

      yield* Effect.promise(() =>
        waitForWithNudge(
          () =>
            Promise.resolve(
              listProjectWorkspaces(database, projectId).length === 2
            ),
          repoPath
        )
      )

      yield* Scope.close(scope, Exit.succeed(undefined))
    }).pipe(Effect.provide(LaborerDatabase.testLayer().pipe(Layer.orDie)))
  )

  it.effect(
    'server boot reconciles worktree and branch state that changed while offline',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-offline', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'boot-offline-wt')

        // Simulate prior server session state: project and one workspace
        const laborerDatabase = yield* LaborerDatabase
        const { database } = laborerDatabase
        const projectId = 'project-boot-offline'
        const workspaceId = crypto.randomUUID()

        const project = insertProject(
          database,
          projectId,
          repoPath,
          'boot-offline'
        )
        database.insertTask({
          branchName: 'main',
          id: workspaceId,
          rootPath: project.rootPath,
          source: 'worktree',
          status: 'in_progress',
          title: 'main',
          worktreePath: project.rootPath,
          worktreeStatus: 'ready',
        })

        // Simulate offline changes:
        // 1. Switch branch on main worktree
        git('checkout -b feature/offline-change', repoPath)
        // 2. Add a new worktree
        git(`worktree add -b feature/offline-wt ${worktreePath}`, repoPath)

        // Build coordinator layer — startup watchAll should reconcile
        const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(BranchStateTracker.layer),
          Layer.provide(ConfigService.layer),
          Layer.provide(TestFileWatcherClientRealLayer),
          Layer.provide(WorktreeReconciler.layer),
          Layer.provide(WorktreeDetector.layer),
          Layer.provide(RepositoryIdentity.layer)
        )

        const scope = yield* Scope.make()

        const databaseLayer = Layer.succeed(LaborerDatabase, laborerDatabase)
        const fullLayer = CoordinatorLayer.pipe(Layer.provide(databaseLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // watchAll is forked as a daemon — poll until reconciliation
        // detects both the offline worktree addition and branch change.
        yield* Effect.promise(() =>
          waitFor(
            () =>
              Promise.resolve(
                listProjectWorkspaces(database, projectId).length === 2
              ),
            10_000,
            'watchAll reconciliation for offline worktree addition'
          )
        )

        const workspaces = listProjectWorkspaces(database, projectId)
        assert.strictEqual(
          workspaces.length,
          2,
          'Startup should detect worktree added while offline'
        )

        // Wait for branch refresh to complete as well
        yield* Effect.promise(() =>
          waitFor(
            () => {
              return Promise.resolve(
                database.findTask(workspaceId)?.branchName ===
                  'feature/offline-change'
              )
            },
            10_000,
            'watchAll branch refresh for offline changes'
          )
        )

        const mainWorkspace = database.findTask(workspaceId)
        assert.strictEqual(
          mainWorkspace?.branchName,
          'feature/offline-change',
          'Startup should refresh stale branch names from offline changes'
        )

        yield* Scope.close(scope, Exit.succeed(undefined))
      }).pipe(Effect.provide(LaborerDatabase.testLayer().pipe(Layer.orDie)))
  )

  it.effect(
    'project add through public API returns ready state with all refreshes complete',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-api-ready', tempRoots)

        // Create worktrees before registering the project
        const worktreeA = join(repoPath, '.worktrees', 'boot-api-a')
        const worktreeB = join(repoPath, '.worktrees', 'boot-api-b')
        git(`worktree add -b feature/api-a ${worktreeA}`, repoPath)
        git(`worktree add -b feature/api-b ${worktreeB}`, repoPath)

        // Switch a worktree to a different branch after creation
        git('checkout -b feature/api-a-switched', worktreeA)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)
        const { database } = yield* LaborerDatabase

        // All three worktrees should be present immediately after add
        const workspaces = listProjectWorkspaces(database, project.id)

        assert.strictEqual(
          workspaces.length,
          2,
          'Both linked worktrees should be detected'
        )

        // Branch names should reflect actual git state, including the
        // branch that was switched after worktree creation
        const branchNames = workspaces.map((w) => w.branchName)
        assert.isTrue(
          branchNames.includes('feature/api-a-switched'),
          'Switched branch should be detected by initial refresh'
        )
        assert.isTrue(
          branchNames.includes('feature/api-b'),
          'Worktree B branch should be correct'
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'public repo-watching stack stays consistent across branch refresh and worktree churn',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-public-e2e', tempRoots)
        const linkedA = join(repoPath, '.worktrees', 'boot-public-a')
        const linkedB = join(repoPath, '.worktrees', 'boot-public-b')

        const registry = yield* ProjectRegistry
        const { database } = yield* LaborerDatabase

        const project = yield* registry.addProject(repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        writeFileSync(
          join(repoPath, 'README.md'),
          '# public repo-watching e2e\n'
        )

        git(`worktree add -b feature/public-a ${linkedA}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listProjectWorkspaces(database, project.id)

            return Promise.resolve(
              workspaces.length === 1 &&
                workspaces.some(
                  (workspace) =>
                    workspace.worktreePath === realpathSync(linkedA)
                )
            )
          }, repoPath)
        )

        git(`worktree add -b feature/public-b ${linkedB}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listProjectWorkspaces(database, project.id)

            return Promise.resolve(
              workspaces.length === 2 &&
                workspaces.some(
                  (workspace) => workspace.branchName === 'feature/public-b'
                )
            )
          }, repoPath)
        )

        git(`worktree remove --force ${linkedA}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listProjectWorkspaces(database, project.id)

            const worktreePaths = workspaces.map(
              (workspace) => workspace.worktreePath
            )
            return Promise.resolve(
              workspaces.length === 1 &&
                new Set(worktreePaths).size === 1 &&
                workspaces.some(
                  (workspace) => workspace.branchName === 'feature/public-b'
                )
            )
          }, repoPath)
        )
        yield* Effect.promise(() => delay(700))

        git('checkout -b feature/public-b-refresh', linkedB)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listProjectWorkspaces(database, project.id)

            return Promise.resolve(
              workspaces.some(
                (workspace) =>
                  workspace.worktreePath === realpathSync(linkedB) &&
                  workspace.branchName === 'feature/public-b-refresh'
              )
            )
          }, repoPath)
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'server boot restores watchers for projects with persisted identity without re-resolving',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-persisted-identity', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'boot-persisted-wt')
        git(`worktree add -b feature/persisted-wt ${worktreePath}`, repoPath)

        const identity = deriveIdentity(repoPath)

        // Seed a project with fully-populated identity fields,
        // simulating a project created by a prior server session
        // that already wrote repoId and canonicalGitCommonDir.
        const laborerDatabase = yield* LaborerDatabase
        const { database } = laborerDatabase
        const projectId = 'project-boot-persisted'
        database.insertProject({
          canonicalGitCommonDir: identity.canonicalGitCommonDir,
          id: projectId,
          name: 'boot-persisted-identity',
          repoId: identity.repoId,
          rootPath: identity.canonicalRoot,
        })

        // Build the coordinator layer — watchAll should use the
        // persisted canonicalGitCommonDir directly, skipping
        // the identity re-resolution path.
        const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(BranchStateTracker.layer),
          Layer.provide(ConfigService.layer),
          Layer.provide(TestFileWatcherClientRealLayer),
          Layer.provide(WorktreeReconciler.layer),
          Layer.provide(WorktreeDetector.layer),
          Layer.provide(RepositoryIdentity.layer)
        )

        const scope = yield* Scope.make()
        const databaseLayer = Layer.succeed(LaborerDatabase, laborerDatabase)
        const fullLayer = CoordinatorLayer.pipe(Layer.provide(databaseLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // watchAll is forked as a daemon — poll until reconciliation
        // creates workspace records for both worktrees.
        yield* Effect.promise(() =>
          waitFor(
            () =>
              Promise.resolve(
                listProjectWorkspaces(database, projectId).length === 1
              ),
            10_000,
            'watchAll reconciliation for persisted identity'
          )
        )

        // Verify worktree reconciliation ran: both the main
        // checkout and the linked worktree should have workspace records.
        const workspaces = listProjectWorkspaces(database, projectId)
        assert.strictEqual(
          workspaces.length,
          1,
          'Startup with persisted identity should reconcile the linked worktree'
        )

        // Verify the watcher is running by adding another worktree
        // and waiting for automatic detection.
        const newWt = join(repoPath, '.worktrees', 'boot-persisted-wt2')
        git(`worktree add -b feature/persisted-wt2 ${newWt}`, repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(
            () =>
              Promise.resolve(
                listProjectWorkspaces(database, projectId).length === 2
              ),
            repoPath
          )
        )

        yield* Scope.close(scope, Exit.succeed(undefined))
      }).pipe(Effect.provide(LaborerDatabase.testLayer().pipe(Layer.orDie)))
  )

  it.effect(
    'startup restore produces the same workspace and branch state as fresh registration',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-parity', tempRoots)
        const worktreeA = join(repoPath, '.worktrees', 'boot-parity-a')
        const worktreeB = join(repoPath, '.worktrees', 'boot-parity-b')
        git(`worktree add -b feature/parity-a ${worktreeA}`, repoPath)
        git(`worktree add -b feature/parity-b ${worktreeB}`, repoPath)
        git('checkout -b feature/parity-main', repoPath)

        // ── Phase 1: Fresh registration ──────────────────────────
        const registry = yield* ProjectRegistry
        const freshProject = yield* registry.addProject(repoPath)
        const laborerDatabase = yield* LaborerDatabase
        const { database } = laborerDatabase

        const freshWorkspaces = listProjectWorkspaces(database, freshProject.id)

        const freshBranches = freshWorkspaces.map((w) => w.branchName).sort()
        const freshPaths = freshWorkspaces.map((w) => w.worktreePath).sort()

        assert.strictEqual(
          freshWorkspaces.length,
          2,
          'Fresh registration should detect both linked worktrees'
        )

        // Verify the project has persisted identity
        const freshProjectRecord = database.findProject(freshProject.id)
        assert.isNotNull(
          freshProjectRecord?.repoId,
          'Fresh project should have persisted repoId'
        )
        assert.isNotNull(
          freshProjectRecord?.canonicalGitCommonDir,
          'Fresh project should have persisted canonicalGitCommonDir'
        )

        // Remove the project to clean up watchers, then simulate
        // a restart by seeding the same project with its persisted
        // identity.
        yield* registry.removeProject(freshProject.id)

        // ── Phase 2: Simulate restart with persisted identity ────
        const restoredProjectId = 'project-boot-parity-restored'
        database.insertProject({
          canonicalGitCommonDir: freshProject.canonicalGitCommonDir ?? '',
          id: restoredProjectId,
          name: freshProject.name,
          repoId: freshProject.repoId ?? '',
          rootPath: freshProject.repoPath,
        })

        const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(BranchStateTracker.layer),
          Layer.provide(ConfigService.layer),
          Layer.provide(TestFileWatcherClientRealLayer),
          Layer.provide(WorktreeReconciler.layer),
          Layer.provide(WorktreeDetector.layer),
          Layer.provide(RepositoryIdentity.layer)
        )

        const scope = yield* Scope.make()
        const databaseLayer = Layer.succeed(LaborerDatabase, laborerDatabase)
        const fullLayer = CoordinatorLayer.pipe(Layer.provide(databaseLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // watchAll is forked as a daemon — poll until reconciliation
        // creates workspace records matching the fresh registration count.
        yield* Effect.promise(() =>
          waitFor(
            () =>
              Promise.resolve(
                listProjectWorkspaces(database, restoredProjectId).length ===
                  freshWorkspaces.length
              ),
            10_000,
            'watchAll reconciliation for restored project'
          )
        )

        // Compare restored state against fresh registration state
        const restoredWorkspaces = listProjectWorkspaces(
          database,
          restoredProjectId
        )

        const restoredBranches = restoredWorkspaces
          .map((w) => w.branchName)
          .sort()
        const restoredPaths = restoredWorkspaces
          .map((w) => w.worktreePath)
          .sort()

        assert.strictEqual(
          restoredWorkspaces.length,
          freshWorkspaces.length,
          'Restored state should have same number of workspaces as fresh registration'
        )
        assert.deepEqual(
          restoredBranches,
          freshBranches,
          'Restored branch names should match fresh registration'
        )
        assert.deepEqual(
          restoredPaths,
          freshPaths,
          'Restored worktree paths should match fresh registration'
        )

        yield* Scope.close(scope, Exit.succeed(undefined))
      }).pipe(Effect.provide(TestLayer))
  )
})
