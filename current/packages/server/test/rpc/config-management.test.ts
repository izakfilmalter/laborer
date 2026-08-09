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
            worktreeDir: '~/ancestor-worktrees',
          })
          const projectConfigPath = writeLaborerConfig(repoPath, {
            setupScripts: ['bun install', 'bun test'],
          })

          const project = yield* client.project.add({ repoPath })
          const config = yield* client.config.get({ projectId: project.id })

          // Config source paths are resolved relative to the
          // canonical project root, so canonicalize expectations.
          const canonicalProjectConfigPath = realpathSync(projectConfigPath)
          const canonicalAncestorConfigPath = realpathSync(ancestorConfigPath)

          // Check all resolved fields except defaultSandboxProvider
          // and devServer.provider, which both depend on the real global
          // config (defaultSandboxProvider falls back to devServer.provider)
          // and vary by environment.
          const {
            agent: resolvedAgent,
            defaultSandboxProvider: _dsp,
            ...configWithoutDefault
          } = config
          const { provider: _prov, ...devServerWithoutProvider } =
            configWithoutDefault.devServer
          assert.deepStrictEqual(
            { ...configWithoutDefault, devServer: devServerWithoutProvider },
            {
              devServer: {
                autoOpen: { source: 'default', value: false },
                autoStopInterval: { source: 'default', value: null },
                dockerfile: { source: 'default', value: null },
                image: { source: 'default', value: 'node:lts' },
                installCommand: { source: 'default', value: null },
                network: { source: 'default', value: null },
                port: { source: 'default', value: null },
                resources: { source: 'default', value: null },
                setupScripts: {
                  source: 'default',
                  value: [
                    'corepack enable',
                    'pnpm install --force',
                    'exec bash',
                  ],
                },
                startCommand: { source: 'default', value: null },
                workdir: { source: 'default', value: '/app' },
              },
              setupScripts: {
                source: canonicalProjectConfigPath,
                value: ['bun install', 'bun test'],
              },
              watchIgnore: {
                source: 'default',
                value: [],
              },
              worktreeDir: {
                source: canonicalAncestorConfigPath,
                value: join(homedir(), 'ancestor-worktrees'),
              },
            }
          )
          assert.strictEqual(resolvedAgent.value, 'opencode2')
          assert.isString(resolvedAgent.source)
          // defaultSandboxProvider has a valid structure regardless of value
          assert.isString(config.defaultSandboxProvider.source)
          assert.include(
            [null, 'docker', 'daytona'],
            config.defaultSandboxProvider.value
          )
          // devServer.provider falls back to defaultSandboxProvider when
          // no per-project provider is set (Issue 6)
          assert.isString(config.devServer.provider.source)
          assert.include(
            [null, 'docker', 'daytona'],
            config.devServer.provider.value
          )
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
          })

          const project = yield* client.project.add({ repoPath })

          yield* client.config.update({
            projectId: project.id,
            config: {
              agent: 'opencode2',
              devServer: {
                autoOpen: true,
              },
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

          const resolved = yield* client.config.get({ projectId: project.id })

          // Check all fields except defaultSandboxProvider and
          // devServer.provider (both env-dependent due to global fallback).
          const { defaultSandboxProvider: _dsp2, ...resolvedWithoutDefault } =
            resolved
          const { provider: _prov2, ...resolvedDevServerWithoutProvider } =
            resolvedWithoutDefault.devServer
          assert.deepStrictEqual(
            {
              ...resolvedWithoutDefault,
              devServer: resolvedDevServerWithoutProvider,
            },
            {
              agent: { source: canonicalConfigPath, value: 'opencode2' },
              devServer: {
                autoOpen: { source: canonicalConfigPath, value: true },
                autoStopInterval: { source: 'default', value: null },
                dockerfile: { source: 'default', value: null },
                image: { source: 'default', value: 'node:lts' },
                installCommand: { source: 'default', value: null },
                network: { source: 'default', value: null },
                port: { source: 'default', value: null },
                resources: { source: 'default', value: null },
                setupScripts: {
                  source: 'default',
                  value: [
                    'corepack enable',
                    'pnpm install --force',
                    'exec bash',
                  ],
                },
                startCommand: { source: 'default', value: null },
                workdir: { source: 'default', value: '/app' },
              },
              setupScripts: {
                source: canonicalConfigPath,
                value: ['bun install'],
              },
              watchIgnore: {
                source: 'default',
                value: [],
              },
              worktreeDir: {
                source: canonicalConfigPath,
                value: join(homedir(), 'updated-worktrees'),
              },
            }
          )
          // devServer.provider is env-dependent (Issue 6 fallback)
          assert.isString(resolved.devServer.provider.source)
          assert.include(
            [null, 'docker', 'daytona'],
            resolved.devServer.provider.value
          )
        })
      )
  )
})
