/**
 * DepsImageService — Effect Service
 *
 * Builds and caches project-level Docker images with `node_modules`
 * pre-installed. This eliminates the need to run `pnpm install` (or
 * equivalent) inside every workspace container.
 *
 * The service:
 * 1. Detects the project's lockfile (pnpm-lock.yaml, bun.lock, etc.)
 * 2. Hashes the lockfile to create a cache key
 * 3. Checks if a Docker image with that hash already exists
 * 4. If not, builds one with deps pre-installed
 * 5. Returns the image name for use by ContainerService
 *
 * Image naming: `laborer-deps/{projectSlug}:{lockfileHash}`
 *
 * The built image contains `node_modules` at the configured workdir.
 * When the workspace container bind-mounts the source code on top,
 * a Docker volume is used for `node_modules` to prevent the bind
 * mount from shadowing the pre-installed dependencies.
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lockfile type detected in the project. */
type LockfileType = 'bun' | 'npm' | 'pnpm' | 'yarn'

/** Result of lockfile detection. */
interface LockfileInfo {
  /** SHA-256 hash of the lockfile content (first 12 chars). */
  readonly hash: string
  /** The install command to run (e.g. "pnpm install --frozen-lockfile"). */
  readonly installCommand: string
  /** The full path to the lockfile. */
  readonly path: string
  /** The lockfile type. */
  readonly type: LockfileType
}

/** Result of ensuring a deps image exists. */
interface DepsImageResult {
  /** The full Docker image name (e.g. "laborer-deps/myproject:abc123def456"). */
  readonly imageName: string
  /** Whether the image was built fresh (true) or already existed (false). */
  readonly wasBuilt: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module-level log annotation for structured logging. */
const logPrefix = 'DepsImageService'

/** Lockfile names in priority order. */
const LOCKFILE_CANDIDATES: ReadonlyArray<{
  filename: string
  type: LockfileType
  installCommand: string
}> = [
  {
    filename: 'pnpm-lock.yaml',
    type: 'pnpm',
    installCommand: 'pnpm install --frozen-lockfile',
  },
  {
    filename: 'bun.lock',
    type: 'bun',
    installCommand: 'bun install --frozen-lockfile',
  },
  {
    filename: 'bun.lockb',
    type: 'bun',
    installCommand: 'bun install --frozen-lockfile',
  },
  {
    filename: 'yarn.lock',
    type: 'yarn',
    installCommand: 'yarn install --frozen-lockfile',
  },
  {
    filename: 'package-lock.json',
    type: 'npm',
    installCommand: 'npm ci',
  },
]

// Top-level regex patterns (Biome requires these outside functions)
const PACKAGES_YAML_PATTERN = /packages:\s*\n((?:\s+-\s+.+\n?)+)/
const YAML_LINE_PREFIX_PATTERN = /^\s+-\s+['"]?/
const YAML_LINE_SUFFIX_PATTERN = /['"]?\s*$/
const GLOB_STAR_SUFFIX_PATTERN = /\/\*$/

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Detect the lockfile in a project directory.
 * Returns the first matching lockfile info, or null if none found.
 */
const detectLockfile = (projectRoot: string): LockfileInfo | null => {
  for (const candidate of LOCKFILE_CANDIDATES) {
    const lockfilePath = join(projectRoot, candidate.filename)
    if (existsSync(lockfilePath)) {
      const content = readFileSync(lockfilePath)
      const hash = createHash('sha256')
        .update(content)
        .digest('hex')
        .slice(0, 12)
      return {
        path: lockfilePath,
        installCommand: candidate.installCommand,
        hash,
        type: candidate.type,
      }
    }
  }
  return null
}

/**
 * Sanitize a project name for use in a Docker image tag.
 * Lowercases, replaces non-alphanumeric chars with hyphens, collapses
 * consecutive hyphens, trims leading/trailing hyphens.
 */
const sanitizeProjectSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Build the Docker image name for a project's deps cache.
 */
const buildImageName = (projectSlug: string, lockfileHash: string): string =>
  `laborer-deps/${projectSlug}:${lockfileHash}`

// ---------------------------------------------------------------------------
// Workspace package.json discovery
// ---------------------------------------------------------------------------

/**
 * Parse workspace patterns from pnpm-workspace.yaml content.
 */
const parsePnpmWorkspacePatterns = (content: string): string[] => {
  const packagesMatch = content.match(PACKAGES_YAML_PATTERN)
  if (!packagesMatch?.[1]) {
    return []
  }
  return packagesMatch[1]
    .split('\n')
    .map((line) =>
      line
        .replace(YAML_LINE_PREFIX_PATTERN, '')
        .replace(YAML_LINE_SUFFIX_PATTERN, '')
    )
    .filter((line) => line.length > 0)
}

/**
 * Get workspace patterns from a project's package.json and/or pnpm-workspace.yaml.
 */
const getWorkspacePatterns = (projectRoot: string): string[] => {
  const packageJsonPath = join(projectRoot, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return []
  }

  // Try package.json workspaces field first
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      workspaces?: string[] | { packages?: string[] }
    }

    if (Array.isArray(packageJson.workspaces)) {
      return packageJson.workspaces
    }
    if (Array.isArray(packageJson.workspaces?.packages)) {
      return packageJson.workspaces.packages
    }
  } catch {
    // Ignore parse errors
  }

  // Try pnpm-workspace.yaml
  const pnpmWorkspacePath = join(projectRoot, 'pnpm-workspace.yaml')
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const content = readFileSync(pnpmWorkspacePath, 'utf-8')
      return parsePnpmWorkspacePatterns(content)
    } catch {
      // Ignore parse errors
    }
  }

  return []
}

