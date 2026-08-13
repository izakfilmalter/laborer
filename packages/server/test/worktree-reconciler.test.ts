import {
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type {
  NativeLaborerDatabase,
  NewLaborerTask,
} from '../src/services/native-laborer-database.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'

const tempRoots: string[] = []

const getDefaultBranchForTest = (repoPath: string): string => {
  try {
    git('rev-parse --verify refs/heads/main', repoPath)
    return 'main'
  } catch {
    // fall through
  }

  try {
    git('rev-parse --verify refs/heads/master', repoPath)
    return 'master'
  } catch {
    return 'HEAD'
  }
}

const getDetectedWorktreePaths = (repoPath: string): string[] =>
  git('worktree list --porcelain', repoPath)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))

const TestLayer = WorktreeReconciler.layer.pipe(
  Layer.provideMerge(RepositoryIdentity.layer),
  Layer.provideMerge(WorktreeDetector.layer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

const insertProject = (
  database: NativeLaborerDatabase,
  id: string,
  rootPath: string
) =>
  database.insertProject({
    canonicalGitCommonDir: join(realpathSync(rootPath), '.git'),
    id,
    name: id,
    repoId: id,
    rootPath: realpathSync(rootPath),
  })

const insertWorkspaceTask = (
  database: NativeLaborerDatabase,
  input: NewLaborerTask
) => database.insertTask(input)

const listSharedTasksForRoot = (
  database: NativeLaborerDatabase,
  rootPath: string
) =>
  database
    .listTasks()
    .filter((task) => task.rootPath === realpathSync(rootPath))

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('WorktreeReconciler', () => {
  it.effect('creates external tasks for detected linked worktrees', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-create', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-c')
      git(`worktree add -b feature/c ${linkedPath}`, repoPath)

      const { database } = yield* LaborerDatabase
      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-1', repoPath)

      assert.strictEqual(result.added, 2)

      const rows = listSharedTasksForRoot(database, repoPath)

      assert.strictEqual(rows.length, 1)
      for (const row of rows) {
        assert.strictEqual(row.source, 'worktree')
        assert.strictEqual(row.status, 'in_progress')
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('leaves matching existing workspace records untouched', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-unchanged', tempRoots)
      const [mainWorktreePath] = getDetectedWorktreePaths(repoPath)

      const { database } = yield* LaborerDatabase
      insertProject(database, 'project-unchanged', repoPath)
      insertWorkspaceTask(database, {
        id: 'existing-main-workspace',
        rootPath: realpathSync(repoPath),
        source: 'manual',
        title: 'custom/main',
        branchName: 'custom/main',
        worktreePath: mainWorktreePath ?? repoPath,
        status: 'in_progress',
        worktreeStatus: 'ready',
        baseSha: 'custom-base-sha',
      })

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-unchanged', repoPath)

      assert.strictEqual(result.added, 0)
      assert.strictEqual(result.removed, 0)
      assert.strictEqual(result.unchanged, 1)

      const rows = database.listTasks()

      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0]?.id, 'existing-main-workspace')
      assert.strictEqual(rows[0]?.source, 'manual')
      assert.strictEqual(rows[0]?.status, 'in_progress')
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('removes stale workspace records not present on disk', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-stale', tempRoots)
      const stalePath = join(repoPath, '.worktrees', 'missing')

      const { database } = yield* LaborerDatabase
      insertProject(database, 'project-2', repoPath)
      insertWorkspaceTask(database, {
        id: 'stale-workspace',
        rootPath: realpathSync(repoPath),
        source: 'worktree',
        title: 'feature/missing',
        branchName: 'feature/missing',
        worktreePath: stalePath,
        status: 'in_progress',
        worktreeStatus: 'ready',
        baseSha: null,
      })

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-2', repoPath)

      assert.strictEqual(result.removed, 1)

      assert.isNull(database.findTask('stale-workspace')?.worktreePath)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'does not remove workspaces with creating status whose worktree is not yet on disk',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-creating', tempRoots)
        const pendingPath = join(repoPath, '.worktrees', 'pending-branch')

        const { database } = yield* LaborerDatabase
        insertProject(database, 'project-creating', repoPath)
        insertWorkspaceTask(database, {
          id: 'creating-workspace',
          rootPath: realpathSync(repoPath),
          source: 'manual',
          title: 'feature/pending',
          branchName: 'feature/pending',
          worktreePath: pendingPath,
          status: 'in_progress',
          worktreeStatus: 'provisioning',
          baseSha: null,
        })

        const reconciler = yield* WorktreeReconciler
        const result = yield* reconciler.reconcile('project-creating', repoPath)

        // The creating workspace should NOT be removed
        assert.strictEqual(result.removed, 0)

        const task = database.findTask('creating-workspace')
        assert.strictEqual(task?.worktreePath, pendingPath)
        assert.strictEqual(task?.worktreeStatus, 'provisioning')
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect('handles mixed add, remove, and unchanged reconciliation', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-mixed', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-mixed')
      const stalePath = join(repoPath, '.worktrees', 'missing-mixed')
      git(`worktree add -b feature/mixed ${linkedPath}`, repoPath)
      const [mainWorktreePath] = getDetectedWorktreePaths(repoPath)

      const { database } = yield* LaborerDatabase
      insertProject(database, 'project-mixed', repoPath)
      insertWorkspaceTask(database, {
        id: 'existing-main',
        rootPath: realpathSync(repoPath),
        source: 'worktree',
        title: 'main',
        branchName: 'main',
        worktreePath: mainWorktreePath ?? repoPath,
        status: 'in_progress',
        worktreeStatus: 'ready',
        baseSha: null,
      })
      insertWorkspaceTask(database, {
        id: 'stale-workspace',
        rootPath: realpathSync(repoPath),
        source: 'worktree',
        title: 'feature/stale',
        branchName: 'feature/stale',
        worktreePath: stalePath,
        status: 'in_progress',
        worktreeStatus: 'ready',
        baseSha: null,
      })

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-mixed', repoPath)

      assert.strictEqual(result.added, 1)
      assert.strictEqual(result.removed, 1)
      assert.strictEqual(result.unchanged, 1)

      assert.isNotNull(database.findTask('existing-main')?.worktreePath)
      assert.isNull(database.findTask('stale-workspace')?.worktreePath)
      assert.isTrue(
        listSharedTasksForRoot(database, repoPath).some(
          (row) => row.branchName === 'feature/mixed'
        )
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('derives base SHA from merge-base for detected worktrees', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-base-sha', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-base-sha')
      git(`worktree add -b feature/base-sha ${linkedPath}`, repoPath)
      writeFileSync(join(linkedPath, 'feature.txt'), 'feature branch content\n')
      git('add feature.txt', linkedPath)
      git('commit -m "feature commit"', linkedPath)

      const { database } = yield* LaborerDatabase
      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-base-sha', repoPath)

      assert.strictEqual(result.added, 2)

      const defaultBranch = getDefaultBranchForTest(repoPath)
      const expectedBaseSha = git(
        `merge-base ${defaultBranch} feature/base-sha`,
        repoPath
      )
      const rows = listSharedTasksForRoot(database, repoPath)

      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0]?.baseSha, expectedBaseSha)
    }).pipe(Effect.provide(TestLayer))
  )
})

