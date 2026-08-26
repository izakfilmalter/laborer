/**
 * A review comment anchors to a line range of a workspace's diff, so
 * destroying the worktree retires its conversations rather than orphaning
 * them against a task row that outlives the worktree.
 */

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
import { HUMAN_AUTHOR } from '../src/services/review-comments.js'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

const tempRoots: string[] = []
const originalXdgStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = createTempDir(
  'review-comment-destroy-state',
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
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

describe('review comments and workspace destroy', () => {
  it.live('retires a destroyed workspace\u2019s conversations', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('destroy-review-comments', tempRoots)
      const branchName = 'feature/reviewed'
      const worktreePath = join(repoPath, '.worktrees', 'reviewed')
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
      const { row: thread } = database.createReviewCommentThread(
        {
          body: 'Rename this to something honest',
          endLine: 12,
          filePath: 'src/app.ts',
          side: 'additions',
          startLine: 10,
          workspaceId,
        },
        HUMAN_AUTHOR,
        'operation-open'
      )
      // A conversation on a different workspace is none of this destroy's
      // business.
      const { row: elsewhere } = database.createReviewCommentThread(
        {
          body: 'Leave this one alone',
          endLine: 4,
          filePath: 'src/other.ts',
          side: 'deletions',
          startLine: 4,
          workspaceId: 'workspace-elsewhere',
        },
        HUMAN_AUTHOR,
        'operation-open-elsewhere'
      )

      const registry = yield* ProjectRegistry
      yield* registry.addProject(repoPath)
      const provider = yield* WorkspaceProvider
      yield* provider.destroyWorktree(workspaceId)
      yield* waitForWorkspaceRemoval(workspaceId)

      assert.isFalse(existsSync(worktreePath))
      assert.strictEqual(database.findReviewCommentThread(thread.id), null)
      assert.strictEqual(
        database.findReviewCommentThread(elsewhere.id)?.id,
        elsewhere.id
      )
      // The retirement is published, so a pane still open on that workspace
      // drops the threads instead of rendering anchors into a gone worktree.
      assert.include(
        database
          .stateChangesAfter(0)
          .filter(({ tableName }) => tableName === 'review_comment_threads')
          .map(({ rowId }) => rowId),
        thread.id
      )
    }).pipe(Effect.provide(TestLayer))
  )
})