/**
 * Copy a single package.json from a workspace directory into the build context.
 */
const copyWorkspacePackageJson = (
  sourcePath: string,
  buildContextDir: string,
  relativeDir: string
): void => {
  const wsPackageJson = join(sourcePath, 'package.json')
  if (!existsSync(wsPackageJson)) {
    return
  }
  const targetDir = join(buildContextDir, relativeDir)
  mkdirSync(targetDir, { recursive: true })
  const content = readFileSync(wsPackageJson)
  writeFileSync(join(targetDir, 'package.json'), content)
}

/**
 * Expand a glob-style workspace pattern and copy all matching package.json files.
 */
const expandAndCopyPattern = (
  projectRoot: string,
  buildContextDir: string,
  pattern: string
): void => {
  const baseDir = pattern.replace(GLOB_STAR_SUFFIX_PATTERN, '')
  const basePath = join(projectRoot, baseDir)

  if (!existsSync(basePath)) {
    return
  }

  if (pattern.endsWith('/*')) {
    // Enumerate subdirectories
    try {
      const entries = readdirSync(basePath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          copyWorkspacePackageJson(
            join(basePath, entry.name),
            buildContextDir,
            join(baseDir, entry.name)
          )
        }
      }
    } catch {
      // Skip directories we can't read
    }
  } else {
    // Exact directory pattern
    copyWorkspacePackageJson(basePath, buildContextDir, baseDir)
  }
}

/**
 * Find and copy all workspace package.json files into the build context,
 * preserving their relative directory structure.
 */
const copyWorkspacePackageJsons = (
  projectRoot: string,
  buildContextDir: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const workspacePatterns = getWorkspacePatterns(projectRoot)

    if (workspacePatterns.length === 0) {
      return
    }

    for (const pattern of workspacePatterns) {
      expandAndCopyPattern(projectRoot, buildContextDir, pattern)
    }

    yield* Effect.logDebug(
      `Copied workspace package.json files for patterns: ${workspacePatterns.join(', ')}`
    ).pipe(Effect.annotateLogs('module', logPrefix))
  })

/**
 * Recursively copy a directory tree from src to dest.
 * Creates dest and any nested subdirectories as needed.
 */
const copyDirRecursive = (src: string, dest: string): void => {
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      writeFileSync(destPath, readFileSync(srcPath))
    }
  }
}

// ---------------------------------------------------------------------------
// Build context and Docker build
// ---------------------------------------------------------------------------

/**
 * Prepare the build context directory with lockfile, package.json, and
 * workspace package.json files.
 */
