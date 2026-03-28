/**
 * FileTreeService — Integration Test
 *
 * Verifies that `FileTreeService.subscribe` produces a file tree snapshot
 * for a workspace with a valid git worktree. Tests the full data flow:
 *   git ls-files + git status → parse → FileTreeSnapshot → Stream emission
 *
 * Uses a real temporary git repository to exercise the actual git commands.
 *
 * @see file-tree-service.ts — FileTreeService implementation
 * @see Issue #1: Streaming RPC contract + FileTreeService with git ls-files
 * @see Issue #4: Wire git status into FileTreeService and TreePane
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Chunk, Effect, Layer, Stream } from 'effect'
import { FileTreeService } from '../src/services/file-tree-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { createTempDir, git } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'

/**
 * Layer for FileTreeService tests — provides real FileTreeService
 * with a test FileWatcherClient stub and in-memory LaborerStore.
 */
const TestFileTreeLayer = FileTreeService.layer.pipe(
  Layer.provide(TestFileWatcherClientLayer),
  Layer.provideMerge(TestLaborerStore)
)

const tempRoots: string[] = []

const cleanupTempRoots = () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
  tempRoots.length = 0
}

/**
 * Seed a project and running workspace in the test store.
 * Returns the workspaceId for use in test assertions.
 */
const seedWorkspace = (
  store: LaborerStore['Type']['store'],
  repoPath: string,
  status = 'running'
) => {
  const workspaceId = crypto.randomUUID()
  const projectId = crypto.randomUUID()

  store.commit(
    events.projectCreated({
      id: projectId,
      repoPath,
      name: 'test-project',
      brrrConfig: null,
    })
  )
  store.commit(
    events.workspaceCreated({
      id: workspaceId,
      projectId,
      taskSource: null,
      branchName: 'main',
      worktreePath: repoPath,
      status,
      origin: 'manual',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )

  return workspaceId
}

describe('FileTreeService', () => {
  it.scoped(
    'subscribe emits an initial snapshot with files and gitStatus',
    () =>
      Effect.gen(function* () {
        // Create a temporary git repo with some files
        const repoPath = createTempDir('file-tree-test', tempRoots)
        git('init', repoPath)
        git('config user.email test@example.com', repoPath)
        git('config user.name "Test User"', repoPath)

        // Create some tracked files
        writeFileSync(join(repoPath, 'README.md'), '# Hello\n')
        mkdirSync(join(repoPath, 'src'), { recursive: true })
        writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
        writeFileSync(join(repoPath, 'src/utils.ts'), 'export {}\n')
        git('add -A', repoPath)
        git('commit -m "initial"', repoPath)

        // Add a modified file (tracked, modified)
        writeFileSync(join(repoPath, 'README.md'), '# Modified\n')

        // Add an untracked file
        writeFileSync(join(repoPath, 'untracked.txt'), 'hello\n')

        // Seed a running workspace
        const { store } = yield* LaborerStore
        const workspaceId = seedWorkspace(store, repoPath)

        // Subscribe to the file tree
        const fileTreeService = yield* FileTreeService
        const stream = fileTreeService.subscribe(workspaceId)

        // Take the first emission (initial snapshot)
        const chunks = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        const snapshot = Chunk.toReadonlyArray(chunks)[0]

        assert.isDefined(snapshot, 'Expected at least one snapshot')
        if (snapshot === undefined) {
          return
        }

        // Verify the snapshot contains files
        assert.isTrue(
          snapshot.files.length >= 3,
          `Expected at least 3 files, got ${snapshot.files.length}`
        )

        // Verify tracked files are present
        assert.isTrue(
          snapshot.files.includes('README.md'),
          'Expected README.md in files'
        )
        assert.isTrue(
          snapshot.files.includes('src/index.ts'),
          'Expected src/index.ts in files'
        )
        assert.isTrue(
          snapshot.files.includes('src/utils.ts'),
          'Expected src/utils.ts in files'
        )

        // Verify untracked file is included (git ls-files --others)
        assert.isTrue(
          snapshot.files.includes('untracked.txt'),
          'Expected untracked.txt in files'
        )

        // Verify git status has entries
        assert.isTrue(
          snapshot.gitStatus.length > 0,
          `Expected at least 1 git status entry, got ${snapshot.gitStatus.length}`
        )

        // Verify the modified file appears in gitStatus
        const readmeStatus = snapshot.gitStatus.find(
          (entry) => entry.path === 'README.md'
        )
        assert.isDefined(readmeStatus, 'Expected README.md in gitStatus')
        assert.strictEqual(readmeStatus?.status, 'modified')

        // Verify untracked file appears in gitStatus as 'added'
        const untrackedStatus = snapshot.gitStatus.find(
          (entry) => entry.path === 'untracked.txt'
        )
        assert.isDefined(untrackedStatus, 'Expected untracked.txt in gitStatus')
        assert.strictEqual(untrackedStatus?.status, 'added')

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileTreeLayer))
  )

  it.scoped('subscribe fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileTreeService = yield* FileTreeService
      const stream = fileTreeService.subscribe('nonexistent-workspace-id')

      const result = yield* stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected NOT_FOUND error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'NOT_FOUND')
    }).pipe(Effect.provide(TestFileTreeLayer))
  )

  it.scoped('subscribe fails with INVALID_STATE for destroyed workspace', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('file-tree-destroyed', tempRoots)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath, 'destroyed')

      const fileTreeService = yield* FileTreeService
      const stream = fileTreeService.subscribe(workspaceId)

      const result = yield* stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected INVALID_STATE error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'INVALID_STATE')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileTreeLayer))
  )
})