// ---------------------------------------------------------------------------
// Historical remote-only workspaces — no local worktree
// ---------------------------------------------------------------------------

describe('WorktreeReconciler historical remote-only workspaces', () => {
  it.effect('removes workspaces with an empty worktreePath as stale', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-remote-stale', tempRoots)

      const { database } = yield* LaborerDatabase
      insertProject(database, 'project-remote', repoPath)
      insertWorkspaceTask(database, {
        id: 'remote-workspace-1',
        rootPath: realpathSync(repoPath),
        source: 'manual',
        title: 'feature/remote-test',
        branchName: 'feature/remote-test',
        worktreePath: '',
        status: 'in_progress',
        worktreeStatus: 'ready',
        baseSha: null,
      })
      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-remote', repoPath)

      assert.strictEqual(result.removed, 1)

      assert.isNull(database.findTask('remote-workspace-1')?.worktreePath)
    }).pipe(Effect.provide(TestLayer))
  )
})

// ---------------------------------------------------------------------------
// Canonical worktree reconciliation — Issue 2
// ---------------------------------------------------------------------------

describe('WorktreeReconciler canonical path support', () => {
  it.effect('stores canonical worktree paths in workspace records', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-canonical-paths', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-canon')
      git(`worktree add -b feature/canon ${linkedPath}`, repoPath)

      const { database } = yield* LaborerDatabase
      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-canonical', repoPath)

      assert.strictEqual(result.added, 2)

      const rows = listSharedTasksForRoot(database, repoPath)

      // All stored worktreePaths should be canonical (realpath-resolved)
      for (const row of rows) {
        if (row.worktreePath === null) {
          throw new Error('Translated task should own a worktree')
        }
        const canonical = realpathSync(row.worktreePath)
        assert.strictEqual(
          row.worktreePath,
          canonical,
          `Stored worktreePath should be canonical: ${row.worktreePath}`
        )
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'reconciles linked worktrees outside the main checkout under the correct project',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-external-wt', tempRoots)
        const externalDir = createTempDir(
          'reconciler-external-wt-dir',
          tempRoots
        )
        const externalLinkedPath = join(externalDir, 'external-wt')
        git(`worktree add -b feature/external ${externalLinkedPath}`, repoPath)

        const { database } = yield* LaborerDatabase
        const reconciler = yield* WorktreeReconciler
        const result = yield* reconciler.reconcile(
          'project-external-wt',
          repoPath
        )

        // Reconciliation sees both, while only the linked worktree becomes a task.
        assert.strictEqual(result.added, 2)

        const rows = listSharedTasksForRoot(database, repoPath)

        assert.strictEqual(rows.length, 1)
        assert.isTrue(
          rows.some(
            (row) => row.worktreePath === realpathSync(externalLinkedPath)
          ),
          'External linked worktree should be detected with canonical path'
        )
        assert.isTrue(
          rows.every((row) => row.source === 'worktree'),
          "All detected worktrees should have source 'worktree'"
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'does not create duplicate tasks when reconciling with symlinked repo path',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-symlink-dedup', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'feature-sym')
        git(`worktree add -b feature/sym ${linkedPath}`, repoPath)

        // Create a symlink to the repo
        const symlinkDir = createTempDir(
          'reconciler-symlink-dedup-link',
          tempRoots
        )
        const symlinkPath = join(symlinkDir, 'linked-repo')
        symlinkSync(repoPath, symlinkPath)

        const { database } = yield* LaborerDatabase
        const reconciler = yield* WorktreeReconciler

        // First reconcile via the real path
        const result1 = yield* reconciler.reconcile(
          'project-sym-dedup',
          repoPath
        )
        assert.strictEqual(result1.added, 2)

        const tasksAfterFirstReconcile = listSharedTasksForRoot(
          database,
          repoPath
        )
        assert.strictEqual(tasksAfterFirstReconcile.length, 1)

        // The service-local workspace projection is intentionally separate
        // from translated shared tasks, but translation remains idempotent.
        const result2 = yield* reconciler.reconcile(
          'project-sym-dedup',
          symlinkPath
        )
        assert.strictEqual(result2.added, 2)
        assert.strictEqual(result2.removed, 0)
        assert.strictEqual(listSharedTasksForRoot(database, repoPath).length, 1)
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'canonicalizes existing workspace paths when comparing against detected worktrees',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-existing-canon', tempRoots)
        const canonicalRepoPath = realpathSync(repoPath)

        // Pre-seed a workspace with the raw (non-canonical) path
        // On macOS, /tmp is a symlink to /private/tmp, so use the
        // raw path to simulate a non-canonical stored path
        const { database } = yield* LaborerDatabase
        insertProject(database, 'project-existing-canon', repoPath)
        insertWorkspaceTask(database, {
          id: 'existing-non-canonical',
          rootPath: canonicalRepoPath,
          source: 'worktree',
          title: 'main',
          branchName: 'main',
          worktreePath: canonicalRepoPath,
          status: 'in_progress',
          worktreeStatus: 'ready',
          baseSha: null,
        })

        const reconciler = yield* WorktreeReconciler
        const result = yield* reconciler.reconcile(
          'project-existing-canon',
          repoPath
        )

        // The existing workspace should be matched (unchanged) even though
        // the stored path might differ in representation
        assert.strictEqual(result.unchanged, 1)
        assert.strictEqual(result.removed, 0)
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'reconciles worktrees with shared git dir consistently across multiple worktrees',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-shared-git', tempRoots)
        const wt1Path = join(repoPath, '.worktrees', 'wt1')
        const wt2Path = join(repoPath, '.worktrees', 'wt2')
        git(`worktree add -b wt1 ${wt1Path}`, repoPath)
        git(`worktree add -b wt2 ${wt2Path}`, repoPath)

        const { database } = yield* LaborerDatabase
        const reconciler = yield* WorktreeReconciler
        const result = yield* reconciler.reconcile(
          'project-shared-git',
          repoPath
        )

        // Reconciliation detects all three, but the main checkout is not a task.
        assert.strictEqual(result.added, 3)

        const rows = listSharedTasksForRoot(database, repoPath)

        assert.strictEqual(rows.length, 2)

        // All paths should be canonical
        for (const row of rows) {
          if (row.worktreePath === null) {
            throw new Error('Translated task should own a worktree')
          }
          const canonical = realpathSync(row.worktreePath)
          assert.strictEqual(row.worktreePath, canonical)
        }

        // Verify the specific worktrees are detected
        const paths = rows.map((r) => r.worktreePath)
        assert.isTrue(
          paths.includes(realpathSync(wt1Path)),
          'wt1 path should be present'
        )
        assert.isTrue(
          paths.includes(realpathSync(wt2Path)),
          'wt2 path should be present'
        )
      }).pipe(Effect.provide(TestLayer))
  )
})