const prepareBuildContext = (
  projectRoot: string,
  buildContextDir: string,
  lockfile: LockfileInfo
): Effect.Effect<void> =>
  Effect.gen(function* () {
    mkdirSync(buildContextDir, { recursive: true })

    // Copy the lockfile
    const lockfileContent = readFileSync(lockfile.path)
    const lockfileFilename = lockfile.path.split('/').pop() ?? 'lockfile'
    writeFileSync(join(buildContextDir, lockfileFilename), lockfileContent)

    // Copy package.json
    const packageJsonPath = join(projectRoot, 'package.json')
    if (existsSync(packageJsonPath)) {
      writeFileSync(
        join(buildContextDir, 'package.json'),
        readFileSync(packageJsonPath)
      )
    }

    // For pnpm workspaces, copy pnpm-workspace.yaml
    if (lockfile.type === 'pnpm') {
      const workspaceYamlPath = join(projectRoot, 'pnpm-workspace.yaml')
      if (existsSync(workspaceYamlPath)) {
        writeFileSync(
          join(buildContextDir, 'pnpm-workspace.yaml'),
          readFileSync(workspaceYamlPath)
        )
      }
    }

    // Copy workspace package.json files for monorepos
    yield* copyWorkspacePackageJsons(projectRoot, buildContextDir)

    // Copy .npmrc if it exists (needed for registry config)
    const npmrcPath = join(projectRoot, '.npmrc')
    if (existsSync(npmrcPath)) {
      writeFileSync(join(buildContextDir, '.npmrc'), readFileSync(npmrcPath))
    }

    // Copy patches/ directory if it exists (needed for pnpm.patchedDependencies)
    const patchesDir = join(projectRoot, 'patches')
    if (existsSync(patchesDir)) {
      copyDirRecursive(patchesDir, join(buildContextDir, 'patches'))
    }

    // Copy .pnpmfile.cjs if it exists (pnpm hook file for custom resolution)
    const pnpmfilePath = join(projectRoot, '.pnpmfile.cjs')
    if (existsSync(pnpmfilePath)) {
      writeFileSync(
        join(buildContextDir, '.pnpmfile.cjs'),
        readFileSync(pnpmfilePath)
      )
    }
  })

/**
 * Get the persistent cache volume name for a package manager type.
 * Uses a named Docker volume so the package manager's download cache
 * persists across image builds, avoiding redundant downloads.
 */
const getCacheVolumeName = (lockfileType: LockfileType): string =>
  `laborer-pkg-cache-${lockfileType}`

/**
 * Get the container-internal cache path for a package manager type.
 */
const getContainerCachePath = (lockfileType: LockfileType): string => {
  switch (lockfileType) {
    case 'pnpm':
      return '/root/.local/share/pnpm/store'
    case 'bun':
      return '/root/.bun/install/cache'
    case 'yarn':
      return '/usr/local/share/.cache/yarn'
    case 'npm':
      return '/root/.npm'
    default:
      return '/tmp/pkg-cache'
  }
}

/**
 * Detect the host machine's package manager store/cache path.
 *
 * Runs the appropriate CLI command (`pnpm store path`, `npm config get cache`,
 * etc.) to find where the host stores downloaded packages. When bind-mounted
 * into the build container, this lets `pnpm install` (and others) reuse the
 * host's already-populated cache — avoiding re-downloading thousands of
 * packages from the network.
 *
 * Returns the **parent** directory (e.g. `/Users/x/Library/pnpm/store` rather
 * than `.../store/v10`) so that any version subdirectory is included.
 *
 * Returns `null` when the CLI isn't installed or the command fails.
 */
