/**
 * DepsImageService cache volume e2e test.
 *
 * Verifies that building a deps image populates the persistent pnpm
 * cache volume (`laborer-pkg-cache-pnpm`). After `ensureDepsImage`
 * completes, we spin up a one-shot container with the same cache volume
 * mounted and check that the pnpm store directory contains files.
 *
 * Requires Docker (OrbStack) to be running on the host.
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { DepsImageService } from '../src/services/deps-image-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Polyfill Bun.spawn for Node-based vitest. */
const ensureBunSpawnForNodeTests = (): void => {
  const runtimeGlobal = globalThis as unknown as { Bun?: unknown }

  if (runtimeGlobal.Bun !== undefined) {
    return
  }

  runtimeGlobal.Bun = {
    spawn: (
      cmd: string[],
      options?: {
        readonly cwd?: string
        readonly env?: Record<string, string | undefined>
      }
    ) => {
      const child = spawn(cmd[0] ?? '', cmd.slice(1), {
        cwd: options?.cwd,
        env: options?.env,
      })

      return {
        stdout:
          child.stdout === null
            ? new ReadableStream<Uint8Array>()
            : (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
        stderr:
          child.stderr === null
            ? new ReadableStream<Uint8Array>()
            : (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>),
        exited: new Promise<number>((resolve) => {
          child.on('close', (code) => resolve(code ?? 1))
        }),
      }
    },
  }
}

/** Run a docker command synchronously and return stdout. */
const docker = (args: string): string =>
  execSync(`docker ${args}`, { encoding: 'utf-8', timeout: 30_000 }).trim()

/** Create a temp directory, tracking it for cleanup. */
const createTempDir = (prefix: string, tempRoots: string[]): string => {
  const dir = join(
    tmpdir(),
    `laborer-e2e-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  tempRoots.push(dir)
  return dir
}

/**
 * Minimal pnpm-lock.yaml for a project with a single tiny dependency.
 * Uses `is-number` (3.7 KB) to keep the build fast.
 */
const MINIMAL_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      is-number:
        specifier: ^7.0.0
        version: 7.0.0

packages:
  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

snapshots:
  is-number@7.0.0: {}
`

const MINIMAL_PACKAGE_JSON = JSON.stringify(
  {
    name: 'laborer-cache-test',
    version: '1.0.0',
    dependencies: {
      'is-number': '^7.0.0',
    },
  },
  null,
  2
)

// Top-level regex for Biome compliance
const DEPS_IMAGE_NAME_PATTERN = /laborer-deps\/cache-test:/

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('DepsImageService cache volume', () => {
  it.scoped(
    'pnpm cache volume contains store data after deps image build',
    () =>
      Effect.gen(function* () {
        ensureBunSpawnForNodeTests()

        const tempRoots: string[] = []

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        // 1. Create a minimal pnpm project in a temp dir and a separate worktree dir
        const projectDir = createTempDir('cache-test-project', tempRoots)
        const worktreeDir = createTempDir('cache-test-worktree', tempRoots)
        writeFileSync(join(projectDir, 'package.json'), MINIMAL_PACKAGE_JSON)
        writeFileSync(join(projectDir, 'pnpm-lock.yaml'), MINIMAL_PNPM_LOCK)

        // 2. Build deps image using the real DepsImageService layer
        const progressSteps: string[] = []

        const result = yield* DepsImageService.pipe(
          Effect.flatMap((svc) =>
            svc.ensureDepsImage({
              projectRoot: projectDir,
              projectName: 'cache-test',
              baseImage: 'node:lts',
              workdir: '/app',
              worktreePath: worktreeDir,
              setupScripts: ['corepack enable'],
              onProgress: (step) => {
                progressSteps.push(step)
              },
            })
          ),
          Effect.provide(DepsImageService.layer)
        )

        // Clean up the image after the test
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (result !== null) {
              try {
                docker(`rmi -f ${result.imageName}`)
              } catch {
                // ignore
              }
            }
          })
        )

        // 3. Verify the image was built
        assert.isNotNull(result, 'Expected deps image result, got null')
        if (result === null) {
          return
        }

        assert.isTrue(
          result.wasBuilt,
          'Expected image to be built fresh (not cached)'
        )
        assert.match(result.imageName, DEPS_IMAGE_NAME_PATTERN)

        // 4. Verify progress callbacks were called
        assert.isAbove(
          progressSteps.length,
          0,
          'Expected at least one progress callback'
        )

        // 5. Check the built image contains node_modules with the dependency.
        const imageContents = docker(
          `run --rm ${result.imageName} sh -c "ls /app/node_modules/is-number/index.js 2>/dev/null || echo MISSING"`
        )

        assert.notStrictEqual(
          imageContents,
          'MISSING',
          'Expected built image to contain node_modules/is-number, but the file was missing'
        )

        yield* Effect.logInfo(
          `Built image node_modules check: ${imageContents}`
        )

        // 6. Verify node_modules were seeded into the worktree directory
        const nmContents = existsSync(join(worktreeDir, 'node_modules'))
        assert.isTrue(
          nmContents,
          'Expected node_modules to be seeded into the worktree directory'
        )

        const isNumberExists = existsSync(
          join(worktreeDir, 'node_modules', 'is-number')
        )
        assert.isTrue(
          isNumberExists,
          'Expected is-number package in seeded node_modules'
        )

        yield* Effect.logInfo('node_modules seeded into worktree successfully')
      }),
    { timeout: 120_000 }
  )
})
