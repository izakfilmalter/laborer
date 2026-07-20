// @effect-diagnostics effect/preferSchemaOverJson:off

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll, beforeAll } from 'vitest'
import { ConfigService } from '../src/services/config-service.js'
import {
  issuesFilePathFromPrdPath,
  PrdStorageService,
  prdFileNameFromTitle,
  slugifyPrdTitle,
} from '../src/services/prd-storage-service.js'

const createTempDir = (prefix: string): string => {
  const dir = join(
    tmpdir(),
    `laborer-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

const PrdStorageTestLayer = PrdStorageService.layer.pipe(
  Layer.provide(ConfigService.layer)
)

let testRoot: string

beforeAll(() => {
  testRoot = createTempDir('prd-storage-service')
})

afterAll(() => {
  if (testRoot) {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

describe('PrdStorageService', () => {
  it('slugifies PRD titles into safe file names', () => {
    assert.strictEqual(
      slugifyPrdTitle(' MCP Server & PRD Workflow! '),
      'mcp-server-prd-workflow'
    )
    assert.strictEqual(prdFileNameFromTitle('Plan / MVP'), 'PRD-plan-mvp.md')
  })

  it.effect('creates PRD files under the resolved default prdsDir', () =>
    Effect.gen(function* () {
      const projectDir = join(testRoot, 'default-prds-dir-project')
      const worktreeDir = join(testRoot, 'default-prds-dir-worktrees')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(
        join(projectDir, 'laborer.json'),
        JSON.stringify({ worktreeDir }, null, 2)
      )

      const service = yield* PrdStorageService
      const filePath = yield* service.createPrdFile(
        projectDir,
        'default-prds-dir-project',
        'MCP Planning',
        '# PRD\n'
      )

      assert.strictEqual(
        filePath,
        join(worktreeDir, 'prds', 'PRD-mcp-planning.md')
      )
      assert.isTrue(existsSync(filePath))
      assert.strictEqual(readFileSync(filePath, 'utf-8'), '# PRD\n')
    }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect(
    'uses a custom prdsDir from laborer.json and reads files back',
    () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'custom-prds-dir-project')
        const customPrdsDir = join(testRoot, 'custom-prds-dir-output')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
          join(projectDir, 'laborer.json'),
          JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
        )

        const service = yield* PrdStorageService
        const filePath = yield* service.createPrdFile(
          projectDir,
          'custom-prds-dir-project',
          'Read Me Later',
          '## Body\n'
        )
        const content = yield* service.readPrdFile(filePath)
        const resolvedPrdsDir = yield* service.resolvePrdsDir(
          projectDir,
          'custom-prds-dir-project'
        )

        assert.strictEqual(resolvedPrdsDir, customPrdsDir)
        assert.strictEqual(
          filePath,
          join(customPrdsDir, 'PRD-read-me-later.md')
        )
        assert.strictEqual(content, '## Body\n')
      }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect('overwrites existing PRD files atomically', () =>
    Effect.gen(function* () {
      const projectDir = join(testRoot, 'update-prds-dir-project')
      const customPrdsDir = join(testRoot, 'update-prds-dir-output')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(
        join(projectDir, 'laborer.json'),
        JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
      )

      const service = yield* PrdStorageService
      const filePath = yield* service.createPrdFile(
        projectDir,
        'update-prds-dir-project',
        'Editable Plan',
        '# Draft\n'
      )

      yield* service.updatePrdFile(filePath, '# Final\n')

      const content = yield* service.readPrdFile(filePath)

      assert.strictEqual(filePath, join(customPrdsDir, 'PRD-editable-plan.md'))
      assert.strictEqual(content, '# Final\n')
    }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect(
    'creates and appends companion PRD issues files with numbered sections',
    () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'issues-prds-dir-project')
        const customPrdsDir = join(testRoot, 'issues-prds-dir-output')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
          join(projectDir, 'laborer.json'),
          JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
        )

        const service = yield* PrdStorageService
        const prdFilePath = yield* service.createPrdFile(
          projectDir,
          'issues-prds-dir-project',
          'Issue Workflow',
          '# PRD\n'
        )

        const firstIssue = yield* service.appendIssue(
          prdFilePath,
          'Create issue RPC',
          '### What to build\n\nAdd the RPC handler.'
        )
        const secondIssue = yield* service.appendIssue(
          prdFilePath,
          'List remaining issues',
          '### What to build\n\nFilter pending tasks.'
        )

        const issuesContent = readFileSync(firstIssue.issueFilePath, 'utf-8')

        assert.strictEqual(firstIssue.issueNumber, 1)
        assert.strictEqual(secondIssue.issueNumber, 2)
        assert.strictEqual(
          firstIssue.issueFilePath,
          issuesFilePathFromPrdPath(
            join(customPrdsDir, 'PRD-issue-workflow.md')
          )
        )
        assert.isTrue(existsSync(firstIssue.issueFilePath))
        assert.include(issuesContent, '## Issue 1: Create issue RPC')
        assert.include(issuesContent, '## Issue 2: List remaining issues')
        assert.include(issuesContent, '\n\n---\n\n')
      }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect(
    'reads companion PRD issues files and returns an empty string when missing',
    () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'read-issues-prds-dir-project')
        const customPrdsDir = join(testRoot, 'read-issues-prds-dir-output')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
          join(projectDir, 'laborer.json'),
          JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
        )

        const service = yield* PrdStorageService
        const prdFilePath = yield* service.createPrdFile(
          projectDir,
          'read-issues-prds-dir-project',
          'Issue Reader',
          '# PRD\n'
        )

        const emptyIssues = yield* service.readIssuesFile(prdFilePath)

        yield* service.appendIssue(
          prdFilePath,
          'Read issues RPC',
          '### What to build\n\nReturn issues content.'
        )

        const populatedIssues = yield* service.readIssuesFile(prdFilePath)

        assert.strictEqual(emptyIssues, '')
        assert.include(populatedIssues, '## Issue 1: Read issues RPC')
      }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect(
    'updates a single issue section without changing neighboring issues',
    () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'update-issue-prds-dir-project')
        const customPrdsDir = join(testRoot, 'update-issue-prds-dir-output')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
          join(projectDir, 'laborer.json'),
          JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
        )

        const service = yield* PrdStorageService
        const prdFilePath = yield* service.createPrdFile(
          projectDir,
          'update-issue-prds-dir-project',
          'Issue Updater',
          '# PRD\n'
        )

        yield* service.appendIssue(
          prdFilePath,
          'First issue',
          '### What to build\n\nKeep this body.'
        )
        yield* service.appendIssue(
          prdFilePath,
          'Second issue',
          '### What to build\n\nReplace this body.'
        )
        yield* service.appendIssue(
          prdFilePath,
          'Third issue',
          '### What to build\n\nKeep this one too.'
        )

        yield* service.updateIssue(
          prdFilePath,
          'Second issue',
          '### What to build\n\nUpdated body.',
          2
        )

        const result = yield* service.readIssuesFile(prdFilePath)

        assert.include(
          result,
          '## Issue 1: First issue\n\n### What to build\n\nKeep this body.'
        )
        assert.include(
          result,
          '## Issue 2: Second issue\n\n### What to build\n\nUpdated body.'
        )
        assert.include(
          result,
          '## Issue 3: Third issue\n\n### What to build\n\nKeep this one too.'
        )
        assert.notInclude(result, 'Replace this body.')
      }).pipe(Effect.provide(PrdStorageTestLayer))
  )

  it.effect(
    'removes PRD files and companion issues files when deleting a PRD',
    () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'remove-prd-project')
        const customPrdsDir = join(testRoot, 'remove-prd-output')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
          join(projectDir, 'laborer.json'),
          JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
        )

        const service = yield* PrdStorageService
        const prdFilePath = yield* service.createPrdFile(
          projectDir,
          'remove-prd-project',
          'Disposable Plan',
          '# PRD\n'
        )

        const issue = yield* service.appendIssue(
          prdFilePath,
          'Linked issue',
          '### What to build\n\nDelete files.'
        )

        yield* service.removePrdArtifacts(prdFilePath)

        assert.isFalse(existsSync(prdFilePath))
        assert.isFalse(existsSync(issue.issueFilePath))
      }).pipe(Effect.provide(PrdStorageTestLayer))
  )
})