describe('WorktreeReconciler task translation', () => {
  it.effect(
    'translates linked worktrees into worktree-source tasks, skipping main',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-task-translate', tempRoots)
        const linkedPath = join(repoPath, '.worktrees', 'feature-t')
        git(`worktree add -b feature/translated ${linkedPath}`, repoPath)

        const { database } = yield* LaborerDatabase
        const reconciler = yield* WorktreeReconciler
        yield* reconciler.reconcile('project-tasks', repoPath)

        const tasks = listSharedTasksForRoot(database, repoPath)

        assert.strictEqual(tasks.length, 1)
        const task = tasks[0]
        assert.isDefined(task)
        assert.strictEqual(task?.source, 'worktree')
        assert.strictEqual(task?.status, 'in_progress')
        assert.strictEqual(task?.title, 'feature/translated')
        assert.strictEqual(task?.branchName, 'feature/translated')
        assert.strictEqual(task?.worktreePath, realpathSync(linkedPath))
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'does not duplicate tasks across repeated reconciles and skips task-bound workspaces',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('reconciler-task-claimed', tempRoots)
        const boundPath = join(repoPath, '.worktrees', 'bound')
        const freePath = join(repoPath, '.worktrees', 'free')
        git(`worktree add -b laborer/bound ${boundPath}`, repoPath)
        git(`worktree add -b feature/free ${freePath}`, repoPath)

        // A provisioning task claims its worktree before reconciliation.
        const { database } = yield* LaborerDatabase
        insertProject(database, 'project-claimed', repoPath)
        insertWorkspaceTask(database, {
          id: 'bound-workspace',
          rootPath: realpathSync(repoPath),
          source: 'manual',
          title: 'laborer/bound',
          branchName: 'laborer/bound',
          worktreePath: realpathSync(boundPath),
          status: 'in_progress',
          worktreeStatus: 'provisioning',
          baseSha: null,
        })

        const reconciler = yield* WorktreeReconciler
        yield* reconciler.reconcile('project-claimed', repoPath)
        yield* reconciler.reconcile('project-claimed', repoPath)

        const tasks = listSharedTasksForRoot(database, repoPath)

        assert.strictEqual(tasks.length, 2)
        assert.strictEqual(
          tasks.filter((task) => task.branchName === 'laborer/bound').length,
          1
        )
        assert.strictEqual(
          tasks.filter((task) => task.branchName === 'feature/free').length,
          1
        )
      }).pipe(Effect.provide(TestLayer))
  )
})
