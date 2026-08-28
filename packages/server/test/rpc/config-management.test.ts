import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Result, type Scope } from 'effect'
import { createTempDir, git } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Success<typeof makeScopedTestRpcContext>

const CUSTOM_FIELD_PATTERN = /"customField": "preserve-me"/
const SETUP_SCRIPTS_PATTERN = /"setupScripts": \[\s+"bun install"\s+\]/m
const WORKTREE_DIR_PATTERN = /"worktreeDir": "~\/updated-worktrees"/

const cleanupTempRoots = (tempRoots: readonly string[]) => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const runWithRpcTestContext = <A, E>(
  run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* makeScopedTestRpcContext
    return yield* run(context)
  }) as Effect.Effect<A, E, Scope.Scope>

const initRepoAt = (repoPath: string) => {
  mkdirSync(repoPath, { recursive: true })
  git('init -b main', repoPath)
  git('config user.email test@example.com', repoPath)
  git('config user.name Test User', repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# config rpc test\n')
  git('add README.md', repoPath)
  git('commit -m "initial"', repoPath)
}

const writeLaborerConfig = (
  dirPath: string,
  config: Record<string, unknown>
): string => {
  const configPath = join(dirPath, 'laborer.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}

describe('LaborerRpcs config management', () => {
  it.effect(
    'config.get resolves config through real service layers with field provenance',
    () =>
      runWithRpcTestContext(({ client }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const tempRoot = createTempDir('rpc-config-get', tempRoots)
          const parentDir = join(tempRoot, 'config-parent')
          const repoPath = join(parentDir, 'repo')

          mkdirSync(parentDir, { recursive: true })
          initRepoAt(repoPath)

          const ancestorConfigPath = writeLaborerConfig(parentDir, {
            worktreeDir: '~/ancestor-worktrees',
          })
          const projectConfigPath = writeLaborerConfig(repoPath, {
            setupScripts: ['bun install', 'bun test'],
          })

          const project = yield* client['project.add']({
            id: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            repoPath,
          })
          const config = yield* client['config.get']({ projectId: project.id })

          // Config source paths are resolved relative to the
          // canonical project root, so canonicalize expectations.
          const canonicalProjectConfigPath = realpathSync(projectConfigPath)
          const canonicalAncestorConfigPath = realpathSync(ancestorConfigPath)

          const {
            agent: resolvedAgent,
            shortName: resolvedShortName,
            ...configWithoutAgent
          } = config
          assert.deepStrictEqual(configWithoutAgent, {
            conflictPrompt: { source: 'default', value: '' },
            shortNameAliases: { source: 'default', value: [] },
            setupScripts: {
              source: canonicalProjectConfigPath,
              value: ['bun install', 'bun test'],
            },
            previewUrls: { source: 'default', value: [] },
            watchIgnore: { source: 'default', value: [] },
            worktreeDir: {
              source: canonicalAncestorConfigPath,
              value: join(homedir(), 'ancestor-worktrees'),
            },
          })
          assert.strictEqual(resolvedAgent.value, 'opencode2')
          assert.isString(resolvedAgent.source)
          assert.isNotEmpty(resolvedShortName.value)
        })
      )
  )

  it.effect(
    'preserves renamed short names as aliases and rejects namespace conflicts',
    () =>
      runWithRpcTestContext(({ client }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )
          const firstPath = createTempDir('rpc-alias-first', tempRoots)
          const secondPath = createTempDir('rpc-alias-second', tempRoots)
          initRepoAt(firstPath)
          initRepoAt(secondPath)
          writeLaborerConfig(firstPath, { shortName: 'FIRST' })
          writeLaborerConfig(secondPath, { shortName: 'SECOND' })
          const first = yield* client['project.add']({
            id: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            repoPath: firstPath,
          })
          const second = yield* client['project.add']({
            id: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            repoPath: secondPath,
          })

          yield* client['config.update']({
            projectId: first.id,
            config: { shortName: 'RENAMED' },
          })
          const renamed = yield* client['config.get']({ projectId: first.id })
          assert.strictEqual(renamed.shortName.value, 'RENAMED')
          assert.deepStrictEqual(renamed.shortNameAliases.value, ['FIRST'])

          const conflict = yield* client['config.update']({
            projectId: second.id,
            config: { shortName: 'FIRST' },
          }).pipe(Effect.result)
          assert.isTrue(Result.isFailure(conflict))
          if (Result.isFailure(conflict)) {
            assert.strictEqual(
              conflict.failure.code,
              'PROJECT_SHORT_NAME_CONFLICT'
            )
          }

          yield* client['config.update']({
            projectId: first.id,
            config: { shortName: 'FIRST' },
          })
          const renamedBack = yield* client['config.get']({
            projectId: first.id,
          })
          assert.strictEqual(renamedBack.shortName.value, 'FIRST')
          assert.deepStrictEqual(renamedBack.shortNameAliases.value, [
            'RENAMED',
          ])
        })
      )
  )

  it.effect('config.get returns NOT_FOUND for a missing project', () =>
    runWithRpcTestContext(({ client }) =>
      Effect.gen(function* () {
        const result = yield* client['config.get']({
          projectId: 'missing-project',
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isSuccess(result)) {
          assert.fail('Expected config.get to fail for a missing project')
        }

        assert.strictEqual(result.failure.code, 'NOT_FOUND')
        assert.strictEqual(
          result.failure.message,
          'Project not found: missing-project'
        )
      })
    )
  )

  it.effect(
    'config.update writes project config through the RPC contract and makes it retrievable',
    () =>
      runWithRpcTestContext(({ client }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = createTempDir('rpc-config-update', tempRoots)
          initRepoAt(repoPath)
          const configPath = writeLaborerConfig(repoPath, {
            customField: 'preserve-me',
          })

          const project = yield* client['project.add']({
            id: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            repoPath,
          })

          yield* client['config.update']({
            projectId: project.id,
            config: {
              agent: 'opencode2',
              shortName: 'RPC',
              setupScripts: ['bun install'],
              worktreeDir: '~/updated-worktrees',
            },
          })

          // The config file is written using the canonical path since
          // the project's repoPath is now canonical.
          const canonicalConfigPath = realpathSync(configPath)
          const writtenConfig = readFileSync(canonicalConfigPath, 'utf-8')

          assert.match(writtenConfig, CUSTOM_FIELD_PATTERN)
          assert.match(writtenConfig, SETUP_SCRIPTS_PATTERN)
          assert.match(writtenConfig, WORKTREE_DIR_PATTERN)

          const resolved = yield* client['config.get']({
            projectId: project.id,
          })

          assert.deepStrictEqual(resolved, {
            agent: { source: canonicalConfigPath, value: 'opencode2' },
            conflictPrompt: { source: 'default', value: '' },
            shortName: { source: canonicalConfigPath, value: 'RPC' },
            shortNameAliases: {
              source: canonicalConfigPath,
              value: [
                project.name
                  .toUpperCase()
                  .replaceAll(/[^A-Z0-9]/g, '')
                  .slice(0, 10),
              ],
            },
            setupScripts: {
              source: canonicalConfigPath,
              value: ['bun install'],
            },
            previewUrls: { source: 'default', value: [] },
            watchIgnore: { source: 'default', value: [] },
            worktreeDir: {
              source: canonicalConfigPath,
              value: join(homedir(), 'updated-worktrees'),
            },
          })
        })
      )
  )

  it.effect('config.update round-trips a project conflict prompt', () =>
    runWithRpcTestContext(({ client }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const repoPath = createTempDir('rpc-conflict-prompt', tempRoots)
        initRepoAt(repoPath)
        const configPath = writeLaborerConfig(repoPath, {})

        const project = yield* client['project.add']({
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          repoPath,
        })

        const prompt = 'Rebase onto dev and resolve every conflict.'
        yield* client['config.update']({
          projectId: project.id,
          config: { conflictPrompt: prompt },
        })

        const canonicalConfigPath = realpathSync(configPath)
        const resolved = yield* client['config.get']({
          projectId: project.id,
        })

        assert.deepStrictEqual(resolved.conflictPrompt, {
          source: canonicalConfigPath,
          value: prompt,
        })

        // Emptying the field clears the action rather than leaving the
        // previous prompt behind.
        yield* client['config.update']({
          projectId: project.id,
          config: { conflictPrompt: '' },
        })

        const cleared = yield* client['config.get']({ projectId: project.id })
        assert.strictEqual(cleared.conflictPrompt.value, '')
      })
    )
  )
})
