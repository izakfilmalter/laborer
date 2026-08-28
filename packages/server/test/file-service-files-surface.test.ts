/**
 * FileService — Files-surface operations
 *
 * Covers the three RPC backends added for the right panel's Files surface:
 * `listEntries` (flat recursive listing for the explorer), `readText`
 * (verbatim, capped text reads for the preview/editor), and `write`
 * (debounced-save persistence). Tests use real temporary git repositories,
 * offline and deterministic.
 *
 * @see file-service.ts — FileService implementation
 */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FileService } from '../src/services/file-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'

const TestFileServiceLayer = FileService.layer.pipe(
  Layer.provide(TestFileWatcherClientLayer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

const tempRoots: string[] = []

const seedWorkspace = (database: NativeLaborerDatabase, repoPath: string) => {
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
    baseBranch: null,
    branchName: 'main',
    id: workspaceId,
    rootPath: repoPath,
    source: 'manual',
    status: 'in_progress',
    title: 'Test workspace',
    worktreePath: repoPath,
    worktreeStatus: 'ready',
  })

  return workspaceId
}

describe('FileService files surface', () => {
  describe('listEntries', () => {
    it.effect('walks the worktree into a flat directory-first listing', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-entries-shape', tempRoots)
        mkdirSync(join(repoPath, 'src/components'), { recursive: true })
        writeFileSync(join(repoPath, 'src/index.ts'), 'export {}\n')
        writeFileSync(join(repoPath, 'src/components/app.tsx'), 'export {}\n')
        writeFileSync(join(repoPath, 'package.json'), '{}\n')

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.listEntries(workspaceId)

        assert.isFalse(result.truncated)
        assert.deepEqual(
          result.entries.map((entry) => `${entry.kind}:${entry.path}`),
          [
            'directory:src',
            'directory:src/components',
            'file:src/components/app.tsx',
            'file:src/index.ts',
            'file:package.json',
            'file:README.md',
          ]
        )
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('skips noisy directories and gitignored entries', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-entries-ignore', tempRoots)
        mkdirSync(join(repoPath, 'node_modules/pkg'), { recursive: true })
        writeFileSync(join(repoPath, 'node_modules/pkg/index.js'), '')
        mkdirSync(join(repoPath, 'dist'), { recursive: true })
        writeFileSync(join(repoPath, 'dist/out.js'), '')
        writeFileSync(join(repoPath, '.gitignore'), 'secret.txt\ncovered/\n')
        writeFileSync(join(repoPath, 'secret.txt'), 'hidden\n')
        mkdirSync(join(repoPath, 'covered'), { recursive: true })
        writeFileSync(join(repoPath, 'covered/inner.txt'), 'hidden\n')
        writeFileSync(join(repoPath, '.DS_Store'), '')
        writeFileSync(join(repoPath, 'kept.txt'), 'kept\n')

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.listEntries(workspaceId)

        const paths = result.entries.map((entry) => entry.path)
        assert.include(paths, 'kept.txt')
        assert.include(paths, '.gitignore')
        assert.notInclude(paths, 'node_modules')
        assert.notInclude(paths, 'dist')
        assert.notInclude(paths, 'secret.txt')
        assert.notInclude(paths, 'covered')
        assert.notInclude(paths, 'covered/inner.txt')
        assert.notInclude(paths, '.DS_Store')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('fails with NOT_FOUND for an unknown workspace', () =>
      Effect.gen(function* () {
        const fileService = yield* FileService
        const result = yield* Effect.flip(fileService.listEntries('missing'))
        assert.strictEqual(result.code, 'NOT_FOUND')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )
  })

  describe('readText', () => {
    it.effect('returns verbatim contents with true byte length', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-text', tempRoots)
        // Trailing newline and inner whitespace must survive: the editor
        // shows the file exactly as it is, unlike file.read's trimEnd.
        const contents = 'line one  \nline two\n\n'
        writeFileSync(join(repoPath, 'notes.txt'), contents)

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.readText(workspaceId, 'notes.txt')

        assert.strictEqual(result.contents, contents)
        assert.strictEqual(result.relativePath, 'notes.txt')
        assert.strictEqual(result.byteLength, Buffer.byteLength(contents))
        assert.isFalse(result.truncated)
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('caps oversized files at 1 MB and flags truncation', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-cap', tempRoots)
        const oneMegabyte = 1024 * 1024
        const contents = 'a'.repeat(oneMegabyte + 512)
        writeFileSync(join(repoPath, 'big.txt'), contents)

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.readText(workspaceId, 'big.txt')

        assert.strictEqual(result.contents.length, oneMegabyte)
        assert.strictEqual(result.byteLength, oneMegabyte + 512)
        assert.isTrue(result.truncated)
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('fails with BINARY_FILE for binary extensions and content', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-binary', tempRoots)
        writeFileSync(join(repoPath, 'archive.zip'), 'not really a zip')
        writeFileSync(
          join(repoPath, 'sniffed'),
          Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69])
        )

        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const byExtension = yield* Effect.flip(
          fileService.readText(workspaceId, 'archive.zip')
        )
        assert.strictEqual(byExtension.code, 'BINARY_FILE')

        const bySniff = yield* Effect.flip(
          fileService.readText(workspaceId, 'sniffed')
        )
        assert.strictEqual(bySniff.code, 'BINARY_FILE')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('fails with NOT_FOUND for a missing file', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-missing', tempRoots)
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* Effect.flip(
          fileService.readText(workspaceId, 'nope.txt')
        )
        assert.strictEqual(result.code, 'NOT_FOUND')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('fails with PATH_TRAVERSAL when the path escapes the root', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-escape', tempRoots)
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* Effect.flip(
          fileService.readText(workspaceId, '../outside.txt')
        )
        assert.strictEqual(result.code, 'PATH_TRAVERSAL')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('rejects reads through an escaping symlink', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-symlink-escape', tempRoots)
        const outsidePath = join(repoPath, '..', `${crypto.randomUUID()}.txt`)
        writeFileSync(outsidePath, 'outside\n')
        symlinkSync(outsidePath, join(repoPath, 'escape.txt'))
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const result = yield* Effect.flip(
          (yield* FileService).readText(workspaceId, 'escape.txt')
        )

        assert.strictEqual(result.code, 'PATH_TRAVERSAL')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('reads through a symlink that remains inside the workspace', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-read-symlink-inside', tempRoots)
        writeFileSync(join(repoPath, 'target.txt'), 'inside\n')
        symlinkSync('target.txt', join(repoPath, 'alias.txt'))
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const result = yield* (yield* FileService).readText(
          workspaceId,
          'alias.txt'
        )

        assert.strictEqual(result.contents, 'inside\n')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )
  })

  describe('write', () => {
    it.effect('writes contents verbatim and echoes the path', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-write', tempRoots)
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* fileService.write(
          workspaceId,
          'README.md',
          '# rewritten\n'
        )

        assert.strictEqual(result.relativePath, 'README.md')
        assert.strictEqual(
          readFileSync(join(repoPath, 'README.md'), 'utf-8'),
          '# rewritten\n'
        )
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('creates missing parent directories', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-write-mkdir', tempRoots)
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        yield* fileService.write(workspaceId, 'docs/new/guide.md', '# hi\n')

        assert.strictEqual(
          readFileSync(join(repoPath, 'docs/new/guide.md'), 'utf-8'),
          '# hi\n'
        )
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect('fails with PATH_TRAVERSAL when the path escapes the root', () =>
      Effect.gen(function* () {
        const repoPath = initRepo('file-write-escape', tempRoots)
        const { database } = yield* LaborerDatabase
        const workspaceId = seedWorkspace(database, repoPath)

        const fileService = yield* FileService
        const result = yield* Effect.flip(
          fileService.write(workspaceId, '../escape.txt', 'nope')
        )
        assert.strictEqual(result.code, 'PATH_TRAVERSAL')
      }).pipe(Effect.provide(TestFileServiceLayer))
    )

    it.effect(
      'writes through a directory symlink contained by the workspace',
      () =>
        Effect.gen(function* () {
          const repoPath = initRepo(
            'file-write-directory-symlink-inside',
            tempRoots
          )
          mkdirSync(join(repoPath, 'actual'))
          symlinkSync('actual', join(repoPath, 'alias'))
          const { database } = yield* LaborerDatabase
          const workspaceId = seedWorkspace(database, repoPath)

          yield* (yield* FileService).write(
            workspaceId,
            'alias/created.txt',
            'inside\n'
          )

          assert.strictEqual(
            readFileSync(join(repoPath, 'actual/created.txt'), 'utf8'),
            'inside\n'
          )
        }).pipe(Effect.provide(TestFileServiceLayer))
    )
  })
})