const getHostStorePath = (lockfileType: LockfileType): string | null => {
  try {
    switch (lockfileType) {
      case 'pnpm': {
        // `pnpm store path` returns e.g. /Users/x/Library/pnpm/store/v10
        // Mount the parent so all version subdirectories are shared.
        const storePath = execSync('pnpm store path', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (storePath.length === 0) {
          return null
        }
        // Go up one level from the versioned path (v10, v3, etc.)
        const parent = join(storePath, '..')
        return existsSync(parent) ? parent : null
      }
      case 'npm': {
        const cachePath = execSync('npm config get cache', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        return cachePath.length > 0 && existsSync(cachePath) ? cachePath : null
      }
      case 'yarn': {
        const cachePath = execSync('yarn cache dir', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        return cachePath.length > 0 && existsSync(cachePath) ? cachePath : null
      }
      case 'bun': {
        // Bun doesn't have a direct "cache path" command, but the global
        // cache lives at ~/.bun/install/cache by default.
        const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
        const cachePath = join(home, '.bun', 'install', 'cache')
        return existsSync(cachePath) ? cachePath : null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Build the list of setup commands to run inside the container.
 * Filters out install-like commands and "exec bash" since we handle
 * the install step explicitly.
 */
const getSetupCommands = (
  setupScripts: readonly string[] | undefined
): readonly string[] =>
  (setupScripts ?? []).filter((script) => {
    const lower = script.toLowerCase()
    return (
      !(lower.includes('install') || lower.includes('npm ci')) &&
      lower !== 'exec bash'
    )
  })

/**
 * Seed node_modules from a deps image into the host worktree.
 *
 * In a pnpm monorepo, `node_modules` directories exist at the root AND
 * inside every workspace package (containing symlinks back to the root
 * `.pnpm` store). A single Docker volume at `/app/node_modules` only
 * covers the root — the workspace-level `node_modules` get wiped when
 * the worktree is bind-mounted at `/app`.
 *
 * This function uses `docker cp` to copy ALL `node_modules` directories
 * from the deps image directly into the host worktree. Since the worktree
 * is then bind-mounted into the workspace container, the container sees
 * the full dependency tree without any extra volume mounts.
 */
const seedNodeModules = (
  imageName: string,
  worktreePath: string,
  workdir: string
): Effect.Effect<void, RpcError> =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      `Seeding node_modules from ${imageName} into ${worktreePath}`
    ).pipe(Effect.annotateLogs('module', logPrefix))

    // Use a tar-pipe to copy ALL node_modules directories from the image
    // into the host worktree in a single operation. This is necessary
    // because `docker cp` fails on symlinks that point outside the copied
    // directory (pnpm workspace packages have symlinks like
    // `../../../../node_modules/.pnpm/...`). By tarring all node_modules
    // together from the container, the symlinks' relative targets resolve
    // correctly since the root `.pnpm` store is included in the same tar.
    const tempName = `laborer-deps-seed-${Date.now()}`

    // Start a container so we can docker exec the tar command in it.
    const createResult = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            'docker',
            'run',
            '-d',
            '--name',
            tempName,
            imageName,
            'sleep',
            'infinity',
          ],
          { stdout: 'pipe', stderr: 'pipe' }
        )
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stderr }
      },
      catch: (error) =>
        new RpcError({
          message: `Failed to create seed container: ${String(error)}`,
          code: 'DEPS_SEED_FAILED',
        }),
    })

    if (createResult.exitCode !== 0) {
      return yield* new RpcError({
        message: `Failed to create seed container (exit ${createResult.exitCode}): ${createResult.stderr.trim().slice(0, 500)}`,
        code: 'DEPS_SEED_FAILED',
      })
    }

    // Clean up the temp container when done
    const cleanupContainer = Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(['docker', 'rm', '-f', tempName], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await proc.exited
      },
      catch: () => undefined,
    }).pipe(Effect.ignore)

    yield* Effect.gen(function* () {
      // Tar all node_modules directories from the container and pipe to
      // a host-side tar extract. The find command discovers all node_modules
      // at any depth (root + workspace packages), and the tar preserves
      // symlinks correctly because all targets are included in the archive.
      const tarResult = yield* Effect.tryPromise({
        try: async () => {
          // Container-side: find all node_modules, tar them relative to workdir
          const tarProc = Bun.spawn(
            [
              'docker',
              'exec',
              tempName,
              'sh',
              '-c',
              `cd ${workdir} && find . -name node_modules -maxdepth 4 -not -path '*/node_modules/*' | tar cf - -T -`,
            ],
            { stdout: 'pipe', stderr: 'pipe' }
          )

          // Host-side: extract the tar into the worktree
          const extractProc = Bun.spawn(
            ['tar', 'xf', '-', '-C', worktreePath],
            {
              stdin: tarProc.stdout,
              stdout: 'pipe',
              stderr: 'pipe',
            }
          )

          const [tarExit, extractExit] = await Promise.all([
            tarProc.exited,
            extractProc.exited,
          ])
          const tarStderr = await new Response(tarProc.stderr).text()
          const extractStderr = await new Response(extractProc.stderr).text()
          return { tarExit, extractExit, tarStderr, extractStderr }
        },
        catch: (error) =>
          new RpcError({
            message: `Failed to seed node_modules via tar pipe: ${String(error)}`,
            code: 'DEPS_SEED_FAILED',
          }),
      })

      if (tarResult.tarExit !== 0 || tarResult.extractExit !== 0) {
        return yield* new RpcError({
          message: `node_modules tar-pipe failed (tar exit=${tarResult.tarExit}, extract exit=${tarResult.extractExit}): ${tarResult.tarStderr.slice(0, 300)} | ${tarResult.extractStderr.slice(0, 300)}`,
          code: 'DEPS_SEED_FAILED',
        })
      }

      yield* Effect.logInfo(`node_modules seeded into ${worktreePath}`).pipe(
        Effect.annotateLogs('module', logPrefix)
      )
    }).pipe(Effect.ensuring(cleanupContainer))
  })

