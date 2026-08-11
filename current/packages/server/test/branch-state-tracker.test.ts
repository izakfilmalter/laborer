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
import { delay, waitFor, waitForWithNudge } from './helpers/timing-helpers.js'

const tempRoots: string[] = []
const TestDatabaseLayer = LaborerDatabase.testLayer().pipe(Layer.orDie)

const TestLayer = BranchStateTracker.layer.pipe(
  Layer.provideMerge(TestDatabaseLayer)
)

const CoordinatorTestLayer = RepositoryWatchCoordinator.layer.pipe(
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
  projectRoot: string,
  workspaceId: string,
  branchName: string,
  worktreePath: string
) =>
  database.insertTask({
    branchName,
    id: workspaceId,
    rootPath: realpathSync(projectRoot),
    source: 'worktree',
    status: 'in_progress',
    title: branchName,
    worktreePath: realpathSync(worktreePath),
    worktreeStatus: 'ready',
  })

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('BranchStateTracker', () => {
  it.scoped('refreshes branch name when workspace branch is stale', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('branch-refresh-stale', tempRoots)
      const worktreePath = join(repoPath, '.worktrees', 'branch-stale')
      git(`worktree add -b feature/stale ${worktreePath}`, repoPath)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { database } = yield* LaborerDatabase
      createProject(database, projectId, repoPath)
      createWorkspace(
        database,
        repoPath,
        workspaceId,
        'feature/stale',
        worktreePath
      )

      // Switch the worktree to a different branch
      git('checkout -b feature/updated', worktreePath)

      const tracker = yield* BranchStateTracker
      const result = yield* tracker.refreshBranches(projectId)

      assert.strictEqual(result.checked, 1)
      assert.strictEqual(result.updated, 1)

      assert.strictEqual(
        database.findTask(workspaceId)?.branchName,
        'feature/updated'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('does not update when branch name is already current', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('branch-refresh-current', tempRoots)
      const worktreePath = join(repoPath, '.worktrees', 'branch-current')
      git(`worktree add -b feature/current ${worktreePath}`, repoPath)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { database } = yield* LaborerDatabase
      createProject(database, projectId, repoPath)
      createWorkspace(
        database,
        repoPath,
        workspaceId,
        'feature/current',
        worktreePath
      )

      const tracker = yield* BranchStateTracker
      const result = yield* tracker.refreshBranches(projectId)

      assert.strictEqual(result.checked, 1)
      assert.strictEqual(result.updated, 0)

      assert.strictEqual(
        database.findTask(workspaceId)?.branchName,
        'feature/current'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('refreshes multiple workspaces in one pass', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('branch-refresh-multi', tempRoots)
      const worktreeA = join(repoPath, '.worktrees', 'branch-multi-a')
      const worktreeB = join(repoPath, '.worktrees', 'branch-multi-b')
      git(`worktree add -b feature/multi-a ${worktreeA}`, repoPath)
      git(`worktree add -b feature/multi-b ${worktreeB}`, repoPath)

      const projectId = crypto.randomUUID()
      const wsIdA = crypto.randomUUID()
      const wsIdB = crypto.randomUUID()

      const { database } = yield* LaborerDatabase
      createProject(database, projectId, repoPath)
      createWorkspace(database, repoPath, wsIdA, 'feature/multi-a', worktreeA)
      createWorkspace(database, repoPath, wsIdB, 'feature/multi-b', worktreeB)

      // Switch both worktrees to new branches
      git('checkout -b feature/multi-a-new', worktreeA)
      git('checkout -b feature/multi-b-new', worktreeB)

      const tracker = yield* BranchStateTracker
      const result = yield* tracker.refreshBranches(projectId)

      assert.strictEqual(result.checked, 2)
      assert.strictEqual(result.updated, 2)

      assert.strictEqual(
        database.findTask(wsIdA)?.branchName,
        'feature/multi-a-new'
      )
      assert.strictEqual(
        database.findTask(wsIdB)?.branchName,
        'feature/multi-b-new'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('skips destroyed workspaces during branch refresh', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('branch-refresh-destroyed', tempRoots)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { database } = yield* LaborerDatabase
      createProject(database, projectId, repoPath)
      createWorkspace(database, repoPath, workspaceId, 'main', repoPath)
      const task = database.findTask(workspaceId)
      assert.isNotNull(task)
      if (task === null) {
        assert.fail('Expected workspace task')
      }
      database.updateTask(task.id, task.revision, {
        worktreePath: null,
        worktreeStatus: null,
      })

      const tracker = yield* BranchStateTracker
      const result = yield* tracker.refreshBranches(projectId)

      assert.strictEqual(result.checked, 0)
      assert.strictEqual(result.updated, 0)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('detects detached HEAD state during branch refresh', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('branch-refresh-detached', tempRoots)
      const worktreePath = join(repoPath, '.worktrees', 'branch-detached')
      git(`worktree add -b feature/detach ${worktreePath}`, repoPath)

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { database } = yield* LaborerDatabase
      createProject(database, projectId, repoPath)
      createWorkspace(
        database,
        repoPath,
        workspaceId,
        'feature/detach',
        worktreePath
      )

      // Detach HEAD in the worktree
      const headSha = git('rev-parse HEAD', worktreePath)
      git(`checkout ${headSha}`, worktreePath)

      const tracker = yield* BranchStateTracker
      const result = yield* tracker.refreshBranches(projectId)

      assert.strictEqual(result.updated, 1)

      assert.isTrue(
        database.findTask(workspaceId)?.branchName?.startsWith('detached/')
      )
    }).pipe(Effect.provide(TestLayer))
  )
})

describe('RepositoryWatchCoordinator branch refresh integration', () => {
  it.scoped(
    'branch switch on main worktree triggers branch refresh through the coordinator',
    () =>
      Effect.gen(function* () {
        // Use a repo without linked worktrees so the coordinator
        // watches .git/ directly (where HEAD lives). A branch switch
        // on the main worktree modifies .git/HEAD which fs.watch sees.
        const repoPath = initRepo('coord-branch-refresh', tempRoots)

        const coordinator = yield* RepositoryWatchCoordinator
        const { database } = yield* LaborerDatabase

        const projectId = 'project-coord-branch'
        createProject(database, projectId, repoPath)
        createWorkspace(
          database,
          repoPath,
          'workspace-coord-branch',
          'main',
          repoPath
        )

        // Use watchProject (idempotent) instead of watchAll to avoid
        // racing with the daemon watchAll fired during layer construction.
        yield* coordinator.watchProject(projectId, repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        // Wait for initial reconciliation to create workspace record
        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              listWorkspaceRecords(database).filter(
                (workspace) => workspace.projectId === projectId
              ).length >= 1
            )
          )
        )

        // Verify the initial branch name
        const initialWorkspaces = listWorkspaceRecords(database).filter(
          (workspace) => workspace.projectId === projectId
        )
        const initialBranch = initialWorkspaces[0]?.branchName

        // Switch branch on the main worktree (modifies .git/HEAD)
        git('checkout -b feature/coord-branch-updated', repoPath)

        // Wait for the branch name to be refreshed
        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listWorkspaceRecords(database).filter(
              (workspace) => workspace.projectId === projectId
            )
            return Promise.resolve(
              workspaces.some(
                (w) => w.branchName === 'feature/coord-branch-updated'
              )
            )
          }, repoPath)
        )

        const workspaces = listWorkspaceRecords(database).filter(
          (workspace) => workspace.projectId === projectId
        )
        const updatedWorkspace = workspaces.find(
          (w) => w.branchName === 'feature/coord-branch-updated'
        )
        assert.isDefined(updatedWorkspace)
        assert.notStrictEqual(
          initialBranch,
          'feature/coord-branch-updated',
          'Branch should have been different initially'
        )
      }).pipe(Effect.provide(CoordinatorTestLayer))
  )

  it.scoped(
    'branch switch on main worktree still refreshes after linked worktrees are present',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('coord-main-branch-with-linked', tempRoots)
        const linkedPath = join(
          repoPath,
          '.worktrees',
          'coord-main-branch-with-linked'
        )
        git(`worktree add -b feature/linked-existing ${linkedPath}`, repoPath)
        const canonicalRepoPath = realpathSync(repoPath)

        const coordinator = yield* RepositoryWatchCoordinator
        const { database } = yield* LaborerDatabase

        const projectId = 'project-coord-main-branch-with-linked'
        createProject(database, projectId, repoPath)
        createWorkspace(
          database,
          repoPath,
          'workspace-coord-main',
          'main',
          repoPath
        )
        createWorkspace(
          database,
          repoPath,
          'workspace-coord-linked-existing',
          'feature/linked-existing',
          linkedPath
        )

        // Use watchProject (idempotent) instead of watchAll to avoid
        // racing with the daemon watchAll fired during layer construction.
        yield* coordinator.watchProject(projectId, repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              listWorkspaceRecords(database).filter(
                (workspace) => workspace.projectId === projectId
              ).length === 2
            )
          )
        )

        git('checkout -b feature/main-after-linked', repoPath)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listWorkspaceRecords(database).filter(
              (workspace) => workspace.projectId === projectId
            )

            return Promise.resolve(
              workspaces.some(
                (workspace) =>
                  workspace.worktreePath === canonicalRepoPath &&
                  workspace.branchName === 'feature/main-after-linked'
              )
            )
          }, repoPath)
        )

        const workspaces = listWorkspaceRecords(database).filter(
          (workspace) => workspace.projectId === projectId
        )
        assert.isDefined(
          workspaces.find(
            (workspace) =>
              workspace.worktreePath === canonicalRepoPath &&
              workspace.branchName === 'feature/main-after-linked'
          )
        )
      }).pipe(Effect.provide(CoordinatorTestLayer))
  )

  it.scoped(
    'branch switch on linked worktree refreshes through the dedicated worktrees watcher',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('coord-linked-branch-refresh', tempRoots)
        const linkedPath = join(
          repoPath,
          '.worktrees',
          'coord-linked-branch-refresh'
        )
        git(`worktree add -b feature/linked-start ${linkedPath}`, repoPath)
        const canonicalLinkedPath = realpathSync(linkedPath)

        const coordinator = yield* RepositoryWatchCoordinator
        const { database } = yield* LaborerDatabase

        const projectId = 'project-coord-linked-branch-refresh'
        createProject(database, projectId, repoPath)
        createWorkspace(
          database,
          repoPath,
          'workspace-coord-linked-refresh',
          'feature/linked-start',
          linkedPath
        )

        // Use watchProject (idempotent) instead of watchAll to avoid
        // racing with the daemon watchAll fired during layer construction.
        yield* coordinator.watchProject(projectId, repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              listWorkspaceRecords(database).filter(
                (workspace) => workspace.projectId === projectId
              ).length === 1
            )
          )
        )

        git('checkout -b feature/linked-updated', linkedPath)

        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listWorkspaceRecords(database).filter(
              (workspace) => workspace.projectId === projectId
            )

            return Promise.resolve(
              workspaces.some(
                (workspace) =>
                  workspace.worktreePath === canonicalLinkedPath &&
                  workspace.branchName === 'feature/linked-updated'
              )
            )
          }, repoPath)
        )

        const workspaces = listWorkspaceRecords(database).filter(
          (workspace) => workspace.projectId === projectId
        )
        assert.isDefined(
          workspaces.find(
            (workspace) =>
              workspace.worktreePath === canonicalLinkedPath &&
              workspace.branchName === 'feature/linked-updated'
          )
        )
      }).pipe(Effect.provide(CoordinatorTestLayer))
  )

  it.scoped(
    'worktree metadata changes trigger both reconciliation and branch refresh',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('coord-both-triggers', tempRoots)

        const coordinator = yield* RepositoryWatchCoordinator
        const { database } = yield* LaborerDatabase

        const projectId = 'project-coord-both'
        createProject(database, projectId, repoPath)
        createWorkspace(
          database,
          repoPath,
          'workspace-coord-both-main',
          'main',
          repoPath
        )
        const missingPath = join(repoPath, '.worktrees', 'missing')
        database.insertTask({
          branchName: 'feature/missing',
          id: 'workspace-coord-both-missing',
          rootPath: realpathSync(repoPath),
          source: 'worktree',
          status: 'in_progress',
          title: 'feature/missing',
          worktreePath: missingPath,
          worktreeStatus: 'ready',
        })

        // Use watchProject (idempotent) instead of watchAll to avoid
        // racing with the daemon watchAll fired during layer construction.
        yield* coordinator.watchProject(projectId, repoPath)
        // Allow @parcel/watcher FSEvents subscription to fully initialize
        yield* Effect.promise(() => delay(500))

        // Initial reconciliation releases the stale missing worktree, leaving
        // only the main checkout.
        yield* Effect.promise(() =>
          waitFor(() =>
            Promise.resolve(
              listWorkspaceRecords(database).filter(
                (workspace) => workspace.projectId === projectId
              ).length === 1
            )
          )
        )

        // Add a worktree — this creates .git/worktrees/<name>
        // which should trigger both reconciliation AND branch refresh
        const worktreePath = join(repoPath, '.worktrees', 'coord-both-triggers')
        git(`worktree add -b feature/both-triggers ${worktreePath}`, repoPath)
        yield* Effect.promise(() => delay(500))
        git('checkout -b feature/both-main-updated', repoPath)

        // Reconciliation releases the missing worktree and adopts the new
        // worktree while branch refresh updates the main checkout.
        yield* Effect.promise(() =>
          waitForWithNudge(() => {
            const workspaces = listWorkspaceRecords(database).filter(
              (workspace) => workspace.projectId === projectId
            )
            return Promise.resolve(
              workspaces.length === 2 &&
                workspaces.some(
                  (workspace) =>
                    workspace.branchName === 'feature/both-main-updated'
                ) &&
                workspaces.some(
                  (workspace) =>
                    workspace.branchName === 'feature/both-triggers'
                )
            )
          }, repoPath)
        )

        assert.strictEqual(
          database.findTask('workspace-coord-both-missing')?.worktreePath,
          null
        )
      }).pipe(Effect.provide(CoordinatorTestLayer))
  )
})
