import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PortAllocator } from '../src/services/port-allocator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

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
  Layer.provideMerge(WorktreeDetector.layer),
  Layer.provideMerge(PortAllocator.make(4100, 4110)),
  Layer.provideMerge(TestLaborerStore)
)

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('WorktreeReconciler', () => {
  it.scoped('creates external stopped workspaces for detected worktrees', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-create', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-c')
      git(`worktree add -b feature/c ${linkedPath}`, repoPath)

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-1', repoPath)

      assert.strictEqual(result.added, 2)

      const { store } = yield* LaborerStore
      const rows = store.query(
        tables.workspaces.where('projectId', 'project-1')
      )

      assert.strictEqual(rows.length, 2)
      for (const row of rows) {
        assert.strictEqual(row.origin, 'external')
        assert.strictEqual(row.status, 'stopped')
        assert.strictEqual(row.port, 0)
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('leaves matching existing workspace records untouched', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-unchanged', tempRoots)
      const [mainWorktreePath] = getDetectedWorktreePaths(repoPath)

      const { store } = yield* LaborerStore
      store.commit(
        events.workspaceCreated({
          id: 'existing-main-workspace',
          projectId: 'project-unchanged',
          taskSource: null,
          branchName: 'custom/main',
          worktreePath: mainWorktreePath ?? repoPath,
          port: 4321,
          status: 'running',
          origin: 'laborer',
          createdAt: new Date().toISOString(),
          baseSha: 'custom-base-sha',
        })
      )

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-unchanged', repoPath)

      assert.strictEqual(result.added, 0)
      assert.strictEqual(result.removed, 0)
      assert.strictEqual(result.unchanged, 1)

      const rows = store.query(
        tables.workspaces.where('projectId', 'project-unchanged')
      )

      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0]?.id, 'existing-main-workspace')
      assert.strictEqual(rows[0]?.origin, 'laborer')
      assert.strictEqual(rows[0]?.status, 'running')
      assert.strictEqual(rows[0]?.port, 4321)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('removes stale workspace records not present on disk', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-stale', tempRoots)
      const stalePath = join(repoPath, '.worktrees', 'missing')

      const { store } = yield* LaborerStore
      store.commit(
        events.workspaceCreated({
          id: 'stale-workspace',
          projectId: 'project-2',
          taskSource: null,
          branchName: 'feature/missing',
          worktreePath: stalePath,
          port: 0,
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-2', repoPath)

      assert.strictEqual(result.removed, 1)

      const rows = store.query(
        tables.workspaces.where('projectId', 'project-2')
      )

      assert.isFalse(rows.some((row) => row.id === 'stale-workspace'))
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('handles mixed add, remove, and unchanged reconciliation', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-mixed', tempRoots)
      const linkedPath = join(repoPath, '.worktrees', 'feature-mixed')
      const stalePath = join(repoPath, '.worktrees', 'missing-mixed')
      git(`worktree add -b feature/mixed ${linkedPath}`, repoPath)
      const [mainWorktreePath] = getDetectedWorktreePaths(repoPath)

      const { store } = yield* LaborerStore
      store.commit(
        events.workspaceCreated({
          id: 'existing-main',
          projectId: 'project-mixed',
          taskSource: null,
          branchName: 'main',
          worktreePath: mainWorktreePath ?? repoPath,
          port: 0,
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )
      store.commit(
        events.workspaceCreated({
          id: 'stale-workspace',
          projectId: 'project-mixed',
          taskSource: null,
          branchName: 'feature/stale',
          worktreePath: stalePath,
          port: 0,
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-mixed', repoPath)

      assert.strictEqual(result.added, 1)
      assert.strictEqual(result.removed, 1)
      assert.strictEqual(result.unchanged, 1)

      const rows = store.query(
        tables.workspaces.where('projectId', 'project-mixed')
      )

      assert.strictEqual(rows.length, 2)
      assert.isTrue(rows.some((row) => row.id === 'existing-main'))
      assert.isTrue(rows.some((row) => row.branchName === 'feature/mixed'))
      assert.isFalse(rows.some((row) => row.id === 'stale-workspace'))
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('derives base SHA from merge-base for detected worktrees', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-base-sha', tempRoots)
      git('checkout -b feature/base-sha', repoPath)
      writeFileSync(join(repoPath, 'feature.txt'), 'feature branch content\n')
      git('add feature.txt', repoPath)
      git('commit -m "feature commit"', repoPath)

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-base-sha', repoPath)

      assert.strictEqual(result.added, 1)

      const defaultBranch = getDefaultBranchForTest(repoPath)
      const expectedBaseSha = git(`merge-base ${defaultBranch} HEAD`, repoPath)
      const { store } = yield* LaborerStore
      const rows = store.query(
        tables.workspaces.where('projectId', 'project-base-sha')
      )

      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0]?.baseSha, expectedBaseSha)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('frees allocated port when removing stale workspace', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('reconciler-free-port', tempRoots)
      const stalePath = join(repoPath, '.worktrees', 'missing-port')

      const allocator = yield* PortAllocator
      const allocatedPort = yield* allocator.allocate()
      const { store } = yield* LaborerStore
      store.commit(
        events.workspaceCreated({
          id: 'stale-port-workspace',
          projectId: 'project-free-port',
          taskSource: null,
          branchName: 'feature/stale-port',
          worktreePath: stalePath,
          port: allocatedPort,
          status: 'stopped',
          origin: 'external',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const reconciler = yield* WorktreeReconciler
      const result = yield* reconciler.reconcile('project-free-port', repoPath)

      assert.strictEqual(result.removed, 1)

      const reusedPort = yield* allocator.allocate()
      assert.strictEqual(reusedPort, 4100)
    }).pipe(Effect.provide(TestLayer))
  )
})
