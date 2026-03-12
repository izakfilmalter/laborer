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
    prdsDir?: string | undefined
    rlphConfig?: string | undefined
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

        assert.strictEqual(result.prdsDir.source, 'default')
        assert.strictEqual(
          result.prdsDir.value,
          join(GLOBAL_CONFIG_DIR, 'test-project', 'prds')
        )
        assert.strictEqual(result.worktreeDir.source, 'default')
        assert.strictEqual(
          result.worktreeDir.value,
          join(GLOBAL_CONFIG_DIR, 'test-project')
        )
        assert.strictEqual(result.setupScripts.source, 'default')
        assert.deepStrictEqual(result.setupScripts.value, [])
        assert.strictEqual(result.rlphConfig.source, 'default')
        assert.isNull(result.rlphConfig.value)
      })
    )

    it.effect('should read config from project root', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'project-root-config')
        mkdirSync(projectDir, { recursive: true })
        const configPath = writeConfig(projectDir, {
          prdsDir: '/custom/prds',
          worktreeDir: '/custom/worktrees',
          setupScripts: ['bun install', 'cp .env.example .env'],
          rlphConfig: 'rlph-config.json',
        })

        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(result.prdsDir.value, '/custom/prds')
        assert.strictEqual(result.prdsDir.source, configPath)
        assert.strictEqual(result.worktreeDir.value, '/custom/worktrees')
        assert.strictEqual(result.worktreeDir.source, configPath)
        assert.deepStrictEqual(result.setupScripts.value, [
          'bun install',
          'cp .env.example .env',
        ])
        assert.strictEqual(result.setupScripts.source, configPath)
        assert.strictEqual(result.rlphConfig.value, 'rlph-config.json')
        assert.strictEqual(result.rlphConfig.source, configPath)
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

        assert.strictEqual(
          result.prdsDir.value,
          join(homedir(), 'parent-worktrees', 'prds')
        )
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

        // prdsDir defaults to worktreeDir/prds when only worktreeDir is set
        assert.strictEqual(result.prdsDir.value, '/child-worktrees/prds')
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

    it.effect('should expand tilde in prdsDir from config', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'tilde-expansion-prds')
        mkdirSync(projectDir, { recursive: true })
        writeConfig(projectDir, {
          prdsDir: '~/custom-prds',
        })

        const result = yield* resolveConfig(projectDir, 'test-project')

        assert.strictEqual(result.prdsDir.value, join(homedir(), 'custom-prds'))
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
          rlphConfig: 'grandparent-rlph.json',
        })
        writeConfig(parent, {
          worktreeDir: '/parent-worktrees',
        })
        const childPath = writeConfig(child, {
          setupScripts: ['child-script'],
        })

        const result = yield* resolveConfig(child, 'provenance-test')

        // Each field's provenance should trace to the config that set it
        assert.strictEqual(result.prdsDir.source, 'default')
        assert.strictEqual(result.setupScripts.source, childPath)
        assert.strictEqual(result.rlphConfig.source, gpPath)
      })
    )

    it.effect(
      'should default prdsDir to worktreeDir/prds when worktreeDir is set',
      () =>
        Effect.gen(function* () {
          const projectDir = join(testRoot, 'prdsdir-default-from-worktree')
          mkdirSync(projectDir, { recursive: true })
          writeConfig(projectDir, {
            worktreeDir: '/custom/worktrees',
          })

          const result = yield* resolveConfig(projectDir, 'test-project')

          // prdsDir should default to worktreeDir + "/prds"
          assert.strictEqual(result.prdsDir.value, '/custom/worktrees/prds')
          assert.strictEqual(result.prdsDir.source, 'default')
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
          prdsDir: '~/custom-prds',
          worktreeDir: '~/custom-worktrees',
        })

        const configPath = join(projectDir, CONFIG_FILE_NAME)
        assert.isTrue(existsSync(configPath))

        const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          prdsDir?: string
          worktreeDir?: string
        }
        assert.strictEqual(written.prdsDir, '~/custom-prds')
        assert.strictEqual(written.worktreeDir, '~/custom-worktrees')
      })
    )

    it.effect('should merge updates without clobbering unrelated fields', () =>
      Effect.gen(function* () {
        const projectDir = join(testRoot, 'write-merge')
        mkdirSync(projectDir, { recursive: true })

        writeConfig(projectDir, {
          worktreeDir: '/existing/worktrees',
          rlphConfig: 'rlph-existing.json',
        })

        yield* writeProjectConfig(projectDir, {
          setupScripts: ['bun install', 'bun test'],
        })

        const written = JSON.parse(
          readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
        ) as {
          rlphConfig?: string
          setupScripts?: string[]
          worktreeDir?: string
        }

        assert.strictEqual(written.worktreeDir, '/existing/worktrees')
        assert.strictEqual(written.rlphConfig, 'rlph-existing.json')
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
          rlphConfig: 'new-rlph.json',
        })

        const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
          customField?: string
          nested?: { hello?: string }
          rlphConfig?: string
          worktreeDir?: string
        }

        assert.strictEqual(written.customField, 'preserve-me')
        assert.strictEqual(written.nested?.hello, 'world')
        assert.strictEqual(written.worktreeDir, '/existing/worktrees')
        assert.strictEqual(written.rlphConfig, 'new-rlph.json')
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
          rlphConfig: 'updated-rlph.json',
          setupScripts: undefined,
          worktreeDir: undefined,
        })

        const written = JSON.parse(
          readFileSync(join(projectDir, CONFIG_FILE_NAME), 'utf-8')
        ) as {
          rlphConfig?: string
          setupScripts?: string[]
          worktreeDir?: string
        }

        assert.strictEqual(written.rlphConfig, 'updated-rlph.json')
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
})
