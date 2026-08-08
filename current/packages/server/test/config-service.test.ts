// @effect-diagnostics effect/preferSchemaOverJson:off

/**
 * ConfigService integration tests.
 *
 * Tests config resolution, walk-up directory traversal, global config
 * fallback, provenance metadata, tilde expansion, and error handling
 * through the public ConfigService API using real temporary directories
 * on the filesystem.
 *
 * All tests exercise ConfigService.resolveConfig, ConfigService.readGlobalConfig,
 * or ConfigService.writeProjectConfig — no internal helpers are tested directly.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterAll, beforeAll } from 'vitest'
import {
  CONFIG_FILE_NAME,
  ConfigService,
  type ConfigValidationError,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_PATH,
  type LaborerConfig,
  type ResolvedLaborerConfig,
} from '../src/services/config-service.js'
import { createTempDir } from './helpers/git-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a laborer.json config file at the given directory. */
const writeConfig = (dir: string, config: LaborerConfig): string => {
  const configPath = join(dir, CONFIG_FILE_NAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  return configPath
}

/** Run ConfigService.resolveConfig via the layer. */
const resolveConfig = (
  projectRepoPath: string,
  projectName: string
): Effect.Effect<ResolvedLaborerConfig, ConfigValidationError> =>
  Effect.gen(function* () {
    const service = yield* ConfigService
    return yield* service.resolveConfig(projectRepoPath, projectName)
  }).pipe(Effect.provide(ConfigService.layer))

/** Run ConfigService.readGlobalConfig via the layer. */
const readGlobalConfig = (): Effect.Effect<LaborerConfig> =>
  Effect.gen(function* () {
    const service = yield* ConfigService
    return yield* service.readGlobalConfig()
  }).pipe(Effect.provide(ConfigService.layer))

/** Run ConfigService.writeProjectConfig via the layer. */
const writeProjectConfig = (
  projectRepoPath: string,
  updates: {
    devServer?:
      | {
          autoOpen?: boolean | undefined
          dockerfile?: string | undefined
          image?: string | undefined
          startCommand?: string | undefined
          workdir?: string | undefined
        }
      | undefined
    brrrConfig?: string | undefined
    setupScripts?: readonly string[] | undefined
    worktreeDir?: string | undefined
  }
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const service = yield* ConfigService
    yield* service.writeProjectConfig(projectRepoPath, updates)
  }).pipe(Effect.provide(ConfigService.layer))

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Temp directories for cleanup. */
const tempRoots: string[] = []

/** Root temp directory for all tests in this suite. */
let testRoot: string

beforeAll(() => {
  testRoot = createTempDir('config-service', tempRoots)
})

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ConfigService.resolveConfig
// ---------------------------------------------------------------------------

