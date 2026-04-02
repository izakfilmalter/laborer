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
import { events } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { FileService } from '../src/services/file-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'

/**
 * Layer for FileService tests — provides real FileService with
 * in-memory LaborerStore and no-op file watcher client.
 */
const TestFileServiceLayer = FileService.layer.pipe(
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

describe('FileService', () => {
  // --- Behavior 1: Basic listing with correct shape ---
  it.scoped('list returns files and directories with correct shape', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-shape', tempRoots)
      mkdirSync(join(repoPath, 'src'), { recursive: true })
      writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
      writeFileSync(join(repoPath, 'package.json'), '{}\n')

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list sorts directories before files, alphabetical within', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-sort', tempRoots)
      mkdirSync(join(repoPath, 'zebra'), { recursive: true })
      mkdirSync(join(repoPath, 'alpha'), { recursive: true })
      writeFileSync(join(repoPath, 'zfile.txt'), '')
      writeFileSync(join(repoPath, 'afile.txt'), '')

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list skips ignored directories (node_modules, .git, etc)', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-ignored-dirs', tempRoots)
      mkdirSync(join(repoPath, 'node_modules'), { recursive: true })
      mkdirSync(join(repoPath, 'dist'), { recursive: true })
      mkdirSync(join(repoPath, 'src'), { recursive: true })

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list skips OS metadata files (.DS_Store, Thumbs.db)', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-ignored-files', tempRoots)
      writeFileSync(join(repoPath, '.DS_Store'), '')
      writeFileSync(join(repoPath, 'Thumbs.db'), '')
      writeFileSync(join(repoPath, 'real-file.txt'), 'hello\n')

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list with dir parameter returns subdirectory children', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-subdir', tempRoots)
      mkdirSync(join(repoPath, 'src/components'), { recursive: true })
      writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
      writeFileSync(join(repoPath, 'src/components/Button.tsx'), 'export {}\n')

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list rejects path traversal outside worktree root', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-traversal', tempRoots)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('list fails with NOT_FOUND for unknown workspace', () =>
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

  // --- Behavior 8: INVALID_STATE for destroyed workspace ---
  it.scoped('list fails with INVALID_STATE for destroyed workspace', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('file-svc-destroyed', tempRoots)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath, 'destroyed')

      const fileService = yield* FileService
      const result = yield* fileService.list(workspaceId).pipe(
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
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // =================================================================
  // FileService.read() tests — Issue 3
  // =================================================================

  // --- Behavior 9: Read a text file returns correct content ---
  it.scoped('read returns text file content with type "text"', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-text', tempRoots)
      writeFileSync(join(repoPath, 'hello.txt'), 'Hello, world!\n')
      git('add hello.txt', repoPath)
      git('commit -m "add hello"', repoPath)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns diff and patch for a modified tracked file', () =>
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

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns diff via --staged fallback for staged changes', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-staged', tempRoots)
      writeFileSync(join(repoPath, 'staged.txt'), 'original\n')
      git('add staged.txt', repoPath)
      git('commit -m "add staged"', repoPath)

      // Modify and stage the file (but do not commit)
      writeFileSync(join(repoPath, 'staged.txt'), 'modified\n')
      git('add staged.txt', repoPath)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns no diff/patch for an unmodified tracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-clean', tempRoots)
      writeFileSync(join(repoPath, 'clean.txt'), 'no changes\n')
      git('add clean.txt', repoPath)
      git('commit -m "add clean"', repoPath)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns content but no diff for an untracked file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-untracked', tempRoots)
      writeFileSync(join(repoPath, 'new-file.txt'), 'brand new\n')
      // Do NOT git add — leave untracked

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns type "binary" for binary file extensions', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-binary', tempRoots)
      writeFileSync(join(repoPath, 'app.exe'), Buffer.from([0, 1, 2, 3]))

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'app.exe')

      assert.strictEqual(result.type, 'binary')
      assert.strictEqual(result.content, '')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 15: Read an image file returns base64 with mimeType ---
  it.scoped('read returns base64 content with mimeType for image files', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-image', tempRoots)
      // Write a minimal 1x1 PNG (smallest valid PNG file)
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
      writeFileSync(join(repoPath, 'icon.png'), pngBytes)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read returns empty content for a non-existent file', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-missing', tempRoots)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

      const fileService = yield* FileService
      const result = yield* fileService.read(workspaceId, 'does-not-exist.txt')

      assert.strictEqual(result.type, 'text')
      assert.strictEqual(result.content, '')

      cleanupTempRoots()
    }).pipe(Effect.provide(TestFileServiceLayer))
  )

  // --- Behavior 17: Read rejects path traversal ---
  it.scoped('read rejects path traversal outside worktree root', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-read-traversal', tempRoots)

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('read fails with NOT_FOUND for unknown workspace', () =>
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
  it.scoped(
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

        const { store } = yield* LaborerStore
        const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped(
    'status returns untracked file with status "added" and line count',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-svc-status-added', tempRoots)
        writeFileSync(join(repoPath, 'new-file.txt'), 'hello\nworld\n')
        // Do NOT git add — leave untracked

        const { store } = yield* LaborerStore
        const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('status returns deleted file with status "deleted"', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-status-deleted', tempRoots)
      writeFileSync(join(repoPath, 'to-delete.txt'), 'goodbye\n')
      git('add to-delete.txt', repoPath)
      git('commit -m "add to-delete"', repoPath)

      // Delete the file (tracked deletion, not staged)
      unlinkSync(join(repoPath, 'to-delete.txt'))

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('status returns empty array for clean working tree', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('file-svc-status-clean', tempRoots)
      // initRepo already commits README.md, so the tree is clean

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('status returns modified, added, and deleted files together', () =>
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

      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)

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
  it.scoped('status fails with NOT_FOUND for unknown workspace', () =>
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
})
