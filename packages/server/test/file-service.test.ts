/**
 * FileService — Integration Test
 *
 * Verifies that `FileService.list()` returns correct directory listings
 * for a workspace's worktree. Tests use real temporary git repositories
 * to exercise the full data flow: readdir → filter → sort → FileNode[].
 *
 * @see file-service.ts — FileService implementation
 * @see Issue 1: file.list — Lazy per-directory listing (tracer bullet)
 */

import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  assembleDiffEntries,
  FileService,
  fileFromPatchChunk,
  splitGitPatch,
} from '../src/services/file-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

/**
 * Layer for FileService tests — provides real FileService with
 * in-memory LaborerDatabase and no-op file watcher client.
 */
const TestFileServiceLayer = FileService.layer.pipe(
  Layer.provide(TestFileWatcherClientLayer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
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
 * Seed a project and task-backed workspace in the test database.
 * Returns the workspaceId for use in test assertions.
 */
const seedWorkspace = (
  database: NativeLaborerDatabase,
  repoPath: string,
  status = 'running',
  baseBranch: string | null = null
) => {
  const workspaceId = crypto.randomUUID()
  const projectId = crypto.randomUUID()

  database.insertProject({
    canonicalGitCommonDir: `${repoPath}/.git`,
    id: projectId,
    name: 'test-project',
    repoId: projectId,
    rootPath: repoPath,
  })
  database.insertTask({
    baseBranch,
    branchName: status === 'destroyed' ? null : 'main',
    id: workspaceId,
    rootPath: repoPath,
    source: 'manual',
    status: 'in_progress',
    title: 'Test workspace',
    worktreePath: status === 'destroyed' ? null : repoPath,
    worktreeStatus: status === 'destroyed' ? null : 'ready',
  })

  return workspaceId
}

/**
 * A repo whose branch has both committed and uncommitted work, which is the
 * shape the branch-vs-working distinction is about: `committed.txt` and the
 * README edit live in a branch commit, `uncommitted.txt` and the `staged.txt`
 * edit do not.
 */
const initBranchRepo = (prefix: string) => {
  const repoPath = initRepo(prefix, tempRoots)
  writeFileSync(join(repoPath, 'staged.txt'), 'before\n')
  git('add staged.txt', repoPath)
  git('commit -m "base commit"', repoPath)

  git('checkout -b feature', repoPath)
  writeFileSync(join(repoPath, 'committed.txt'), 'committed on the branch\n')
  writeFileSync(join(repoPath, 'README.md'), '# test\nbranch edit\n')
  git('add .', repoPath)
  git('commit -m "branch work"', repoPath)

  writeFileSync(join(repoPath, 'uncommitted.txt'), 'not committed yet\n')
  writeFileSync(join(repoPath, 'staged.txt'), 'after\n')

  return repoPath
}

describe('FileService', () => {
  // --- Behavior 1: Basic listing with correct shape ---
  it.effect('list returns files and directories with correct shape', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-shape', tempRoots)
      mkdirSync(join(repoPath, 'src'), { recursive: true })
      writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
      writeFileSync(join(repoPath, 'package.json'), '{}\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      assert.isTrue(nodes.length > 0, 'Expected at least one node')

      // Each node has the expected shape
      for (const node of nodes) {
        assert.isString(node.name)
        assert.isString(node.path)
        assert.isString(node.absolute)
        assert.isTrue(
          node.type === 'file' || node.type === 'directory',
          'type must be file or directory'
        )
        assert.isBoolean(node.ignored)
      }

      // Specific entries exist
      const srcNode = nodes.find((n) => n.name === 'src')
      assert.isDefined(srcNode, 'Expected src directory')
      assert.strictEqual(srcNode?.type, 'directory')
      assert.strictEqual(srcNode?.path, 'src')

      const pkgNode = nodes.find((n) => n.name === 'package.json')
      assert.isDefined(pkgNode, 'Expected package.json file')
      assert.strictEqual(pkgNode?.type, 'file')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 2: Sort order (directories first, then alphabetical) ---
  it.effect('list sorts directories before files, alphabetical within', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-sort', tempRoots)
      mkdirSync(join(repoPath, 'zebra'), { recursive: true })
      mkdirSync(join(repoPath, 'alpha'), { recursive: true })
      writeFileSync(join(repoPath, 'zfile.txt'), '')
      writeFileSync(join(repoPath, 'afile.txt'), '')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      // Directories come first
      const dirIndices = nodes
        .map((n, i) => (n.type === 'directory' ? i : -1))
        .filter((i) => i >= 0)
      const fileIndices = nodes
        .map((n, i) => (n.type === 'file' ? i : -1))
        .filter((i) => i >= 0)

      if (dirIndices.length > 0 && fileIndices.length > 0) {
        const lastDirIdx = dirIndices.at(-1) ?? 0
        const firstFileIdx = fileIndices[0] ?? 0
        assert.isTrue(
          lastDirIdx < firstFileIdx,
          'All directories should appear before all files'
        )
      }

      // Within directories, alphabetical
      const dirNames = nodes
        .filter((n) => n.type === 'directory')
        .map((n) => n.name)
      const alphaDirIdx = dirNames.indexOf('alpha')
      const zebraDirIdx = dirNames.indexOf('zebra')
      if (alphaDirIdx >= 0 && zebraDirIdx >= 0) {
        assert.isTrue(
          alphaDirIdx < zebraDirIdx,
          'alpha should come before zebra'
        )
      }

      // Within files, alphabetical
      const fileNames = nodes
        .filter((n) => n.type === 'file')
        .map((n) => n.name)
      const afileIdx = fileNames.indexOf('afile.txt')
      const zfileIdx = fileNames.indexOf('zfile.txt')
      if (afileIdx >= 0 && zfileIdx >= 0) {
        assert.isTrue(
          afileIdx < zfileIdx,
          'afile.txt should come before zfile.txt'
        )
      }

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 3: Ignored directories are skipped ---
  it.effect('list skips ignored directories (node_modules, .git, etc)', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-ignored-dirs', tempRoots)
      mkdirSync(join(repoPath, 'node_modules'), { recursive: true })
      mkdirSync(join(repoPath, 'dist'), { recursive: true })
      mkdirSync(join(repoPath, 'src'), { recursive: true })

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      const names = nodes.map((n) => n.name)
      assert.isFalse(
        names.includes('node_modules'),
        'node_modules should be skipped'
      )
      assert.isFalse(names.includes('.git'), '.git should be skipped')
      assert.isFalse(names.includes('dist'), 'dist should be skipped')
      assert.isTrue(names.includes('src'), 'src should be present')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 4: Ignored files are skipped ---
  it.effect('list skips OS metadata files (.DS_Store, Thumbs.db)', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-ignored-files', tempRoots)
      writeFileSync(join(repoPath, '.DS_Store'), '')
      writeFileSync(join(repoPath, 'Thumbs.db'), '')
      writeFileSync(join(repoPath, 'real-file.txt'), 'hello\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      const names = nodes.map((n) => n.name)
      assert.isFalse(names.includes('.DS_Store'), '.DS_Store should be skipped')
      assert.isFalse(names.includes('Thumbs.db'), 'Thumbs.db should be skipped')
      assert.isTrue(
        names.includes('real-file.txt'),
        'real-file.txt should be present'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 5: Subdirectory listing ---
  it.effect('list with dir parameter returns subdirectory children', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-subdir', tempRoots)
      mkdirSync(join(repoPath, 'src/components'), { recursive: true })
      writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
      writeFileSync(join(repoPath, 'src/components/Button.tsx'), 'export {}\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId, 'src')

      const names = nodes.map((n) => n.name)
      assert.isTrue(
        names.includes('components'),
        'Expected components directory'
      )
      assert.isTrue(names.includes('index.ts'), 'Expected index.ts file')

      // Paths should be relative to worktree root
      const indexNode = nodes.find((n) => n.name === 'index.ts')
      assert.strictEqual(indexNode?.path, 'src/index.ts')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 6: Path traversal rejection ---
  it.effect('list rejects path traversal outside worktree root', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-traversal', tempRoots)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.list(workspaceId, '../../etc').pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected PATH_TRAVERSAL error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'PATH_TRAVERSAL')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 7: NOT_FOUND for unknown workspace ---
  it.effect('list fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileService = yield* FileService
      const result = yield* fileService.list('nonexistent-workspace-id').pipe(
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
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 8: Tasks without worktrees are not workspaces ---
  it.effect(
    'list fails with NOT_FOUND after a workspace loses its worktree',
    () =>
      Effect.gen(function* () {
        const repoPath = createTempDir('file-svc-destroyed', tempRoots)

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath, 'destroyed')

        const fileService = yield* FileService
        const result = yield* fileService.list(workspaceId).pipe(
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

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // =================================================================
  // FileService.read() tests — Issue 3
  // =================================================================

  // --- Behavior 9: Read a text file returns correct content ---
  it.effect('read returns text file content with type "text"', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-text', tempRoots)
      writeFileSync(join(repoPath, 'hello.txt'), 'Hello, world!\n')
      git('add hello.txt', repoPath)
      git('commit -m "add hello"', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'hello.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, 'Hello, world!')
      // No diff because file matches HEAD
      assert.isUndefined(result.diff)
      assert.isUndefined(result.patch)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 10: Read a modified tracked file returns diff and patch ---
  it.effect('read returns diff and patch for a modified tracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-diff', tempRoots)
      writeFileSync(join(repoPath, 'tracked.txt'), 'line 1\nline 2\n')
      git('add tracked.txt', repoPath)
      git('commit -m "add tracked"', repoPath)

      // Modify the file after committing
      writeFileSync(
        join(repoPath, 'tracked.txt'),
        'line 1\nline 2 modified\nline 3\n'
      )

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'tracked.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, 'line 1\nline 2 modified\nline 3')
      // Should have diff and patch since the file was modified
      assert.isDefined(result.diff, 'Expected diff to be present')
      assert.isDefined(result.patch, 'Expected patch to be present')
      if (result.patch === undefined) {
        assert.fail('patch should be defined')
      }
      assert.isTrue(result.patch.hunks.length > 0, 'Expected at least one hunk')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 11: Read a staged-but-not-committed file returns diff ---
  it.effect('read returns diff via --staged fallback for staged changes', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-staged', tempRoots)
      writeFileSync(join(repoPath, 'staged.txt'), 'original\n')
      git('add staged.txt', repoPath)
      git('commit -m "add staged"', repoPath)

      // Modify and stage the file (but do not commit)
      writeFileSync(join(repoPath, 'staged.txt'), 'modified\n')
      git('add staged.txt', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'staged.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, 'modified')
      assert.isDefined(result.diff, 'Expected diff for staged file')
      assert.isDefined(result.patch, 'Expected patch for staged file')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 12: Read an unmodified file returns no diff ---
  it.effect('read returns no diff/patch for an unmodified tracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-clean', tempRoots)
      writeFileSync(join(repoPath, 'clean.txt'), 'no changes\n')
      git('add clean.txt', repoPath)
      git('commit -m "add clean"', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'clean.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, 'no changes')
      assert.isUndefined(result.diff)
      assert.isUndefined(result.patch)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 13: Read a newly created (untracked) file ---
  it.effect('read returns content but no diff for an untracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-untracked', tempRoots)
      writeFileSync(join(repoPath, 'new-file.txt'), 'brand new\n')
      // Do NOT git add — leave untracked

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'new-file.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, 'brand new')
      // Untracked files have no diff against HEAD
      assert.isUndefined(result.diff)
      assert.isUndefined(result.patch)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 14: Read a binary file returns type "binary" ---
  it.effect('read returns type "binary" for binary file extensions', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-binary', tempRoots)
      writeFileSync(join(repoPath, 'app.exe'), Buffer.from([0, 1, 2, 3]))

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'app.exe')

      assert.strictEqual(result.type, 'binary')
      assert.strictEqual(result.content, '')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 15: Read an image file returns base64 with mimeType ---
  it.effect('read returns base64 content with mimeType for image files', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-image', tempRoots)
      // Write a minimal 1x1 PNG (smallest valid PNG file)
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
      writeFileSync(join(repoPath, 'icon.png'), pngBytes)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'icon.png')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.encoding, 'base64')
      assert.strictEqual(result.mimeType, 'image/png')
      assert.isTrue(result.content.length > 0, 'Expected non-empty base64')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 16: Read a non-existent file returns empty content ---
  it.effect('read returns empty content for a non-existent file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-missing', tempRoots)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'does-not-exist.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, '')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 17: Read rejects path traversal ---
  it.effect('read rejects path traversal outside worktree root', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-traversal', tempRoots)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService
        .read(workspaceId, '../../etc/passwd')
        .pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (error) => Effect.succeed(error),
          })
        )

      if (result === 'success') {
        assert.fail('Expected PATH_TRAVERSAL error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'PATH_TRAVERSAL')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 18: Read from non-existent workspace returns NOT_FOUND ---
  it.effect('read fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileService = yield* FileService
      const result = yield* fileService
        .read('nonexistent-workspace-id', 'file.txt')
        .pipe(
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
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // =================================================================
  // FileService.status() tests — Issue 4
  // =================================================================

  // --- Behavior 19: Modified file appears with status "modified" and line counts ---
  it.effect(
    'status returns modified file with correct added/removed counts',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-status-modified', tempRoots)
        writeFileSync(join(repoPath, 'tracked.txt'), 'line 1\nline 2\nline 3\n')
        git('add tracked.txt', repoPath)
        git('commit -m "add tracked"', repoPath)

        // Modify: change one line, add one line
        writeFileSync(
          join(repoPath, 'tracked.txt'),
          'line 1\nline 2 modified\nline 3\nline 4\n'
        )

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.status(workspaceId)

        const tracked = result.find((f) => f.path === 'tracked.txt')
        assert.isDefined(tracked, 'Expected tracked.txt in status')
        assert.strictEqual(tracked?.status, 'modified')
        // git diff --numstat counts: 2 added (modified line + new line), 1 removed (old line)
        assert.isTrue(
          typeof tracked?.added === 'number' && tracked.added > 0,
          'Expected added > 0'
        )
        assert.isTrue(
          typeof tracked?.removed === 'number' && tracked.removed > 0,
          'Expected removed > 0'
        )

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 20: Newly created (untracked) file appears with status "added" ---
  it.effect(
    'status returns untracked file with status "added" and line count',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-status-added', tempRoots)
        writeFileSync(join(repoPath, 'new-file.txt'), 'hello\nworld\n')
        // Do NOT git add — leave untracked

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.status(workspaceId)

        const newFile = result.find((f) => f.path === 'new-file.txt')
        assert.isDefined(newFile, 'Expected new-file.txt in status')
        assert.strictEqual(newFile?.status, 'added')
        assert.strictEqual(newFile?.added, 2, 'Expected 2 lines added')
        assert.strictEqual(newFile?.removed, 0, 'Expected 0 lines removed')

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 21: Deleted file appears with status "deleted" ---
  it.effect('status returns deleted file with status "deleted"', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-status-deleted', tempRoots)
      writeFileSync(join(repoPath, 'to-delete.txt'), 'goodbye\n')
      git('add to-delete.txt', repoPath)
      git('commit -m "add to-delete"', repoPath)

      // Delete the file (tracked deletion, not staged)
      unlinkSync(join(repoPath, 'to-delete.txt'))

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.status(workspaceId)

      const deleted = result.find(
        (f: { path: string }) => f.path === 'to-delete.txt'
      )
      assert.isDefined(deleted, 'Expected to-delete.txt in status')
      assert.strictEqual(deleted?.status, 'deleted')
      assert.strictEqual(deleted?.added, 0, 'Expected 0 lines added')
      assert.strictEqual(deleted?.removed, 0, 'Expected 0 lines removed')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 22: Clean working tree returns empty array ---
  it.effect('status returns empty array for clean working tree', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-status-clean', tempRoots)
      // initRepo already commits README.md, so the tree is clean

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.status(workspaceId)

      assert.strictEqual(
        result.length,
        0,
        'Expected empty array for clean tree'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 23: All three types in same response ---
  it.effect('status returns modified, added, and deleted files together', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-status-all', tempRoots)
      writeFileSync(join(repoPath, 'modify-me.txt'), 'original\n')
      writeFileSync(join(repoPath, 'delete-me.txt'), 'to be deleted\n')
      git('add .', repoPath)
      git('commit -m "add files"', repoPath)

      // Modify one file
      writeFileSync(join(repoPath, 'modify-me.txt'), 'changed\n')
      // Delete one file
      unlinkSync(join(repoPath, 'delete-me.txt'))
      // Add one new file (untracked)
      writeFileSync(join(repoPath, 'brand-new.txt'), 'new content\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.status(workspaceId)

      const statuses = result.map((f) => f.status).sort()
      assert.isTrue(statuses.includes('modified'), 'Expected a modified file')
      assert.isTrue(statuses.includes('added'), 'Expected an added file')
      assert.isTrue(statuses.includes('deleted'), 'Expected a deleted file')

      assert.strictEqual(result.length, 3, 'Expected exactly 3 changed files')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 24: NOT_FOUND for unknown workspace ---
  it.effect('status fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileService = yield* FileService
      const result = yield* fileService.status('nonexistent-workspace-id').pipe(
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
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // =================================================================
  // FileService.list() — Gitignore marking tests — Issue 2
  // =================================================================

  // --- Behavior 25: File matching .gitignore pattern gets ignored: true ---
  it.effect('list marks files matching .gitignore patterns as ignored', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-gitignore-file', tempRoots)
      writeFileSync(join(repoPath, '.gitignore'), '*.log\n')
      writeFileSync(join(repoPath, 'app.log'), 'log data\n')
      writeFileSync(join(repoPath, 'main.ts'), 'code\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      const logNode = nodes.find((n) => n.name === 'app.log')
      assert.isDefined(logNode, 'Expected app.log in listing')
      assert.strictEqual(
        logNode?.ignored,
        true,
        'app.log should be marked as ignored'
      )

      const tsNode = nodes.find((n) => n.name === 'main.ts')
      assert.isDefined(tsNode, 'Expected main.ts in listing')
      assert.strictEqual(
        tsNode?.ignored,
        false,
        'main.ts should not be ignored'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 26: Directory matching .gitignore pattern gets ignored: true ---
  it.effect(
    'list marks directories matching .gitignore patterns as ignored (trailing / semantics)',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-gitignore-dir', tempRoots)
        writeFileSync(join(repoPath, '.gitignore'), 'output/\n')
        mkdirSync(join(repoPath, 'output'), { recursive: true })
        writeFileSync(join(repoPath, 'output/bundle.js'), 'bundle\n')
        mkdirSync(join(repoPath, 'src'), { recursive: true })

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const nodes = yield* fileService.list(workspaceId)

        const outputNode = nodes.find((n) => n.name === 'output')
        assert.isDefined(outputNode, 'Expected output directory in listing')
        assert.strictEqual(
          outputNode?.ignored,
          true,
          'output/ should be marked as ignored'
        )

        const srcNode = nodes.find((n) => n.name === 'src')
        assert.isDefined(srcNode, 'Expected src directory in listing')
        assert.strictEqual(
          srcNode?.ignored,
          false,
          'src/ should not be ignored'
        )

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 27: .ignore file patterns are also applied ---
  it.effect('list applies .ignore file patterns alongside .gitignore', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-dotignore', tempRoots)
      writeFileSync(join(repoPath, '.gitignore'), '*.log\n')
      writeFileSync(join(repoPath, '.ignore'), '*.tmp\n')
      writeFileSync(join(repoPath, 'app.log'), 'log\n')
      writeFileSync(join(repoPath, 'cache.tmp'), 'tmp\n')
      writeFileSync(join(repoPath, 'main.ts'), 'code\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const nodes = yield* fileService.list(workspaceId)

      const logNode = nodes.find((n) => n.name === 'app.log')
      assert.isDefined(logNode, 'Expected app.log')
      assert.strictEqual(logNode?.ignored, true, 'app.log should be ignored')

      const tmpNode = nodes.find((n) => n.name === 'cache.tmp')
      assert.isDefined(tmpNode, 'Expected cache.tmp')
      assert.strictEqual(tmpNode?.ignored, true, 'cache.tmp should be ignored')

      const tsNode = nodes.find((n) => n.name === 'main.ts')
      assert.isDefined(tsNode, 'Expected main.ts')
      assert.strictEqual(
        tsNode?.ignored,
        false,
        'main.ts should not be ignored'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 28: Entries not matching any pattern get ignored: false ---
  it.effect(
    'list returns ignored: false for entries not matching any ignore pattern',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-no-match', tempRoots)
        writeFileSync(join(repoPath, '.gitignore'), '*.log\n')
        writeFileSync(join(repoPath, 'index.ts'), 'code\n')
        mkdirSync(join(repoPath, 'lib'), { recursive: true })

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const nodes = yield* fileService.list(workspaceId)

        const indexNode = nodes.find((n) => n.name === 'index.ts')
        assert.isDefined(indexNode, 'Expected index.ts')
        assert.strictEqual(
          indexNode?.ignored,
          false,
          'index.ts should not be ignored'
        )

        const libNode = nodes.find((n) => n.name === 'lib')
        assert.isDefined(libNode, 'Expected lib directory')
        assert.strictEqual(
          libNode?.ignored,
          false,
          'lib/ should not be ignored'
        )

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 29: Missing .gitignore/.ignore files handled gracefully ---
  it.effect(
    'list returns all entries with ignored: false when no gitignore/ignore files exist',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-no-gitignore', tempRoots)
        // initRepo creates README.md but no .gitignore or .ignore
        writeFileSync(join(repoPath, 'app.ts'), 'code\n')
        mkdirSync(join(repoPath, 'lib'), { recursive: true })

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const nodes = yield* fileService.list(workspaceId)

        for (const node of nodes) {
          assert.strictEqual(
            node.ignored,
            false,
            `${node.name} should have ignored: false when no gitignore files exist`
          )
        }

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )
})

// =================================================================
// FileService.diff() tests — batched workspace diff
// =================================================================

describe('FileService.diff', () => {
  // --- Modified tracked file gets a patch from the batched git diff ---
  it.effect('diff returns a patch for a modified tracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-modified', tempRoots)
      writeFileSync(join(repoPath, 'tracked.txt'), 'line 1\nline 2\n')
      git('add tracked.txt', repoPath)
      git('commit -m "add tracked"', repoPath)

      writeFileSync(join(repoPath, 'tracked.txt'), 'line 1\nline 2 modified\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      const tracked = entries.find((e) => e.path === 'tracked.txt')
      assert.isDefined(tracked, 'Expected tracked.txt entry')
      assert.strictEqual(tracked?.status, 'modified')
      assert.strictEqual(tracked?.truncated, false)
      assert.isDefined(tracked?.patch, 'Expected a patch')
      assert.include(tracked?.patch ?? '', '+line 2 modified')
      assert.include(tracked?.patch ?? '', '-line 2')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Untracked file gets a /dev/null no-index patch ---
  it.effect('diff returns an all-additions patch for an untracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-untracked', tempRoots)
      writeFileSync(join(repoPath, 'brand-new.txt'), 'hello\nworld\n')
      // Do NOT git add — leave untracked

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      const added = entries.find((e) => e.path === 'brand-new.txt')
      assert.isDefined(added, 'Expected brand-new.txt entry')
      assert.strictEqual(added?.status, 'added')
      assert.isDefined(added?.patch, 'Expected a patch for untracked file')
      assert.include(added?.patch ?? '', '+hello')
      assert.include(added?.patch ?? '', '+world')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Deleted file gets a deletions patch from the batched git diff ---
  it.effect('diff returns a deletions patch for a deleted file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-deleted', tempRoots)
      writeFileSync(join(repoPath, 'to-delete.txt'), 'goodbye\n')
      git('add to-delete.txt', repoPath)
      git('commit -m "add to-delete"', repoPath)

      unlinkSync(join(repoPath, 'to-delete.txt'))

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      const deleted = entries.find((e) => e.path === 'to-delete.txt')
      assert.isDefined(deleted, 'Expected to-delete.txt entry')
      assert.strictEqual(deleted?.status, 'deleted')
      assert.isDefined(deleted?.patch, 'Expected a patch for deleted file')
      assert.include(deleted?.patch ?? '', '-goodbye')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Staged changes are included (git diff HEAD covers index) ---
  it.effect('diff includes staged-but-uncommitted changes', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-staged', tempRoots)
      writeFileSync(join(repoPath, 'staged.txt'), 'original\n')
      git('add staged.txt', repoPath)
      git('commit -m "add staged"', repoPath)

      writeFileSync(join(repoPath, 'staged.txt'), 'modified\n')
      git('add staged.txt', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      const staged = entries.find((e) => e.path === 'staged.txt')
      assert.isDefined(staged, 'Expected staged.txt entry')
      assert.include(staged?.patch ?? '', '+modified')
      assert.include(staged?.patch ?? '', '-original')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- All change types in one batched response ---
  it.effect('diff returns modified, added, and deleted entries together', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-all', tempRoots)
      writeFileSync(join(repoPath, 'modify-me.txt'), 'original\n')
      writeFileSync(join(repoPath, 'delete-me.txt'), 'to be deleted\n')
      git('add .', repoPath)
      git('commit -m "add files"', repoPath)

      writeFileSync(join(repoPath, 'modify-me.txt'), 'changed\n')
      unlinkSync(join(repoPath, 'delete-me.txt'))
      writeFileSync(join(repoPath, 'brand-new.txt'), 'new content\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      assert.strictEqual(entries.length, 3, 'Expected exactly 3 entries')
      for (const entry of entries) {
        assert.isDefined(
          entry.patch,
          `Expected a patch for ${entry.path} (${entry.status})`
        )
      }

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Clean tree returns an empty array ---
  it.effect('diff returns empty array for a clean working tree', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-diff-clean', tempRoots)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      assert.strictEqual(entries.length, 0)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Unknown workspace fails with NOT_FOUND ---
  it.effect('diff fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileService = yield* FileService
      const result = yield* fileService.diff('nonexistent-workspace-id').pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected NOT_FOUND error')
      }
      if (result._tag !== 'RpcError') {
        assert.fail(`Expected RpcError, got ${result._tag}`)
      }
      assert.strictEqual(result.code, 'NOT_FOUND')
    }).pipe(Effect.provide(TestFileServiceLayer))
  )
})

// =================================================================
// FileService.diff() — diff targets and whitespace
// =================================================================

describe('FileService.diff targets', () => {
  it.effect('working (the default) shows only uncommitted work', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-target-working')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId)

      const paths = entries.map((entry) => entry.path).sort()
      assert.deepStrictEqual(paths, ['staged.txt', 'uncommitted.txt'])

      // Explicitly asking for `working` is the same request.
      const explicit = yield* fileService.diff(workspaceId, {
        target: { _tag: 'working' },
      })
      assert.deepStrictEqual(
        explicit.map((entry) => entry.path).sort(),
        paths,
        'omitting the target must mean the working target'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('branch shows committed branch work alongside uncommitted', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-target-branch')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId, {
        target: { _tag: 'branch' },
      })

      const paths = entries.map((entry) => entry.path).sort()
      assert.deepStrictEqual(paths, [
        'README.md',
        'committed.txt',
        'staged.txt',
        'uncommitted.txt',
      ])

      // A file the branch created in a commit is an addition, not a
      // modification, and carries its whole content as a patch.
      const committed = entries.find((e) => e.path === 'committed.txt')
      assert.strictEqual(committed?.status, 'added')
      assert.include(committed?.patch ?? '', '+committed on the branch')

      // The uncommitted edit is still in the range.
      const staged = entries.find((e) => e.path === 'staged.txt')
      assert.include(staged?.patch ?? '', '+after')
      assert.include(staged?.patch ?? '', '-before')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect(
    'branch excludes commits that landed on the base after the fork',
    () =>
      Effect.gen(function* () {
        const repoPath = initBranchRepo('file-svc-target-three-dot')

        // Base moves on after the fork. A two-dot `git diff main` would show
        // this file as deleted by the branch; merge-base semantics must not.
        git('checkout main', repoPath)
        writeFileSync(join(repoPath, 'landed-on-main.txt'), 'from main\n')
        git('add landed-on-main.txt', repoPath)
        git('commit -m "main moves on"', repoPath)
        git('checkout feature', repoPath)

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const entries = yield* fileService.diff(workspaceId, {
          target: { _tag: 'branch' },
        })

        assert.isUndefined(
          entries.find((e) => e.path === 'landed-on-main.txt'),
          'base-branch commits must not appear as the branch deleting them'
        )
        assert.isDefined(entries.find((e) => e.path === 'committed.txt'))

        cleanupTempRoots()
      }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('branch uses the base branch recorded on the task', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-target-stored-base')

      // Fork a second base off the branch tip, then record it. Its merge-base
      // with HEAD is the branch tip, so nothing committed is in range —
      // proving the recorded base was used rather than `main`.
      git('branch release feature', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(
        database,
        repoPath,
        'running',
        'release'
      )

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId, {
        target: { _tag: 'branch' },
      })

      assert.deepStrictEqual(
        entries.map((entry) => entry.path).sort(),
        ['staged.txt', 'uncommitted.txt'],
        'the recorded base branch must win over the conventional guesses'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('ref diffs against the merge-base with a named ref', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-target-ref')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const entries = yield* fileService.diff(workspaceId, {
        target: { _tag: 'ref', ref: 'main' },
      })

      assert.deepStrictEqual(entries.map((entry) => entry.path).sort(), [
        'README.md',
        'committed.txt',
        'staged.txt',
        'uncommitted.txt',
      ])

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('an unknown ref fails with REF_NOT_FOUND, not a crash', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-target-bad-ref')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService
        .diff(workspaceId, { target: { _tag: 'ref', ref: 'no-such-branch' } })
        .pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (error) => Effect.succeed(error),
          })
        )

      if (result === 'success' || result._tag !== 'DiffTargetUnresolved') {
        assert.fail('Expected DiffTargetUnresolved')
      }
      assert.strictEqual(result.reason, 'REF_NOT_FOUND')
      assert.strictEqual(result.ref, 'no-such-branch')
      assert.isTrue(result.message.length > 0, 'the UI needs something to say')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('a repo with no base branch fails with NO_BASE_BRANCH', () =>
    Effect.gen(function* () {
      // No origin, and none of dev/main/master exist.
      const repoPath = createTempDir('file-svc-target-no-base', tempRoots)
      git('init -b solo', repoPath)
      git('config user.email test@example.com', repoPath)
      git('config user.name Test User', repoPath)
      writeFileSync(join(repoPath, 'only.txt'), 'alone\n')
      git('add only.txt', repoPath)
      git('commit -m "only"', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService
        .diff(workspaceId, { target: { _tag: 'branch' } })
        .pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (error) => Effect.succeed(error),
          })
        )

      if (result === 'success' || result._tag !== 'DiffTargetUnresolved') {
        assert.fail('Expected DiffTargetUnresolved')
      }
      assert.strictEqual(result.reason, 'NO_BASE_BRANCH')
      assert.isNull(result.ref)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('an unrelated history fails with MERGE_BASE_FAILED', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-target-orphan', tempRoots)
      git('checkout --orphan orphan-branch', repoPath)
      writeFileSync(join(repoPath, 'orphan.txt'), 'no shared history\n')
      git('add orphan.txt', repoPath)
      git('commit -m "orphan"', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService
        .diff(workspaceId, { target: { _tag: 'branch' } })
        .pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed('success' as const),
            onFailure: (error) => Effect.succeed(error),
          })
        )

      if (result === 'success' || result._tag !== 'DiffTargetUnresolved') {
        assert.fail('Expected DiffTargetUnresolved')
      }
      assert.strictEqual(result.reason, 'MERGE_BASE_FAILED')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('ignoreWhitespace drops a reindent but keeps a real change', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-ignore-whitespace', tempRoots)
      writeFileSync(join(repoPath, 'reindented.txt'), 'alpha\nbeta\n')
      writeFileSync(join(repoPath, 'edited.txt'), 'one\n')
      git('add .', repoPath)
      git('commit -m "add files"', repoPath)

      writeFileSync(join(repoPath, 'reindented.txt'), '  alpha\n\tbeta\n')
      writeFileSync(join(repoPath, 'edited.txt'), 'two\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const withWhitespace = yield* fileService.diff(workspaceId)
      assert.deepStrictEqual(withWhitespace.map((entry) => entry.path).sort(), [
        'edited.txt',
        'reindented.txt',
      ])

      const ignored = yield* fileService.diff(workspaceId, {
        ignoreWhitespace: true,
      })
      assert.deepStrictEqual(
        ignored.map((entry) => entry.path),
        ['edited.txt'],
        'a whitespace-only change must not reach the pane at all'
      )
      assert.include(
        ignored.find((entry) => entry.path === 'edited.txt')?.patch ?? '',
        '+two'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('ignoreWhitespace composes with the branch target', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-branch-whitespace', tempRoots)
      writeFileSync(join(repoPath, 'reindented.txt'), 'alpha\nbeta\n')
      git('add .', repoPath)
      git('commit -m "add file"', repoPath)

      git('checkout -b feature', repoPath)
      writeFileSync(join(repoPath, 'reindented.txt'), '  alpha\n\tbeta\n')
      git('add .', repoPath)
      git('commit -m "reindent"', repoPath)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const branchEntries = yield* fileService.diff(workspaceId, {
        target: { _tag: 'branch' },
      })
      assert.deepStrictEqual(
        branchEntries.map((entry) => entry.path),
        ['reindented.txt']
      )

      const ignored = yield* fileService.diff(workspaceId, {
        ignoreWhitespace: true,
        target: { _tag: 'branch' },
      })
      assert.deepStrictEqual(
        ignored.map((entry) => entry.path),
        [],
        'a branch whose only commit was a reindent has nothing to review'
      )

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )
})

// =================================================================
// Batched patch helper tests — pure functions
// =================================================================

describe('splitGitPatch', () => {
  it.effect('splits combined diff output on diff --git boundaries', () =>
    Effect.sync(() => {
      const combined = [
        'diff --git a/one.txt b/one.txt',
        'index 111..222 100644',
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/two.txt b/two.txt',
        'index 333..444 100644',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1 +1 @@',
        '-foo',
        '+bar',
        '',
      ].join('\n')

      const chunks = splitGitPatch(combined)
      assert.strictEqual(chunks.length, 2)
      assert.isTrue(chunks[0]?.startsWith('diff --git a/one.txt'))
      assert.isTrue(chunks[1]?.startsWith('diff --git a/two.txt'))
      assert.include(chunks[0] ?? '', '+new')
      assert.include(chunks[1] ?? '', '+bar')
    })
  )

  it.effect('returns empty array for empty output', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(splitGitPatch(''), [])
      assert.deepStrictEqual(splitGitPatch('\n'), [])
    })
  )
})

describe('fileFromPatchChunk', () => {
  it.effect('extracts the path from the +++ b/ header', () =>
    Effect.sync(() => {
      const chunk = [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1 +1 @@',
      ].join('\n')
      assert.strictEqual(fileFromPatchChunk(chunk), 'src/index.ts')
    })
  )

  it.effect('falls back to --- a/ for deletions', () =>
    Effect.sync(() => {
      const chunk = [
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n')
      assert.strictEqual(fileFromPatchChunk(chunk), 'gone.txt')
    })
  )

  it.effect('falls back to the diff --git header for binary chunks', () =>
    Effect.sync(() => {
      const chunk = [
        'diff --git a/logo.png b/logo.png',
        'index 111..222 100644',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n')
      assert.strictEqual(fileFromPatchChunk(chunk), 'logo.png')
    })
  )
})

describe('assembleDiffEntries', () => {
  const fileInfo = (path: string) => ({
    path,
    added: 1,
    removed: 0,
    status: 'modified' as const,
  })

  it.effect('attaches patches and marks entries without one', () =>
    Effect.sync(() => {
      const entries = assembleDiffEntries(
        [fileInfo('a.txt'), fileInfo('b.bin')],
        new Map([['a.txt', 'patch-a']])
      )
      assert.strictEqual(entries[0]?.patch, 'patch-a')
      assert.strictEqual(entries[0]?.truncated, false)
      assert.isUndefined(entries[1]?.patch)
      assert.strictEqual(entries[1]?.truncated, false)
    })
  )

  it.effect('omits oversized patches with truncated: true', () =>
    Effect.sync(() => {
      const huge = 'a'.repeat(10_000_001)
      const entries = assembleDiffEntries(
        [fileInfo('huge.txt'), fileInfo('small.txt')],
        new Map([
          ['huge.txt', huge],
          ['small.txt', 'patch-small'],
        ])
      )
      const hugeEntry = entries.find((e) => e.path === 'huge.txt')
      const smallEntry = entries.find((e) => e.path === 'small.txt')
      assert.isUndefined(hugeEntry?.patch)
      assert.strictEqual(hugeEntry?.truncated, true)
      assert.strictEqual(smallEntry?.patch, 'patch-small')
      assert.strictEqual(smallEntry?.truncated, false)
    })
  )

  it.effect('caps the total patch budget across files', () =>
    Effect.sync(() => {
      const sixMb = 'a'.repeat(6_000_000)
      const entries = assembleDiffEntries(
        [fileInfo('one.txt'), fileInfo('two.txt'), fileInfo('three.txt')],
        new Map([
          ['one.txt', sixMb],
          ['two.txt', sixMb],
          ['three.txt', 'small-patch'],
        ])
      )
      // First fits, second exceeds the 10MB total, third is capped too
      assert.isDefined(entries[0]?.patch)
      assert.isUndefined(entries[1]?.patch)
      assert.strictEqual(entries[1]?.truncated, true)
      assert.isUndefined(entries[2]?.patch)
      assert.strictEqual(entries[2]?.truncated, true)
    })
  )
})

/**
 * `file.diffContents` — both full sides of one file, for hunk expansion.
 *
 * The behaviour under test is which revision each side is read from. A
 * viewer that expands unchanged context is showing code no patch contained,
 * so a wrong revision here is invisible: it renders as plausible source that
 * is not what the diff was cut against.
 */
describe('FileService.diffContents', () => {
  const expectFailure = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.succeed('success' as const),
        onFailure: (error) => Effect.succeed(error),
      })
    )

  it.effect('working reads the old side from HEAD', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-contents-working')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const contents = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        newPath: 'staged.txt',
        oldPath: 'staged.txt',
        target: { _tag: 'working' },
      })

      assert.strictEqual(contents.oldContents, 'before\n')
      assert.strictEqual(contents.newContents, 'after\n')
      assert.isFalse(contents.oldTruncated)
      assert.isFalse(contents.newTruncated)

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('branch reads the old side from the merge-base, not HEAD', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-contents-branch')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService

      // The branch committed `# test\nbranch edit\n` over `# test\n`. Under
      // the branch target the old side is the pre-fork blob; under working
      // it is that same branch commit, which is already the new side.
      const branch = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        newPath: 'README.md',
        oldPath: 'README.md',
        target: { _tag: 'branch' },
      })
      assert.strictEqual(branch.oldContents, '# test\n')

      const working = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        newPath: 'README.md',
        oldPath: 'README.md',
        target: { _tag: 'working' },
      })
      assert.strictEqual(working.oldContents, '# test\nbranch edit\n')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('the new side is verbatim — trailing newlines survive', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-verbatim', tempRoots)
      writeFileSync(join(repoPath, 'lines.txt'), 'one\n')
      git('add lines.txt', repoPath)
      git('commit -m "add lines"', repoPath)
      // Three trailing newlines: a `trimEnd()` would cost the viewer three
      // lines and push the end of the file past the reachable scroll range.
      writeFileSync(join(repoPath, 'lines.txt'), 'one\ntwo\n\n\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const contents = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        newPath: 'lines.txt',
        oldPath: 'lines.txt',
        target: { _tag: 'working' },
      })

      assert.strictEqual(contents.newContents, 'one\ntwo\n\n\n')
      assert.strictEqual(contents.oldContents, 'one\n')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('a rename resolves the old path at the base revision', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-rename', tempRoots)
      writeFileSync(join(repoPath, 'old-name.txt'), 'original\n')
      git('add old-name.txt', repoPath)
      git('commit -m "add old-name"', repoPath)

      git('mv old-name.txt new-name.txt', repoPath)
      writeFileSync(join(repoPath, 'new-name.txt'), 'original\nedited\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const changed = yield* fileService.diffContents(workspaceId, {
        changeType: 'rename-changed',
        newPath: 'new-name.txt',
        oldPath: 'old-name.txt',
        target: { _tag: 'working' },
      })

      assert.strictEqual(changed.oldContents, 'original\n')
      assert.strictEqual(changed.newContents, 'original\nedited\n')

      // A pure rename has no old side to fetch: the loader wants
      // `oldFile: null`, so the blob is never read.
      const pure = yield* fileService.diffContents(workspaceId, {
        changeType: 'rename-pure',
        newPath: 'new-name.txt',
        oldPath: 'old-name.txt',
        target: { _tag: 'working' },
      })
      assert.strictEqual(pure.oldContents, '')
      assert.strictEqual(pure.newContents, 'original\nedited\n')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('an empty file is distinguishable from an absent one', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-empty', tempRoots)
      writeFileSync(join(repoPath, 'empty.txt'), '')
      git('add empty.txt', repoPath)
      git('commit -m "add empty"', repoPath)
      writeFileSync(join(repoPath, 'empty.txt'), 'now has content\n')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService

      // Empty: a success carrying an empty string.
      const empty = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        newPath: 'empty.txt',
        oldPath: 'empty.txt',
        target: { _tag: 'working' },
      })
      assert.strictEqual(empty.oldContents, '')

      // Absent at the base revision: a failure that names the reason.
      const absentOld = yield* expectFailure(
        fileService.diffContents(workspaceId, {
          changeType: 'change',
          newPath: 'empty.txt',
          oldPath: 'never-existed.txt',
          target: { _tag: 'working' },
        })
      )
      if (
        absentOld === 'success' ||
        absentOld._tag !== 'DiffContentsUnavailable'
      ) {
        assert.fail('Expected DiffContentsUnavailable')
      }
      assert.strictEqual(absentOld.reason, 'OLD_PATH_ABSENT')
      assert.strictEqual(absentOld.path, 'never-existed.txt')

      // Absent in the worktree: a different reason again.
      unlinkSync(join(repoPath, 'empty.txt'))
      const absentNew = yield* expectFailure(
        fileService.diffContents(workspaceId, {
          changeType: 'change',
          newPath: 'empty.txt',
          oldPath: 'empty.txt',
          target: { _tag: 'working' },
        })
      )
      if (
        absentNew === 'success' ||
        absentNew._tag !== 'DiffContentsUnavailable'
      ) {
        assert.fail('Expected DiffContentsUnavailable')
      }
      assert.strictEqual(absentNew.reason, 'NEW_PATH_ABSENT')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('the byte cap truncates on a line boundary and reports it', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-cap', tempRoots)
      const body = `${Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join('\n')}\n`
      writeFileSync(join(repoPath, 'big.txt'), body)
      git('add big.txt', repoPath)
      git('commit -m "add big"', repoPath)
      writeFileSync(join(repoPath, 'big.txt'), `${body}tail\n`)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const contents = yield* fileService.diffContents(workspaceId, {
        changeType: 'change',
        maxBytes: 64,
        newPath: 'big.txt',
        oldPath: 'big.txt',
        target: { _tag: 'working' },
      })

      assert.isTrue(contents.newTruncated)
      assert.isTrue(contents.oldTruncated)
      assert.isBelow(Buffer.byteLength(contents.newContents, 'utf-8'), 65)
      assert.isTrue(
        contents.newContents.endsWith('\n'),
        'a cut side must still end on a whole line'
      )
      assert.isTrue(body.startsWith(contents.newContents))

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('a binary file is refused rather than returned as text', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-binary', tempRoots)
      writeFileSync(join(repoPath, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
      git('add blob.bin', repoPath)
      git('commit -m "add blob"', repoPath)
      writeFileSync(join(repoPath, 'blob.bin'), Buffer.from([0, 9, 9, 9]))

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* expectFailure(
        fileService.diffContents(workspaceId, {
          changeType: 'change',
          newPath: 'blob.bin',
          oldPath: 'blob.bin',
          target: { _tag: 'working' },
        })
      )

      if (result === 'success' || result._tag !== 'DiffContentsUnavailable') {
        assert.fail('Expected DiffContentsUnavailable')
      }
      assert.strictEqual(result.reason, 'BINARY_FILE')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('a traversing path is refused before git ever sees it', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-contents-traversal', tempRoots)

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* expectFailure(
        fileService.diffContents(workspaceId, {
          changeType: 'change',
          newPath: 'README.md',
          oldPath: '../outside.txt',
          target: { _tag: 'working' },
        })
      )

      if (result === 'success' || result._tag !== 'RpcError') {
        assert.fail('Expected RpcError')
      }
      assert.strictEqual(result.code, 'PATH_TRAVERSAL')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  it.effect('an unresolvable target fails before any file is read', () =>
    Effect.gen(function* () {
      const repoPath = initBranchRepo('file-svc-contents-bad-ref')

      const { database } = yield* LaborerDatabase
      const workspaceId = seedWorkspace(database, repoPath)

      const fileService = yield* FileService
      const result = yield* expectFailure(
        fileService.diffContents(workspaceId, {
          changeType: 'change',
          newPath: 'staged.txt',
          oldPath: 'staged.txt',
          target: { _tag: 'ref', ref: 'no-such-branch' },
        })
      )

      if (result === 'success' || result._tag !== 'DiffTargetUnresolved') {
        assert.fail('Expected DiffTargetUnresolved')
      }
      assert.strictEqual(result.reason, 'REF_NOT_FOUND')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )
})
