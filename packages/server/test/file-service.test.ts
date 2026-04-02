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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { FileService } from '../src/services/file-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { createTempDir, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

/**
 * Layer for FileService tests — provides real FileService with
 * in-memory LaborerStore (no file watcher needed for list).
 */
const TestFileServiceLayer = FileService.layer.pipe(
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
})