/**
 * Run a command inside a Docker container via `docker exec`, streaming
 * stdout+stderr for progress. Returns the combined output and exit code.
 */
const dockerExec = (
  containerId: string,
  command: string
): Effect.Effect<{ exitCode: number; output: string }, RpcError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        ['docker', 'exec', containerId, 'sh', '-c', command],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { exitCode, output: stdout + stderr }
    },
    catch: (error) =>
      new RpcError({
        message: `Failed to exec in container: ${String(error)}`,
        code: 'DEPS_IMAGE_BUILD_FAILED',
      }),
  })

/**
 * Build a deps image using docker run + docker commit.
 *
 * Instead of `docker build` (which requires BuildKit for cache mounts),
 * this approach:
 * 1. Creates a container from the base image with a persistent cache volume
 * 2. Copies the build context (lockfile, package.json, patches) into it
 * 3. Runs setup scripts + install command via docker exec
 * 4. Commits the container as the deps image
 * 5. Removes the temporary container
 *
 * The persistent cache volume (`laborer-pkg-cache-{type}`) stores the
 * package manager's download cache across builds, so subsequent builds
 * with different lockfiles still benefit from cached packages.
 */
const buildDepsImage = (
  buildContextDir: string,
  imageName: string,
  baseImage: string,
  workdir: string,
  installCommand: string,
  lockfileType: LockfileType,
  setupScripts: readonly string[] | undefined,
  onProgress?: ((step: string) => void) | undefined
): Effect.Effect<void, RpcError> =>
  Effect.gen(function* () {
    const containerCachePath = getContainerCachePath(lockfileType)
    const commands = getSetupCommands(setupScripts)
    const totalSteps = commands.length + 1 // setup scripts + install
    const tempName = `laborer-deps-build-${Date.now()}`

    // Try to bind-mount the host's package manager store into the build
    // container so `pnpm install` (etc.) can reuse already-downloaded
    // packages instead of fetching them from the network.
    // Falls back to a Docker named volume when the host path can't be
    // detected (e.g. the PM isn't installed on the host).
    const hostStorePath = getHostStorePath(lockfileType)
    const cacheMount = hostStorePath
      ? `${hostStorePath}:${containerCachePath}`
      : `${getCacheVolumeName(lockfileType)}:${containerCachePath}`
    const cacheSource = hostStorePath
      ? `host:${hostStorePath}`
      : `volume:${getCacheVolumeName(lockfileType)}`

    yield* Effect.logInfo(
      `Building deps image via docker run + commit: image=${imageName}, baseImage=${baseImage}, cache=${cacheSource}, steps=${totalSteps}`
    ).pipe(Effect.annotateLogs('module', logPrefix))

    // 1. Create and start a container with package cache mounted
    const createResult = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            'docker',
            'run',
            '-d',
            '--name',
            tempName,
            '-v',
            cacheMount,
            '-w',
            workdir,
            baseImage,
            'sleep',
            'infinity',
          ],
          { stdout: 'pipe', stderr: 'pipe' }
        )
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        const stdout = await new Response(proc.stdout).text()
        return { exitCode, containerId: stdout.trim(), stderr }
      },
      catch: (error) =>
        new RpcError({
          message: `Failed to create build container: ${String(error)}`,
          code: 'DEPS_IMAGE_BUILD_FAILED',
        }),
    })

    if (createResult.exitCode !== 0) {
      return yield* new RpcError({
        message: `Failed to create build container (exit ${createResult.exitCode}): ${createResult.stderr.trim().slice(0, 500)}`,
        code: 'DEPS_IMAGE_BUILD_FAILED',
      })
    }

    const containerId = createResult.containerId

    // Clean up the temp container (best-effort, fire-and-forget)
    const cleanupContainer = Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(['docker', 'rm', '-f', tempName], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await proc.exited
      },
      catch: () => undefined,
    }).pipe(Effect.ignore)

    // Build steps wrapped in Effect.ensuring so the container is always cleaned up
    yield* Effect.gen(function* () {
      // 2. Copy build context into the container
      onProgress?.('Copying project files...')
      const copyResult = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(
            [
              'docker',
              'cp',
              `${buildContextDir}/.`,
              `${containerId}:${workdir}`,
            ],
            { stdout: 'pipe', stderr: 'pipe' }
          )
          const exitCode = await proc.exited
          const stderr = await new Response(proc.stderr).text()
          return { exitCode, stderr }
        },
        catch: (error) =>
          new RpcError({
            message: `Failed to copy build context: ${String(error)}`,
            code: 'DEPS_IMAGE_BUILD_FAILED',
          }),
      })

      if (copyResult.exitCode !== 0) {
        return yield* new RpcError({
          message: `docker cp failed (exit ${copyResult.exitCode}): ${copyResult.stderr.trim().slice(0, 500)}`,
          code: 'DEPS_IMAGE_BUILD_FAILED',
        })
      }

      // 3. Run setup scripts
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]
        if (cmd === undefined) {
          continue
        }
        onProgress?.(`Step ${i + 1}/${totalSteps}: ${cmd}`)

        yield* Effect.logInfo(
          `Running setup script ${i + 1}/${totalSteps}: ${cmd}`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        const result = yield* dockerExec(containerId, cmd)
        if (result.exitCode !== 0) {
          return yield* new RpcError({
            message: `Setup script failed (exit ${result.exitCode}): ${cmd}\n${result.output.slice(0, 500)}`,
            code: 'DEPS_IMAGE_BUILD_FAILED',
          })
        }
      }

      // 4. Run install command
      onProgress?.(`Step ${totalSteps}/${totalSteps}: ${installCommand}`)

      yield* Effect.logInfo(
        `Running install command ${totalSteps}/${totalSteps}: ${installCommand}`
      ).pipe(Effect.annotateLogs('module', logPrefix))

      const installResult = yield* dockerExec(containerId, installCommand)
      if (installResult.exitCode !== 0) {
        return yield* new RpcError({
          message: `Install command failed (exit ${installResult.exitCode}): ${installCommand}\n${installResult.output.slice(0, 500)}`,
          code: 'DEPS_IMAGE_BUILD_FAILED',
        })
      }

      // 5. Commit the container as the deps image
      onProgress?.('Saving image...')
      const commitResult = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(['docker', 'commit', containerId, imageName], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const exitCode = await proc.exited
          const stderr = await new Response(proc.stderr).text()
          return { exitCode, stderr }
        },
        catch: (error) =>
          new RpcError({
            message: `Failed to commit container: ${String(error)}`,
            code: 'DEPS_IMAGE_BUILD_FAILED',
          }),
      })

      if (commitResult.exitCode !== 0) {
        return yield* new RpcError({
          message: `docker commit failed (exit ${commitResult.exitCode}): ${commitResult.stderr.trim().slice(0, 500)}`,
          code: 'DEPS_IMAGE_BUILD_FAILED',
        })
      }

      yield* Effect.logInfo(
        `Deps image ${imageName} built successfully via docker commit`
      ).pipe(Effect.annotateLogs('module', logPrefix))
    }).pipe(Effect.ensuring(cleanupContainer))
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class DepsImageService extends Context.Tag('@laborer/DepsImageService')<
  DepsImageService,
  {
    /**
     * Ensure a deps image exists for the given project.
     *
     * If a cached image matching the lockfile hash exists, returns it.
     * Otherwise, builds a new image with dependencies pre-installed.
     *
     * Returns null if the project has no detectable lockfile (in which
     * case the container should use the base image directly).
     *
     * @param projectRoot - Absolute path to the project's repo root
     * @param projectName - Human-readable project name
     * @param baseImage - Base Docker image (e.g. "node:lts")
     * @param workdir - Container workdir (e.g. "/app")
     * @param installCommand - Override install command (optional)
     * @param setupScripts - Additional scripts to run during build (optional)
     * @param onProgress - Callback for build progress updates (optional)
     */
    readonly ensureDepsImage: (params: {
      readonly projectRoot: string
      readonly projectName: string
      readonly baseImage: string
      readonly workdir: string
      readonly worktreePath: string
      readonly installCommand?: string | undefined
      readonly setupScripts?: readonly string[] | undefined
      readonly onProgress?: ((step: string) => void) | undefined
    }) => Effect.Effect<DepsImageResult | null, RpcError>
  }