describe('ConfigService', () => {
  describe('resolveConfig', () => {
    it.effect('should re-read config file on each resolve call', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'no-cache-between-calls')
        mkdirSync(projectDir, { recursive: true })

        const configPath = writeConfig(projectDir, {
          worktreeDir: '/tmp/first-worktrees',
        })

        const first = yield* resolveConfig(projectDir, 'cache-test-project')
        assert.strictEqual(first.worktreeDir.value, '/tmp/first-worktrees')
        assert.strictEqual(first.worktreeDir.source, configPath)

        writeConfig(projectDir, {
          worktreeDir: '/tmp/second-worktrees',
        })

        const second = yield* resolveConfig(projectDir, 'cache-test-project')
        assert.strictEqual(second.worktreeDir.value, '/tmp/second-worktrees')
        assert.strictEqual(second.worktreeDir.source, configPath)
      })
    )

    it.effect('should return defaults when no config files exist', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'no-config-project')
        mkdirSync(projectDir, { recursive: true })

        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(result.worktreeDir.source, 'default')
        assert.strictEqual(result.worktreeDir.value, `${projectDir}.worktrees`)
        assert.strictEqual(result.setupScripts.source, 'default')
        assert.deepStrictEqual(result.setupScripts.value, [])
        assert.strictEqual(result.brrrConfig.source, 'default')
        assert.isNull(result.brrrConfig.value)
      })
    )

    it.effect('should resolve none as a sandbox provider', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'none-sandbox-provider')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          defaultSandboxProvider: 'none',
          devServer: { provider: 'none' },
        })

        const result = yield* resolveConfig(projectDir, 'none-provider-project')

        assert.strictEqual(result.defaultSandboxProvider.value, 'none')
        assert.strictEqual(result.defaultSandboxProvider.source, configPath)
        assert.strictEqual(result.devServer.provider.value, 'none')
        assert.strictEqual(result.devServer.provider.source, configPath)
      })
    )

    it.effect('should read config from project root', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'project-root-config')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          worktreeDir: '/custom/worktrees',
          setupScripts: ['bun install', 'cp .env.example .env'],
          brrrConfig: 'brrr-config.json',
        })

        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(result.worktreeDir.value, '/custom/worktrees')
        assert.strictEqual(result.worktreeDir.source, configPath)
        assert.deepStrictEqual(result.setupScripts.value, [
          'bun install',
          'cp .env.example .env',
        ])
        assert.strictEqual(result.setupScripts.source, configPath)
        assert.strictEqual(result.brrrConfig.value, 'brrr-config.json')
        assert.strictEqual(result.brrrConfig.source, configPath)
      })
    )

    it.effect('migrates legacy OpenCode config to OpenCode 2 when read', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'legacy-opencode-migration')
        mkdirSync(projectDir, { recursive: true })
        const configPath = join(projectDir, CONFIG_FILE_NAME)
        writeFileSync(
          configPath,
          JSON.stringify({ agent: 'opencode', customField: 'preserve-me' })
        )

        const result = yield* resolveConfig(projectDir, 'migration-test')
        const migrated = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          agent: string
          customField: string
        }

        assert.strictEqual(result.agent.value, 'opencode2')
        assert.strictEqual(result.agent.source, configPath)
        assert.deepStrictEqual(migrated, {
          agent: 'opencode2',
          customField: 'preserve-me',
        })
      })
    )

    it.effect('should inherit from ancestor config', () =>
      Effect.gen(function* () {
        const parent = join(testRoot, 'ancestor-inherit-parent')
        const child = join(parent, 'child-project')
        mkdirSync(child, { recursive: true })

        writeConfig(parent, {
          worktreeDir: '~/parent-worktrees',
        })
        const childConfigPath = writeConfig(child, {
          setupScripts: ['pnpm install'],
        })

        const result = yield* resolveConfig(child, 'child-project')

        // setupScripts from child (closest)
        assert.deepStrictEqual(result.setupScripts.value, ['pnpm install'])
        assert.strictEqual(result.setupScripts.source, childConfigPath)

        // worktreeDir from parent (inherited)
        assert.strictEqual(
          result.worktreeDir.value,
          join(homedir(), 'parent-worktrees')
        )
      })
    )

    it.effect('should override ancestor config with project root config', () =>
      Effect.gen(function* () {
        const parent = join(testRoot, 'override-parent')
        const child = join(parent, 'override-child')
        mkdirSync(child, { recursive: true })

        writeConfig(parent, {
          worktreeDir: '/parent-worktrees',
          setupScripts: ['parent-script'],
        })
        const childConfigPath = writeConfig(child, {
          worktreeDir: '/child-worktrees',
        })

        const result = yield* resolveConfig(child, 'child-project')

        // worktreeDir from child overrides parent
        assert.strictEqual(result.worktreeDir.value, '/child-worktrees')
        assert.strictEqual(result.worktreeDir.source, childConfigPath)

        // setupScripts still from parent (child doesn't set it)
        assert.deepStrictEqual(result.setupScripts.value, ['parent-script'])
      })
    )

    it.effect('should expand tilde in worktreeDir from config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'tilde-expansion-worktree')
        mkdirSync(projectDir, { recursive: true })
        writeConfig(projectDir, {
          worktreeDir: '~/my-laborer-worktrees',
        })

        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(
          result.worktreeDir.value,
          join(homedir(), 'my-laborer-worktrees')
        )
      })
    )

    it.effect('should resolve relative worktreeDir to absolute path', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'relative-worktree')
        mkdirSync(projectDir, { recursive: true })
        writeConfig(projectDir, {
          worktreeDir: 'relative/path',
        })

        const result = yield* resolveConfig(projectDir, 'test-project')

        // resolve() converts relative to absolute based on cwd
        assert.isTrue(result.worktreeDir.value.startsWith('/'))
      })
    )

    it.effect('should handle malformed config gracefully', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'malformed-config-project')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(join(projectDir, CONFIG_FILE_NAME), '{ broken json !!!')

        // Should not throw — falls back to defaults
        const result = yield* resolveConfig(projectDir, 'test-project')

        // Malformed config is treated as empty, so defaults apply
        assert.strictEqual(result.worktreeDir.source, 'default')
      })
    )

    it.effect('should handle empty config file gracefully', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'empty-config-project')
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(join(projectDir, CONFIG_FILE_NAME), '')

        // Should not throw — falls back to defaults
        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(result.worktreeDir.source, 'default')
        assert.strictEqual(result.setupScripts.source, 'default')
      })
    )

    it.effect('should use global config as fallback', () =>
      Effect.gen(function* () {
        // This test depends on whether a global config exists on the machine.
        // We just verify the service doesn't crash and returns a valid result.
        const projectDir = join(testRoot, 'global-fallback-project')
        mkdirSync(projectDir, { recursive: true })

        const result = yield* resolveConfig(projectDir, 'global-fallback-test')

        // Should always have a valid worktreeDir
        assert.isTrue(result.worktreeDir.value.length > 0)
        assert.strictEqual(typeof result.worktreeDir.value, 'string')
      })
    )

    it.effect('should preserve provenance for each field independently', () =>
      Effect.gen(function* () {
        const grandparent = join(testRoot, 'provenance-grandparent')
        const parent = join(grandparent, 'provenance-parent')
        const child = join(parent, 'provenance-child')
        mkdirSync(child, { recursive: true })

        const gpPath = writeConfig(grandparent, {
          brrrConfig: 'grandparent-brrr.json',
        })
        writeConfig(parent, {
          worktreeDir: '/parent-worktrees',
        })
        const childPath = writeConfig(child, {
          setupScripts: ['child-script'],
        })

        const result = yield* resolveConfig(child, 'provenance-test')

        // Each field's provenance should trace to the config that set it
        assert.strictEqual(result.setupScripts.source, childPath)
        assert.strictEqual(result.brrrConfig.source, gpPath)
      })
    )
  })

  // ---------------------------------------------------------------------------
  // ConfigService.readGlobalConfig
  // ---------------------------------------------------------------------------

  describe('readGlobalConfig', () => {
    it.effect(
      'should return empty config when no global config file exists',
      () =>
        Effect.gen(function* () {
          // The global config file may or may not exist on the machine.
          // This test just verifies it doesn't crash.
          const result = yield* readGlobalConfig()

          assert.isDefined(result)
          assert.strictEqual(typeof result, 'object')
        })
    )

    it.effect('should ensure global config directory exists', () =>
      Effect.gen(function* () {
        // Just calling readGlobalConfig should create the directory
        yield* readGlobalConfig()

        // The GLOBAL_CONFIG_DIR should exist (it may have existed before)
        assert.isTrue(existsSync(GLOBAL_CONFIG_DIR))
      })
    )
  })

  // ---------------------------------------------------------------------------
  // ConfigService.writeProjectConfig
  // ---------------------------------------------------------------------------

  describe('writeProjectConfig', () => {
    it.effect('should create laborer.json when missing', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-create-missing')
        mkdirSync(projectDir, { recursive: true })

        yield* writeProjectConfig(projectDir, {
          worktreeDir: '~/custom-worktrees',
        })

        const configPath = join(projectDir, CONFIG_FILE_NAME)
        assert.isTrue(existsSync(configPath))

        const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          worktreeDir?: string
        }
        assert.strictEqual(written.worktreeDir, '~/custom-worktrees')
      })
    )

    it.effect('should merge updates without clobbering unrelated fields', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-merge')
        mkdirSync(projectDir, { recursive: true })

        writeConfig(projectDir, {
          worktreeDir: '/existing/worktrees',
          brrrConfig: 'brrr-existing.json',
        })

        yield* writeProjectConfig(projectDir, {
          setupScripts: ['bun install', 'bun test'],
        })

        const written = JSON.parse(
          readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
        ) as {
          brrrConfig?: string
          setupScripts?: string[]
          worktreeDir?: string
        }

        assert.strictEqual(written.worktreeDir, '/existing/worktrees')
        assert.strictEqual(written.brrrConfig, 'brrr-existing.json')
        assert.deepStrictEqual(written.setupScripts, [
          'bun install',
          'bun test',
        ])
      })
    )

    it.effect('should preserve unknown fields in existing config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-preserve-unknown')
        mkdirSync(projectDir, { recursive: true })

        const configPath = join(projectDir, CONFIG_FILE_NAME)
        writeFileSync(
          configPath,
          JSON.stringify(
            {
              worktreeDir: '/existing/worktrees',
              customField: 'preserve-me',
              nested: { hello: 'world' },
            },
            null,
            2
          )
        )

        yield* writeProjectConfig(projectDir, {
          brrrConfig: 'new-brrr.json',
        })

        const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          customField?: string
          nested?: { hello?: string }
          brrrConfig?: string
          worktreeDir?: string
        }

        assert.strictEqual(written.customField, 'preserve-me')
        assert.strictEqual(written.nested?.hello, 'world')
        assert.strictEqual(written.worktreeDir, '/existing/worktrees')
        assert.strictEqual(written.brrrConfig, 'new-brrr.json')
      })
    )

    it.effect('should not write undefined fields', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-ignore-undefined')
        mkdirSync(projectDir, { recursive: true })

        writeConfig(projectDir, {
          setupScripts: ['existing-script'],
          worktreeDir: '/existing/worktrees',
        })

        yield* writeProjectConfig(projectDir, {
          brrrConfig: 'updated-brrr.json',
          setupScripts: undefined,
          worktreeDir: undefined,
        })

        const written = JSON.parse(
          readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
        ) as {
          brrrConfig?: string
          setupScripts?: string[]
          worktreeDir?: string
        }

        assert.strictEqual(written.brrrConfig, 'updated-brrr.json')
        assert.deepStrictEqual(written.setupScripts, ['existing-script'])
        assert.strictEqual(written.worktreeDir, '/existing/worktrees')
      })
    )

    it.effect(
      'should allow written config to be read back via resolveConfig',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'write-then-read')
          mkdirSync(projectDir, { recursive: true })

          yield* writeProjectConfig(projectDir, {
            worktreeDir: '/written/worktrees',
            setupScripts: ['bun install'],
          })

          const result = yield* resolveConfig(projectDir, 'roundtrip-project')

          assert.strictEqual(result.worktreeDir.value, '/written/worktrees')
          assert.deepStrictEqual(result.setupScripts.value, ['bun install'])
        })
    )

    it.effect(
      'should persist and read back watchIgnore patterns via writeProjectConfig',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'write-watch-ignore')
          mkdirSync(projectDir, { recursive: true })

          const service = yield* ConfigService
          yield* service.writeProjectConfig(projectDir, {
            watchIgnore: ['.cache', 'tmp', '.myBuildOutput'],
          })

          // Verify the file was written correctly
          const rawContent = JSON.parse(
            readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
          ) as { watchIgnore?: readonly string[] }
          assert.deepStrictEqual(rawContent.watchIgnore, [
            '.cache',
            'tmp',
            '.myBuildOutput',
          ])

          // Verify it can be read back via resolveConfig
          const result = yield* service.resolveConfig(
            projectDir,
            'watchignore-roundtrip'
          )
          assert.deepStrictEqual(result.watchIgnore.value, [
            '.cache',
            'tmp',
            '.myBuildOutput',
          ])
          assert.include(
            result.watchIgnore.source,
            'laborer.json',
            'Source should reference the config file'
          )
        }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect('should write and read back devServer config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-devserver-roundtrip')
        mkdirSync(projectDir, { recursive: true })

        yield* writeProjectConfig(projectDir, {
          devServer: {
            autoOpen: true,
            image: 'node:22',
            startCommand: 'bun dev',
            workdir: '/workspace',
          },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-roundtrip')

        assert.strictEqual(result.devServer.autoOpen.value, true)
        assert.strictEqual(result.devServer.image.value, 'node:22')
        assert.strictEqual(result.devServer.startCommand.value, 'bun dev')
        assert.strictEqual(result.devServer.workdir.value, '/workspace')
        assert.isNull(result.devServer.dockerfile.value)
      })
    )

    it.effect(
      'should merge devServer updates without clobbering existing devServer fields',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'write-devserver-merge')
          mkdirSync(projectDir, { recursive: true })

          writeConfig(projectDir, {
            devServer: {
              image: 'node:22',
              startCommand: 'npm run dev',
            },
          })

          yield* writeProjectConfig(projectDir, {
            devServer: { startCommand: 'bun dev' },
          })

          const configPath = join(projectDir, CONFIG_FILE_NAME)
          const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
            devServer?: { image?: string; startCommand?: string }
          }

          assert.strictEqual(written.devServer?.image, 'node:22')
          assert.strictEqual(written.devServer?.startCommand, 'bun dev')
        })
    )
  })

  // ---------------------------------------------------------------------------
  // devServer config resolution
  // ---------------------------------------------------------------------------

  describe('devServer config', () => {
    it.effect('should return defaults when no devServer config exists', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'no-devserver')
        mkdirSync(projectDir, { recursive: true })

        const result = yield* resolveConfig(projectDir, 'no-devserver')

        assert.strictEqual(result.devServer.autoOpen.value, false)
        assert.strictEqual(result.devServer.image.value, 'node:lts')
        assert.isNull(result.devServer.dockerfile.value)
        assert.isNull(result.devServer.startCommand.value)
        assert.strictEqual(result.devServer.workdir.value, '/app')
        assert.strictEqual(result.devServer.image.source, 'default')
        assert.strictEqual(result.devServer.dockerfile.source, 'default')
        assert.strictEqual(result.devServer.autoOpen.source, 'default')
        assert.strictEqual(result.devServer.startCommand.source, 'default')
        assert.strictEqual(result.devServer.workdir.source, 'default')
      })
    )

    it.effect('should read devServer.autoOpen from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'devserver-auto-open')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { autoOpen: true, image: 'node:22' },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-auto-open')

        assert.strictEqual(result.devServer.autoOpen.value, true)
        assert.strictEqual(result.devServer.autoOpen.source, configPath)
      })
    )

    it.effect('should read devServer.image from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'devserver-image')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { image: 'node:22' },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-image')

        assert.strictEqual(result.devServer.image.value, 'node:22')
        assert.strictEqual(result.devServer.image.source, configPath)
        assert.strictEqual(result.devServer.workdir.value, '/app')
      })
    )

    it.effect('should read devServer.dockerfile from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'devserver-dockerfile')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { dockerfile: './Dockerfile.dev' },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-dockerfile')

        assert.strictEqual(
          result.devServer.dockerfile.value,
          './Dockerfile.dev'
        )
        assert.strictEqual(result.devServer.dockerfile.source, configPath)
        assert.isNull(result.devServer.image.value)
      })
    )

    it.effect('should read devServer.startCommand from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'devserver-startcmd')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { image: 'node:22', startCommand: 'bun dev' },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-startcmd')

        assert.strictEqual(result.devServer.startCommand.value, 'bun dev')
        assert.strictEqual(result.devServer.startCommand.source, configPath)
      })
    )

    it.effect('should read devServer.workdir from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'devserver-workdir')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { image: 'node:22', workdir: '/workspace' },
        })

        const result = yield* resolveConfig(projectDir, 'devserver-workdir')

        assert.strictEqual(result.devServer.workdir.value, '/workspace')
        assert.strictEqual(result.devServer.workdir.source, configPath)
      })
    )

    it.effect(
      'should reject config with both image and dockerfile specified',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'devserver-mutual-exclusion')
          mkdirSync(projectDir, { recursive: true })
          writeConfig(projectDir, {
            devServer: {
              image: 'node:22',
              dockerfile: './Dockerfile.dev',
            },
          })

          const result = yield* resolveConfig(
            projectDir,
            'devserver-exclusive'
          ).pipe(Effect.either)

          assert.isTrue(
            result._tag === 'Left',
            'Expected validation error for mutually exclusive image + dockerfile'
          )
          if (result._tag === 'Left') {
            assert.include(result.left.message, 'mutually exclusive')
          }
        })
    )

    it.effect('should inherit devServer fields from ancestor config', () =>
      Effect.gen(function* () {
        const parent = join(testRoot, 'devserver-inherit-parent')
        const child = join(parent, 'devserver-inherit-child')
        mkdirSync(child, { recursive: true })

        writeConfig(parent, {
          devServer: {
            image: 'node:20',
            startCommand: 'npm start',
            workdir: '/parent-app',
          },
        })
        const childConfigPath = writeConfig(child, {
          devServer: {
            startCommand: 'bun dev',
          },
        })

        const result = yield* resolveConfig(child, 'devserver-inherit')

        // startCommand overridden by child
        assert.strictEqual(result.devServer.startCommand.value, 'bun dev')
        assert.strictEqual(
          result.devServer.startCommand.source,
          childConfigPath
        )
        // image inherited from parent
        assert.strictEqual(result.devServer.image.value, 'node:20')
        // workdir inherited from parent
        assert.strictEqual(result.devServer.workdir.value, '/parent-app')
      })
    )

    it.effect(
      'should override ancestor devServer fields with project config',
      () =>
        Effect.gen(function* () {
          const parent = join(testRoot, 'devserver-override-parent')
          const child = join(parent, 'devserver-override-child')
          mkdirSync(child, { recursive: true })

          writeConfig(parent, {
            devServer: {
              image: 'node:18',
              workdir: '/parent-workdir',
            },
          })
          const childConfigPath = writeConfig(child, {
            devServer: {
              image: 'node:22',
            },
          })

          const result = yield* resolveConfig(child, 'devserver-override')

          // image overridden by child
          assert.strictEqual(result.devServer.image.value, 'node:22')
          assert.strictEqual(result.devServer.image.source, childConfigPath)
          // workdir inherited from parent (child doesn't set it)
          assert.strictEqual(result.devServer.workdir.value, '/parent-workdir')
        })
    )

    it.effect(
      'should clear parent image when child sets dockerfile (mutually exclusive)',
      () =>
        Effect.gen(function* () {
          const parent = join(testRoot, 'devserver-crosslayer-exclusive-parent')
          const child = join(parent, 'devserver-crosslayer-exclusive-child')
          mkdirSync(child, { recursive: true })

          writeConfig(parent, {
            devServer: { image: 'node:22' },
          })
          const childPath = writeConfig(child, {
            devServer: { dockerfile: './Dockerfile.dev' },
          })

          const result = yield* resolveConfig(child, 'devserver-crosslayer')

          // Child setting dockerfile should clear parent's image
          assert.isNull(result.devServer.image.value)
          assert.strictEqual(
            result.devServer.dockerfile.value,
            './Dockerfile.dev'
          )
          assert.strictEqual(result.devServer.dockerfile.source, childPath)
        })
    )

    it.effect(
      'should preserve provenance for each devServer field independently',
      () =>
        Effect.gen(function* () {
          const grandparent = join(testRoot, 'devserver-provenance-gp')
          const parent = join(grandparent, 'devserver-provenance-parent')
          const child = join(parent, 'devserver-provenance-child')
          mkdirSync(child, { recursive: true })

          const gpPath = writeConfig(grandparent, {
            devServer: {
              image: 'node:18',
              workdir: '/gp-app',
            },
          })
          const parentPath = writeConfig(parent, {
            devServer: { startCommand: 'npm start' },
          })
          const childPath = writeConfig(child, {
            devServer: { workdir: '/child-app' },
          })

          const result = yield* resolveConfig(child, 'devserver-provenance')

          assert.strictEqual(result.devServer.image.source, gpPath)
          assert.strictEqual(result.devServer.image.value, 'node:18')
          assert.strictEqual(result.devServer.startCommand.source, parentPath)
          assert.strictEqual(result.devServer.startCommand.value, 'npm start')
          assert.strictEqual(result.devServer.workdir.source, childPath)
          assert.strictEqual(result.devServer.workdir.value, '/child-app')
          assert.strictEqual(result.devServer.dockerfile.source, 'default')
          assert.isNull(result.devServer.dockerfile.value)
        })
    )
  })

  // -------------------------------------------------------------------------
  // Provider config fields (Issue 5)
  // -------------------------------------------------------------------------

  describe('provider config', () => {
    it.effect(
      'should return null defaults for provider, resources, autoStopInterval',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'provider-defaults')
          mkdirSync(projectDir, { recursive: true })

          // Back up and clear global config to isolate defaults
          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }

            const result = yield* resolveConfig(projectDir, 'provider-defaults')

            assert.isNull(result.devServer.provider.value)
            assert.strictEqual(result.devServer.provider.source, 'default')
            assert.isNull(result.devServer.resources.value)
            assert.strictEqual(result.devServer.resources.source, 'default')
            assert.isNull(result.devServer.autoStopInterval.value)
            assert.strictEqual(
              result.devServer.autoStopInterval.source,
              'default'
            )
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            }
          }
        })
    )

    it.effect('should read devServer.provider from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'provider-daytona')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: { provider: 'daytona' } as never,
        })

        const result = yield* resolveConfig(projectDir, 'provider-daytona')

        assert.strictEqual(result.devServer.provider.value, 'daytona')
        assert.strictEqual(result.devServer.provider.source, configPath)
      })
    )

    it.effect(
      'should read devServer.provider "docker" from project config',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'provider-docker')
          mkdirSync(projectDir, { recursive: true })
          const configPath = writeConfig(projectDir, {
            devServer: { provider: 'docker' } as never,
          })

          const result = yield* resolveConfig(projectDir, 'provider-docker')

          assert.strictEqual(result.devServer.provider.value, 'docker')
          assert.strictEqual(result.devServer.provider.source, configPath)
        })
    )

    it.effect('should reject invalid provider value', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'provider-invalid')
        mkdirSync(projectDir, { recursive: true })
        writeConfig(projectDir, {
          devServer: { provider: 'invalid' } as never,
        })

        const result = yield* resolveConfig(
          projectDir,
          'provider-invalid'
        ).pipe(Effect.either)

        assert.isTrue(
          result._tag === 'Left',
          'Expected validation error for invalid provider'
        )
        if (result._tag === 'Left') {
          assert.include(result.left.message, 'provider')
        }
      })
    )

    it.effect(
      'should read devServer.autoStopInterval from project config',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'auto-stop-interval')
          mkdirSync(projectDir, { recursive: true })
          const configPath = writeConfig(projectDir, {
            devServer: { autoStopInterval: 30 } as never,
          })

          const result = yield* resolveConfig(projectDir, 'auto-stop-interval')

          assert.strictEqual(result.devServer.autoStopInterval.value, 30)
          assert.strictEqual(
            result.devServer.autoStopInterval.source,
            configPath
          )
        })
    )

    it.effect('should read devServer.resources from project config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'resources')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          devServer: {
            resources: { cpu: 4, memory: 8, disk: 50 },
          } as never,
        })

        const result = yield* resolveConfig(projectDir, 'resources')

        assert.deepStrictEqual(result.devServer.resources.value, {
          cpu: 4,
          memory: 8,
          disk: 50,
        })
        assert.strictEqual(result.devServer.resources.source, configPath)
      })
    )

    it.effect('should inherit provider from ancestor config', () =>
      Effect.gen(function* () {
        const parent = join(testRoot, 'provider-inherit-parent')
        const child = join(parent, 'provider-inherit-child')
        mkdirSync(child, { recursive: true })

        const parentPath = writeConfig(parent, {
          devServer: { provider: 'daytona' } as never,
        })
        writeConfig(child, {
          devServer: { startCommand: 'bun dev' },
        })

        const result = yield* resolveConfig(child, 'provider-inherit')

        // provider inherited from parent
        assert.strictEqual(result.devServer.provider.value, 'daytona')
        assert.strictEqual(result.devServer.provider.source, parentPath)
      })
    )

    it.effect('should override ancestor provider with project config', () =>
      Effect.gen(function* () {
        const parent = join(testRoot, 'provider-override-parent')
        const child = join(parent, 'provider-override-child')
        mkdirSync(child, { recursive: true })

        writeConfig(parent, {
          devServer: { provider: 'daytona' } as never,
        })
        const childPath = writeConfig(child, {
          devServer: { provider: 'docker' } as never,
        })

        const result = yield* resolveConfig(child, 'provider-override')

        assert.strictEqual(result.devServer.provider.value, 'docker')
        assert.strictEqual(result.devServer.provider.source, childPath)
      })
    )

    it.effect('should write and round-trip provider config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'provider-write-roundtrip')
        mkdirSync(projectDir, { recursive: true })

        const svc = yield* ConfigService

        yield* svc.writeProjectConfig(projectDir, {
          devServer: {
            provider: 'daytona',
            autoStopInterval: 20,
            resources: { cpu: 2, memory: 4 },
          } as never,
        })

        const raw = JSON.parse(
          readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
        ) as Record<string, unknown>
        const rawDs = raw.devServer as Record<string, unknown>
        assert.strictEqual(rawDs.provider, 'daytona')
        assert.strictEqual(rawDs.autoStopInterval, 20)
        assert.deepStrictEqual(rawDs.resources, { cpu: 2, memory: 4 })

        const result = yield* svc.resolveConfig(
          projectDir,
          'provider-write-roundtrip'
        )
        assert.strictEqual(result.devServer.provider.value, 'daytona')
        assert.strictEqual(result.devServer.autoStopInterval.value, 20)
        assert.deepStrictEqual(result.devServer.resources.value, {
          cpu: 2,
          memory: 4,
        })
      }).pipe(Effect.provide(ConfigService.layer))
    )
  })

  describe('defaultSandboxProvider resolution', () => {
    it.effect(
      'should default to null when no defaultSandboxProvider is set',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'default-provider-null')
          mkdirSync(projectDir, { recursive: true })

          // Back up and clear global config to ensure clean default
          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            // Remove global config so it doesn't set defaultSandboxProvider
            if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }

            const result = yield* resolveConfig(
              projectDir,
              'default-provider-null'
            )

            assert.isNull(result.defaultSandboxProvider.value)
            assert.strictEqual(result.defaultSandboxProvider.source, 'default')
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            }
          }
        })
    )

    it.effect('should read defaultSandboxProvider from global config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'default-provider-global')
        mkdirSync(projectDir, { recursive: true })

        // Write the global config with defaultSandboxProvider
        const svc = yield* ConfigService
        yield* svc.writeGlobalConfig({
          defaultSandboxProvider: 'daytona',
        } as never)

        const result = yield* svc.resolveConfig(
          projectDir,
          'default-provider-global'
        )

        assert.strictEqual(result.defaultSandboxProvider.value, 'daytona')
        assert.strictEqual(
          result.defaultSandboxProvider.source,
          GLOBAL_CONFIG_PATH
        )
      }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect('should read defaultSandboxProvider from global config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'default-provider-global')
        mkdirSync(projectDir, { recursive: true })

        // Back up and restore global config around the test
        const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
          ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
          : null

        try {
          // Write the global config with defaultSandboxProvider
          const svc = yield* ConfigService
          yield* svc.writeGlobalConfig({
            defaultSandboxProvider: 'daytona',
          } as never)

          const result = yield* svc.resolveConfig(
            projectDir,
            'default-provider-global'
          )

          assert.strictEqual(result.defaultSandboxProvider.value, 'daytona')
          assert.strictEqual(
            result.defaultSandboxProvider.source,
            GLOBAL_CONFIG_PATH
          )
        } finally {
          // Restore original global config
          if (globalConfigBackup !== null) {
            writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
          } else if (existsSync(GLOBAL_CONFIG_PATH)) {
            rmSync(GLOBAL_CONFIG_PATH)
          }
        }
      }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect(
      'should let per-project devServer.provider override defaultSandboxProvider',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'default-provider-override')
          mkdirSync(projectDir, { recursive: true })

          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            // Write global config with defaultSandboxProvider: daytona
            const svc = yield* ConfigService
            yield* svc.writeGlobalConfig({
              defaultSandboxProvider: 'daytona',
            } as never)

            // Write project config with devServer.provider: docker
            const configPath = writeConfig(projectDir, {
              devServer: { provider: 'docker' } as never,
            })

            const result = yield* svc.resolveConfig(
              projectDir,
              'default-provider-override'
            )

            // Per-project devServer.provider overrides global default
            assert.strictEqual(result.devServer.provider.value, 'docker')
            assert.strictEqual(result.devServer.provider.source, configPath)

            // Global defaultSandboxProvider is still daytona
            assert.strictEqual(result.defaultSandboxProvider.value, 'daytona')
            assert.strictEqual(
              result.defaultSandboxProvider.source,
              GLOBAL_CONFIG_PATH
            )
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            } else if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }
          }
        }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect(
      'should write and round-trip defaultSandboxProvider in global config',
      () =>
        Effect.gen(function* () {
          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            const svc = yield* ConfigService

            yield* svc.writeGlobalConfig({
              defaultSandboxProvider: 'daytona',
            } as never)

            const globalConfig = yield* svc.readGlobalConfig()
            assert.strictEqual(globalConfig.defaultSandboxProvider, 'daytona')
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            } else if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }
          }
        }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect(
      'should resolve defaultSandboxProvider from closest config layer',
      () =>
        Effect.gen(function* () {
          const parentDir = join(testRoot, 'default-provider-parent')
          const projectDir = join(parentDir, 'child')
          mkdirSync(projectDir, { recursive: true })

          const parentPath = writeConfig(parentDir, {
            defaultSandboxProvider: 'daytona',
          } as never)

          const result = yield* resolveConfig(
            projectDir,
            'default-provider-parent'
          )

          assert.strictEqual(result.defaultSandboxProvider.value, 'daytona')
          assert.strictEqual(result.defaultSandboxProvider.source, parentPath)
        })
    )

    it.effect(
      'should fall back devServer.provider to defaultSandboxProvider when no per-project provider is set',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'provider-fallback')
          mkdirSync(projectDir, { recursive: true })

          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            // Write global config with defaultSandboxProvider: daytona
            const svc = yield* ConfigService
            yield* svc.writeGlobalConfig({
              defaultSandboxProvider: 'daytona',
            } as never)

            // Project config has no devServer.provider set
            writeConfig(projectDir, {
              devServer: { startCommand: 'bun dev' } as never,
            })

            const result = yield* svc.resolveConfig(
              projectDir,
              'provider-fallback'
            )

            // devServer.provider falls back to global defaultSandboxProvider
            assert.strictEqual(result.devServer.provider.value, 'daytona')
            assert.strictEqual(
              result.devServer.provider.source,
              GLOBAL_CONFIG_PATH
            )

            // defaultSandboxProvider itself is daytona
            assert.strictEqual(result.defaultSandboxProvider.value, 'daytona')
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            } else if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }
          }
        }).pipe(Effect.provide(ConfigService.layer))
    )

    it.effect(
      'should keep devServer.provider as null when no defaultSandboxProvider is set',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'provider-no-fallback')
          mkdirSync(projectDir, { recursive: true })

          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            // Remove global config so defaultSandboxProvider is null
            if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }

            // Project config has no devServer.provider set
            writeConfig(projectDir, {
              devServer: { startCommand: 'bun dev' } as never,
            })

            const result = yield* resolveConfig(
              projectDir,
              'provider-no-fallback'
            )

            // devServer.provider stays null (no fallback available)
            assert.isNull(result.devServer.provider.value)
            assert.strictEqual(result.devServer.provider.source, 'default')

            // defaultSandboxProvider is also null
            assert.isNull(result.defaultSandboxProvider.value)
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            }
          }
        })
    )

    it.effect(
      'should fall back devServer.provider from ancestor defaultSandboxProvider',
      () =>
        Effect.gen(function* () {
          const parentDir = join(testRoot, 'provider-fallback-ancestor')
          const projectDir = join(parentDir, 'child')
          mkdirSync(projectDir, { recursive: true })

          const globalConfigBackup = existsSync(GLOBAL_CONFIG_PATH)
            ? readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')
            : null

          try {
            // Remove global config to isolate ancestor config
            if (existsSync(GLOBAL_CONFIG_PATH)) {
              rmSync(GLOBAL_CONFIG_PATH)
            }

            // Ancestor config sets defaultSandboxProvider: daytona
            const parentPath = writeConfig(parentDir, {
              defaultSandboxProvider: 'daytona',
            } as never)

            // Project config has no devServer.provider set
            writeConfig(projectDir, {
              devServer: { startCommand: 'npm start' } as never,
            })

            const result = yield* resolveConfig(
              projectDir,
              'provider-fallback-ancestor'
            )

            // devServer.provider falls back to ancestor's defaultSandboxProvider
            assert.strictEqual(result.devServer.provider.value, 'daytona')
            assert.strictEqual(result.devServer.provider.source, parentPath)
          } finally {
            if (globalConfigBackup !== null) {
              writeFileSync(GLOBAL_CONFIG_PATH, globalConfigBackup)
            }
          }
        })
    )
  })
})
