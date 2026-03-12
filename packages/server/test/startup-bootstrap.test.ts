import { createHash } from 'node:crypto'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Exit, Layer, Scope } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientRealLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'
import { delay, waitFor } from './helpers/timing-helpers.js'

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
  Layer.provide(PortAllocator.make(4700, 4750)),
  Layer.provideMerge(TestLaborerStore)
)

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('Startup bootstrap and project lifecycle integration', () => {
  it.scoped(
    'project add performs canonical discovery and initial refresh before returning ready state',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-add-ready', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'boot-feature')
        git(`worktree add -b feature/boot-test ${worktreePath}`, repoPath)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)

        const { store } = yield* LaborerStore

        // After addProject returns, workspace records should already
        // exist with correct branch names — no waiting needed.
        const workspaces = store.query(
          tables.workspaces.where('projectId', project.id)
        ) as readonly {
          readonly branchName: string
          readonly worktreePath: string
        }[]

        // Both the main worktree and the linked worktree should be present
        assert.strictEqual(
          workspaces.length,
          2,
          'Both worktrees should be reconciled before project is ready'
        )

        // Branch names should already be populated from initial refresh
        const branchNames = workspaces.map((w) => w.branchName).sort()
        assert.isTrue(
          branchNames.includes('feature/boot-test'),
          'Linked worktree branch should be set'
        )
        assert.isTrue(
          branchNames.some((b) => b === 'main' || b === 'master'),
          'Main worktree branch should be set'
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('project add starts the repository watcher coordinator', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('boot-add-watcher', tempRoots)

      const registry = yield* ProjectRegistry
      const project = yield* registry.addProject(repoPath)

      const { store } = yield* LaborerStore

      // After addProject, the watcher should be running. Creating a
      // worktree should be detected automatically via the coordinator.
      const worktreePath = join(repoPath, '.worktrees', 'boot-watcher')
      git(`worktree add -b feature/boot-watcher ${worktreePath}`, repoPath)

      yield* Effect.promise(() =>
        waitFor(() =>
          Promise.resolve(
            store.query(tables.workspaces.where('projectId', project.id))
              .length === 2
          )
        )
      )

      const workspaces = store.query(
        tables.workspaces.where('projectId', project.id)
      )
      assert.strictEqual(
        workspaces.length,
        2,
        'Watcher should detect new worktree after addProject'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('server boot restores watchers for all persisted projects', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('boot-restore', tempRoots)

      // Simulate a prior server session: seed a project directly
      // into the store before building the coordinator layer.
      const { store } = yield* LaborerStore
      const projectId = 'project-boot-restore'
      store.commit(
        events.projectCreated({
          id: projectId,
          repoPath,
          name: 'boot-restore',
          rlphConfig: null,
        })
      )

      // Build the coordinator layer (which calls watchAll at startup)
      const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
        Layer.provide(BranchStateTracker.layer),
        Layer.provide(ConfigService.layer),
        Layer.provide(TestFileWatcherClientRealLayer),
        Layer.provide(WorktreeReconciler.layer),
        Layer.provide(WorktreeDetector.layer),
        Layer.provide(RepositoryIdentity.layer),
        Layer.provide(PortAllocator.make(4751, 4760))
      )

      // Use a manual scope to simulate server lifecycle
      const scope = yield* Scope.make()

      const storeLayer = Layer.succeed(LaborerStore, LaborerStore.of({ store }))

      const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer))

      yield* Layer.buildWithScope(fullLayer, scope)

      // After layer construction, watchAll has run: reconciliation
      // should have created a workspace for the main checkout
      const workspaces = store.query(
        tables.workspaces.where('projectId', projectId)
      )
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
        waitFor(() =>
          Promise.resolve(
            store.query(tables.workspaces.where('projectId', projectId))
              .length === 2
          )
        )
      )

      yield* Scope.close(scope, Exit.succeed(undefined))
    }).pipe(Effect.provide(TestLaborerStore))
  )

  it.scoped(
    'server boot reconciles worktree and branch state that changed while offline',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-offline', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'boot-offline-wt')

        // Simulate prior server session state: project and one workspace
        const { store } = yield* LaborerStore
        const projectId = 'project-boot-offline'
        const workspaceId = crypto.randomUUID()

        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'boot-offline',
            rlphConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'main',
            worktreePath: repoPath,
            port: 0,
            status: 'stopped',
            origin: 'external',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

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
          Layer.provide(RepositoryIdentity.layer),
          Layer.provide(PortAllocator.make(4761, 4770))
        )

        const scope = yield* Scope.make()

        const storeLayer = Layer.succeed(
          LaborerStore,
          LaborerStore.of({ store })
        )

        const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // After startup, the offline worktree addition should be reconciled
        const workspaces = store.query(
          tables.workspaces.where('projectId', projectId)
        )
        assert.strictEqual(
          workspaces.length,
          2,
          'Startup should detect worktree added while offline'
        )

        // The branch change on main should be reconciled
        const mainWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        ) as readonly { readonly branchName: string }[]
        assert.strictEqual(
          mainWorkspace[0]?.branchName,
          'feature/offline-change',
          'Startup should refresh stale branch names from offline changes'
        )

        yield* Scope.close(scope, Exit.succeed(undefined))
      }).pipe(Effect.provide(TestLaborerStore))
  )

  it.scoped(
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

        const { store } = yield* LaborerStore

        // All three worktrees should be present immediately after add
        const workspaces = store.query(
          tables.workspaces.where('projectId', project.id)
        ) as readonly {
          readonly branchName: string
          readonly worktreePath: string
        }[]

        assert.strictEqual(
          workspaces.length,
          3,
          'All three worktrees should be detected'
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

  it.scoped(
    'public repo-watching stack stays consistent across branch refresh and worktree churn',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('boot-public-e2e', tempRoots)
        const canonicalRepoPath = realpathSync(repoPath)
        const linkedA = join(repoPath, '.worktrees', 'boot-public-a')
        const linkedB = join(repoPath, '.worktrees', 'boot-public-b')

        const registry = yield* ProjectRegistry
        const { store } = yield* LaborerStore

        const project = yield* registry.addProject(repoPath)
        yield* Effect.promise(() => delay(200))

        writeFileSync(
          join(repoPath, 'README.md'),
          '# public repo-watching e2e\n'
        )

        git(`worktree add -b feature/public-a ${linkedA}`, repoPath)

        yield* Effect.promise(() =>
          waitFor(() => {
            const workspaces = store.query(
              tables.workspaces.where('projectId', project.id)
            ) as readonly {
              readonly branchName: string
              readonly worktreePath: string
            }[]

            return Promise.resolve(
              workspaces.length === 2 &&
                workspaces.some(
                  (workspace) =>
                    workspace.worktreePath === realpathSync(linkedA)
                )
            )
          })
        )

        git(`worktree add -b feature/public-b ${linkedB}`, repoPath)

        yield* Effect.promise(() =>
          waitFor(() => {
            const workspaces = store.query(
              tables.workspaces.where('projectId', project.id)
            ) as readonly {
              readonly branchName: string
              readonly worktreePath: string
            }[]

            return Promise.resolve(
              workspaces.length === 3 &&
                workspaces.some(
                  (workspace) => workspace.branchName === 'feature/public-b'
                )
            )
          })
        )

        git(`worktree remove --force ${linkedA}`, repoPath)

        yield* Effect.promise(() =>
          waitFor(() => {
            const workspaces = store.query(
              tables.workspaces.where('projectId', project.id)
            ) as readonly {
              readonly branchName: string
              readonly worktreePath: string
            }[]

            const worktreePaths = workspaces.map(
              (workspace) => workspace.worktreePath
            )
            return Promise.resolve(
              workspaces.length === 2 &&
                new Set(worktreePaths).size === 2 &&
                workspaces.some(
                  (workspace) => workspace.branchName === 'feature/public-b'
                )
            )
          })
        )
        yield* Effect.promise(() => delay(700))

        git('checkout -b feature/public-main-refresh', repoPath)

        yield* Effect.promise(() =>
          waitFor(() => {
            const workspaces = store.query(
              tables.workspaces.where('projectId', project.id)
            ) as readonly {
              readonly branchName: string
              readonly worktreePath: string
            }[]

            return Promise.resolve(
              workspaces.some(
                (workspace) =>
                  workspace.worktreePath === canonicalRepoPath &&
                  workspace.branchName === 'feature/public-main-refresh'
              )
            )
          })
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
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
        const { store } = yield* LaborerStore
        const projectId = 'project-boot-persisted'
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath: identity.canonicalRoot,
            repoId: identity.repoId,
            canonicalGitCommonDir: identity.canonicalGitCommonDir,
            name: 'boot-persisted-identity',
            rlphConfig: null,
          })
        )

        // Build the coordinator layer — watchAll should use the
        // persisted canonicalGitCommonDir directly, skipping
        // the identity re-resolution path.
        const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(BranchStateTracker.layer),
          Layer.provide(ConfigService.layer),
          Layer.provide(TestFileWatcherClientRealLayer),
          Layer.provide(WorktreeReconciler.layer),
          Layer.provide(WorktreeDetector.layer),
          Layer.provide(RepositoryIdentity.layer),
          Layer.provide(PortAllocator.make(4771, 4780))
        )

        const scope = yield* Scope.make()
        const storeLayer = Layer.succeed(
          LaborerStore,
          LaborerStore.of({ store })
        )
        const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // Verify worktree reconciliation ran: both the main
        // checkout and the linked worktree should have workspace records.
        const workspaces = store.query(
          tables.workspaces.where('projectId', projectId)
        )
        assert.strictEqual(
          workspaces.length,
          2,
          'Startup with persisted identity should reconcile all worktrees'
        )

        // Verify the watcher is running by adding another worktree
        // and waiting for automatic detection.
        const newWt = join(repoPath, '.worktrees', 'boot-persisted-wt2')
        git(`worktree add -b feature/persisted-wt2 ${newWt}`, repoPath)

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              store.query(tables.workspaces.where('projectId', projectId))
                .length === 3
            )
          )
        )

        yield* Scope.close(scope, Exit.succeed(undefined))
      }).pipe(Effect.provide(TestLaborerStore))
  )

  it.scoped(
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
        const { store } = yield* LaborerStore

        const freshWorkspaces = store.query(
          tables.workspaces.where('projectId', freshProject.id)
        ) as readonly {
          readonly branchName: string
          readonly worktreePath: string
        }[]

        const freshBranches = freshWorkspaces.map((w) => w.branchName).sort()
        const freshPaths = freshWorkspaces.map((w) => w.worktreePath).sort()

        assert.strictEqual(
          freshWorkspaces.length,
          3,
          'Fresh registration should detect all three worktrees'
        )

        // Verify the project has persisted identity
        const freshProjectRecord = store.query(
          tables.projects.where('id', freshProject.id)
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.isNotNull(
          freshProjectRecord[0]?.repoId,
          'Fresh project should have persisted repoId'
        )
        assert.isNotNull(
          freshProjectRecord[0]?.canonicalGitCommonDir,
          'Fresh project should have persisted canonicalGitCommonDir'
        )

        // Remove the project to clean up watchers, then simulate
        // a restart by seeding the same project with its persisted
        // identity.
        yield* registry.removeProject(freshProject.id)

        // ── Phase 2: Simulate restart with persisted identity ────
        const restoredProjectId = 'project-boot-parity-restored'
        store.commit(
          events.projectCreated({
            id: restoredProjectId,
            repoPath: freshProject.repoPath,
            repoId: freshProject.repoId,
            canonicalGitCommonDir: freshProject.canonicalGitCommonDir,
            name: freshProject.name,
            rlphConfig: null,
          })
        )

        const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
          Layer.provide(BranchStateTracker.layer),
          Layer.provide(ConfigService.layer),
          Layer.provide(TestFileWatcherClientRealLayer),
          Layer.provide(WorktreeReconciler.layer),
          Layer.provide(WorktreeDetector.layer),
          Layer.provide(RepositoryIdentity.layer),
          Layer.provide(PortAllocator.make(4781, 4790))
        )

        const scope = yield* Scope.make()
        const storeLayer = Layer.succeed(
          LaborerStore,
          LaborerStore.of({ store })
        )
        const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer))

        yield* Layer.buildWithScope(fullLayer, scope)

        // Compare restored state against fresh registration state
        const restoredWorkspaces = store.query(
          tables.workspaces.where('projectId', restoredProjectId)
        ) as readonly {
          readonly branchName: string
          readonly worktreePath: string
        }[]

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