>() {
  static readonly layer = Layer.succeed(
    DepsImageService,
    DepsImageService.of({
      ensureDepsImage: Effect.fn('DepsImageService.ensureDepsImage')(
        function* (params) {
          const {
            projectRoot,
            projectName,
            baseImage,
            workdir,
            worktreePath,
            installCommand: installCommandOverride,
            setupScripts,
            onProgress,
          } = params

          // 1. Detect lockfile
          const lockfile = detectLockfile(projectRoot)
          if (lockfile === null) {
            yield* Effect.logDebug(
              `No lockfile found in ${projectRoot}, skipping deps image build`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return null
          }

          const projectSlug = sanitizeProjectSlug(projectName)
          // Include the base image in the cache key so changing the
          // default image (e.g. oven/bun:latest → node:lts) invalidates
          // the cached deps image.
          const cacheHash = createHash('sha256')
            .update(lockfile.hash)
            .update(baseImage)
            .digest('hex')
            .slice(0, 12)
          const imageName = buildImageName(projectSlug, cacheHash)
          const installCommand =
            installCommandOverride ?? lockfile.installCommand

          yield* Effect.logInfo(
            `Lockfile detected: ${lockfile.type} (hash: ${lockfile.hash}), checking for cached image ${imageName}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 2. Check if cached image exists
          const inspectResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(
                ['docker', 'image', 'inspect', imageName],
                { stdout: 'pipe', stderr: 'pipe' }
              )
              const exitCode = await proc.exited
              return { exitCode }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to inspect Docker image: ${String(error)}`,
                code: 'DEPS_IMAGE_INSPECT_FAILED',
              }),
          })

          if (inspectResult.exitCode === 0) {
            yield* Effect.logInfo(
              `Cached deps image ${imageName} found, reusing`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            // Seed node_modules from the image into the worktree
            onProgress?.('Seeding node_modules...')
            yield* seedNodeModules(imageName, worktreePath, workdir)

            return {
              imageName,
              wasBuilt: false,
            }
          }

          // 3. Build the deps image
          yield* Effect.logInfo(
            `No cached image found, building ${imageName} with ${installCommand}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const buildContextDir = join(
            tmpdir(),
            `laborer-deps-build-${projectSlug}-${Date.now()}`
          )

          try {
            yield* prepareBuildContext(projectRoot, buildContextDir, lockfile)

            yield* buildDepsImage(
              buildContextDir,
              imageName,
              baseImage,
              workdir,
              installCommand,
              lockfile.type,
              setupScripts,
              onProgress
            )

            // Seed all node_modules from the freshly built image into the worktree
            onProgress?.('Seeding node_modules...')
            yield* seedNodeModules(imageName, worktreePath, workdir)

            return {
              imageName,
              wasBuilt: true,
            }
          } finally {
            // Clean up build context
            try {
              rmSync(buildContextDir, { recursive: true, force: true })
            } catch {
              // Best-effort cleanup
            }
          }
        }
      ),
    })
  )
}

export { DepsImageService, detectLockfile, sanitizeProjectSlug }
export type { DepsImageResult, LockfileInfo, LockfileType }
