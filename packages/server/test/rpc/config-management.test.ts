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
import { Effect, Either, type Scope } from 'effect'
import { createTempDir, git } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

const CUSTOM_FIELD_PATTERN = /"customField": "preserve-me"/
const PRDS_DIR_PATTERN = /"prdsDir": "\/tmp\/existing-prds"/
const RLPH_CONFIG_PATTERN = /"rlphConfig": "rlph\/project\.json"/
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
  git('init', repoPath)
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
  it.scoped(
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
            rlphConfig: 'ancestor-rlph.json',
            worktreeDir: '~/ancestor-worktrees',
          })
          const projectConfigPath = writeLaborerConfig(repoPath, {
            prdsDir: '/tmp/project-prds',
            setupScripts: ['bun install', 'bun test'],
          })

          const project = yield* client.project.add({ repoPath })
          const config = yield* client.config.get({ projectId: project.id })

          // Config source paths are resolved relative to the
          // canonical project root, so canonicalize expectations.
          const canonicalProjectConfigPath = realpathSync(projectConfigPath)
          const canonicalAncestorConfigPath = realpathSync(ancestorConfigPath)

          assert.deepStrictEqual(config, {
            prdsDir: {
              source: canonicalProjectConfigPath,
              value: '/tmp/project-prds',
            },
            rlphConfig: {
              source: canonicalAncestorConfigPath,
              value: 'ancestor-rlph.json',
            },
            setupScripts: {
              source: canonicalProjectConfigPath,
              value: ['bun install', 'bun test'],
            },
            worktreeDir: {
              source: canonicalAncestorConfigPath,
              value: join(homedir(), 'ancestor-worktrees'),
            },
          })
        })
      )
  )

  it.scoped('config.get returns NOT_FOUND for a missing project', () =>
    runWithRpcTestContext(({ client }) =>
      Effect.gen(function* () {
        const result = yield* client.config
          .get({ projectId: 'missing-project' })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isRight(result)) {
          assert.fail('Expected config.get to fail for a missing project')
        }

        assert.strictEqual(result.left.code, 'NOT_FOUND')
        assert.strictEqual(
          result.left.message,
          'Project not found: missing-project'
        )
      })
    )
  )

  it.scoped(
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
            prdsDir: '/tmp/existing-prds',
          })

          const project = yield* client.project.add({ repoPath })

          yield* client.config.update({
            projectId: project.id,
            config: {
              rlphConfig: 'rlph/project.json',
              setupScripts: ['bun install'],
              worktreeDir: '~/updated-worktrees',
            },
          })

          // The config file is written using the canonical path since
          // the project's repoPath is now canonical.
          const canonicalConfigPath = realpathSync(configPath)
          const writtenConfig = readFileSync(canonicalConfigPath, 'utf-8')

          assert.match(writtenConfig, CUSTOM_FIELD_PATTERN)
          assert.match(writtenConfig, PRDS_DIR_PATTERN)
          assert.match(writtenConfig, RLPH_CONFIG_PATTERN)
          assert.match(writtenConfig, SETUP_SCRIPTS_PATTERN)
          assert.match(writtenConfig, WORKTREE_DIR_PATTERN)

          const resolved = yield* client.config.get({ projectId: project.id })

          assert.deepStrictEqual(resolved, {
            prdsDir: {
              source: canonicalConfigPath,
              value: '/tmp/existing-prds',
            },
            rlphConfig: {
              source: canonicalConfigPath,
              value: 'rlph/project.json',
            },
            setupScripts: {
              source: canonicalConfigPath,
              value: ['bun install'],
            },
            worktreeDir: {
              source: canonicalConfigPath,
              value: join(homedir(), 'updated-worktrees'),
            },
          })
        })
      )
  )
})
