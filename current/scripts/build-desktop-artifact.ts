#!/usr/bin/env tsx

/**
 * Build script for packaging the Laborer Electron application.
 *
 * Creates a staging directory with all built artifacts, generates a production
 * package.json with resolved dependencies, installs production deps, and runs
 * electron-builder to produce a .dmg (macOS arm64).
 *
 * Usage:
 *   bun run dist:desktop:dmg                          # Full build + package
 *   bun run dist:desktop:dmg --skip-build             # Package only (reuse existing build)
 *   bun run dist:desktop:dmg --keep-stage             # Keep staging dir for debugging
 *   bun run dist:desktop:dmg --verbose                # Stream subprocess stdout
 *   bun run dist:desktop:dmg --build-version 1.2.3    # Set artifact version
 *   bun run dist:desktop:dmg --signed                 # Enable code signing
 *
 * Environment variables (override CLI flags):
 *   LABORER_DESKTOP_SKIP_BUILD=true
 *   LABORER_DESKTOP_KEEP_STAGE=true
 *   LABORER_DESKTOP_VERBOSE=true
 *   LABORER_DESKTOP_OUTPUT_DIR=./release
 *   LABORER_DESKTOP_VERSION=1.2.3
 *   LABORER_DESKTOP_SIGNED=true
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import desktopPkg from '../apps/desktop/package.json' with { type: 'json' }
import { resolveDesktopAppName } from '../apps/desktop/src/app-name.js'
import rootPkg from '../package.json' with { type: 'json' }
import fileWatcherPkg from '../packages/file-watcher/package.json' with {
  type: 'json',
}
import serverPkg from '../packages/server/package.json' with { type: 'json' }
import terminalPkg from '../packages/terminal/package.json' with {
  type: 'json',
}
import { resolveCatalogDependencies } from './lib/resolve-catalog.js'

// ---------------------------------------------------------------------------
// Top-level regex patterns (avoids re-creation in loops)
// ---------------------------------------------------------------------------

/** Matches src/href attributes in HTML. */
const HTML_REF_PATTERN = /\b(?:src|href)=["']([^"']+)["']/g

/** Matches leading slashes. */
const LEADING_SLASHES_PATTERN = /^\/+/

/** Matches a short git commit hash. */
const GIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i

/** Matches nightly release versions. */
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: cliFlags } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    'keep-stage': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    signed: { type: 'boolean', default: false },
    'output-dir': { type: 'string' },
    'build-version': { type: 'string' },
    arch: { type: 'string', default: 'arm64' },
  },
  strict: true,
  allowPositionals: true,
})

const SKIP_BUILD =
  cliFlags['skip-build'] || process.env.LABORER_DESKTOP_SKIP_BUILD === 'true'
const KEEP_STAGE =
  cliFlags['keep-stage'] || process.env.LABORER_DESKTOP_KEEP_STAGE === 'true'
const VERBOSE =
  cliFlags.verbose || process.env.LABORER_DESKTOP_VERBOSE === 'true'
const SIGNED = cliFlags.signed || process.env.LABORER_DESKTOP_SIGNED === 'true'
const ARCH = cliFlags.arch ?? 'arm64'
const BUILD_VERSION =
  cliFlags['build-version'] ??
  process.env.LABORER_DESKTOP_VERSION ??
  desktopPkg.version

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const OUTPUT_DIR = resolve(
  REPO_ROOT,
  cliFlags['output-dir'] ?? process.env.LABORER_DESKTOP_OUTPUT_DIR ?? 'release'
)

const DIST_DIRS = {
  desktopDist: join(REPO_ROOT, 'apps/desktop/dist-electron'),
  desktopResources: join(REPO_ROOT, 'apps/desktop/resources'),
  webDist: join(REPO_ROOT, 'apps/web/dist'),
  serverDist: join(REPO_ROOT, 'packages/server/dist'),
  terminalDist: join(REPO_ROOT, 'packages/terminal/dist'),
  fileWatcherDist: join(REPO_ROOT, 'packages/file-watcher/dist'),
}

const REQUIRED_EFFECT_RUNTIME_PACKAGES = [
  'effect',
  '@effect/platform-node',
  // The @effect/platform-node barrel eagerly loads NodeRedis, which imports
  // its required `ioredis` peer dependency at module load. If ioredis is
  // missing from the asar, every sidecar crash-loops at import time and the
  // renderer gets ERR_CONNECTION_REFUSED on the backend port.
  'ioredis',
] as const
const OPTIONAL_EFFECT_RUNTIME_PACKAGES = [
  '@effect/platform-node-shared',
] as const

const REQUIRED_ASAR_FILES = [
  'packages/server/dist/main.mjs',
  // The bundled server resolves task-db SQL migrations relative to the
  // bundle (`new URL('./migrations/*.sql', import.meta.url)`). If these are
  // missing from the asar, the server sidecar crash-loops at import time and
  // the renderer gets ERR_CONNECTION_REFUSED on the backend port.
  'packages/server/dist/migrations/0000_shared_task_db.sql',
  'packages/server/dist/migrations/0001_execution_lifecycle_statuses.sql',
  'packages/server/dist/migrations/0002_task_description_agent_source.sql',
  'packages/server/dist/migrations/0003_worktree_task_source.sql',
  'packages/server/dist/migrations/0004_task_worktree_pr_columns.sql',
  'packages/server/dist/migrations/0005_projects.sql',
  'packages/server/dist/migrations/0006_app_settings_and_ledger.sql',
] as const

const MCP_RESOURCE_DIRECTORY = 'laborer-mcp'
const MCP_SCRIPT_NAME = 'laborer-mcp.mjs'
const MCP_RUNTIME_NAME = 'task-mcp-runtime.mjs'
const REQUIRED_MCP_MIGRATIONS = [
  '0000_shared_task_db.sql',
  '0001_execution_lifecycle_statuses.sql',
  '0002_task_description_agent_source.sql',
  '0003_worktree_task_source.sql',
  '0004_task_worktree_pr_columns.sql',
  '0005_projects.sql',
  '0006_app_settings_and_ledger.sql',
] as const
const NODE_SHEBANG = '#!/usr/bin/env node\n'

const REMOVED_PERSISTENCE_PAYLOAD_PATTERN =
  /(?:^|[/\\])(?:@livestore|sql\.js|wa-sqlite)(?:[/\\]|$)/i
const PACKAGED_SMOKE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.info(`[desktop-artifact] ${message}`)
}

function run(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  const stdio = VERBOSE ? 'inherit' : 'ignore'
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? REPO_ROOT,
    env: options?.env ?? process.env,
    stdio: ['ignore', stdio, 'inherit'],
  })

  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${String(result.status)}): ${command} ${args.join(' ')}`
    )
  }
}

function findRemovedPersistencePayloads(root: string): readonly string[] {
  if (!existsSync(root)) {
    return []
  }

  const matches: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      continue
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(root, path)
      if (REMOVED_PERSISTENCE_PAYLOAD_PATTERN.test(relativePath)) {
        matches.push(relativePath)
        continue
      }
      if (entry.isDirectory()) {
        pending.push(path)
      }
    }
  }
  return matches.sort()
}

function validateNoRemovedPersistencePayloads(
  root: string,
  label: string
): void {
  const matches = findRemovedPersistencePayloads(root)
  if (matches.length === 0) {
    log(`Validated ${label}: no LiveStore/sql.js/wa-sqlite payloads`)
    return
  }

  throw new Error(
    `${label} contains removed persistence payloads: ${matches.slice(0, 20).join(', ')}`
  )
}

function resolveEffectRuntimeAsarMarkers(
  productionNodeModules: string
): readonly string[] {
  const markerFor = (packageName: string) =>
    `node_modules/${packageName}/package.json`
  const packageJsonFor = (packageName: string) =>
    join(productionNodeModules, packageName, 'package.json')

  const missingRequired = REQUIRED_EFFECT_RUNTIME_PACKAGES.filter(
    (packageName) => !existsSync(packageJsonFor(packageName))
  )
  if (missingRequired.length > 0) {
    throw new Error(
      `Staged production dependencies are missing Effect runtime packages: ${missingRequired.join(', ')}`
    )
  }

  return [
    ...REQUIRED_EFFECT_RUNTIME_PACKAGES.map(markerFor),
    ...OPTIONAL_EFFECT_RUNTIME_PACKAGES.filter((packageName) =>
      existsSync(packageJsonFor(packageName))
    ).map(markerFor),
  ]
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminateProcessGroup(pid: number): void {
  const groupPid = -pid
  try {
    process.kill(groupPid, 'SIGTERM')
  } catch {
    return
  }

  const shutdownDeadline = Date.now() + 5000
  while (Date.now() < shutdownDeadline) {
    if (!isProcessRunning(groupPid)) {
      return
    }
    sleep(50)
  }

  try {
    process.kill(groupPid, 'SIGKILL')
  } catch {
    // The packaged app and its subprocesses completed graceful shutdown.
  }
}

function hasValidSmokeMarker(markerPath: string): boolean {
  if (!existsSync(markerPath)) {
    return false
  }

  try {
    const marker: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    return (
      typeof marker === 'object' &&
      marker !== null &&
      'url' in marker &&
      marker.url === 'laborer://app/'
    )
  } catch {
    return false
  }
}

function resolveGitCommitHash(): string {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return 'unknown'
  }
  const hash = result.stdout.trim()
  if (!GIT_HASH_PATTERN.test(hash)) {
    return 'unknown'
  }
  return hash.toLowerCase()
}

/**
 * Validate that all assets referenced by the bundled index.html exist on disk.
 */
function validateBundledClientAssets(clientDir: string): void {
  const indexPath = join(clientDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`Missing bundled client index.html at ${indexPath}`)
  }

  const indexHtml = readFileSync(indexPath, 'utf8')
  const refs = [...indexHtml.matchAll(HTML_REF_PATTERN)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)

  const missing: string[] = []

  for (const ref of refs) {
    const normalizedRef = ref.split('#')[0]?.split('?')[0] ?? ''
    if (!normalizedRef) {
      continue
    }
    if (
      normalizedRef.startsWith('http://') ||
      normalizedRef.startsWith('https://')
    ) {
      continue
    }
    if (
      normalizedRef.startsWith('data:') ||
      normalizedRef.startsWith('mailto:')
    ) {
      continue
    }

    const ext = extname(normalizedRef)
    if (!ext) {
      continue
    }

    const relativePath = normalizedRef.replace(LEADING_SLASHES_PATTERN, '')
    const assetPath = join(clientDir, relativePath)
    if (!existsSync(assetPath)) {
      missing.push(normalizedRef)
    }
  }

  if (missing.length > 0) {
    const preview = missing.slice(0, 6).join(', ')
    const suffix =
      missing.length > 6 ? ` (+${String(missing.length - 6)} more)` : ''
    throw new Error(
      `Bundled client references missing files: ${preview}${suffix}. Rebuild web artifacts.`
    )
  }
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

const catalog = rootPkg.workspaces.catalog as Record<string, unknown>

/**
 * Resolve production dependencies for a service package.
 * Resolves `catalog:` specs to concrete versions and filters out `workspace:*` deps
 * (those are bundled into the tsdown output by the `noExternal` config).
 */
function resolveServiceDeps(
  pkg: { dependencies?: Record<string, unknown> },
  label: string
): Record<string, unknown> {
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
    return {}
  }
  return resolveCatalogDependencies(pkg.dependencies, catalog, label)
}

/**
 * Resolve desktop runtime dependencies (excluding `electron` which becomes a devDep).
 */
function resolveDesktopRuntimeDeps(): Record<string, unknown> {
  const deps = desktopPkg.dependencies as Record<string, unknown>
  const filtered = Object.fromEntries(
    Object.entries(deps).filter(([name]) => name !== 'electron')
  )
  return resolveCatalogDependencies(filtered, catalog, 'apps/desktop')
}

// ---------------------------------------------------------------------------
// electron-builder config generation
// ---------------------------------------------------------------------------

/**
 * The artifact name pattern uses electron-builder's own variable interpolation
 * syntax (dollar-curly-brace), NOT JavaScript template literals.
 */
// biome-ignore lint/style/noUnusedTemplateLiteral: electron-builder variable interpolation syntax
const ARTIFACT_NAME = `Laborer-\${version}-\${arch}.\${ext}`

function resolveGitHubPublishConfig():
  | {
      readonly provider: 'github'
      readonly owner: string
      readonly repo: string
      readonly releaseType: 'release' | 'prerelease'
      readonly channel?: 'nightly'
    }
  | undefined {
  const rawRepo =
    process.env.LABORER_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    'izakfilmalter/laborer'

  const parts = rawRepo.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (!(owner && repo) || parts.length !== 2) {
    return undefined
  }

  const updateChannel = resolveDesktopUpdateChannel(BUILD_VERSION)

  return {
    provider: 'github',
    owner,
    repo,
    releaseType: updateChannel === 'nightly' ? 'prerelease' : 'release',
    ...(updateChannel === 'nightly' ? { channel: 'nightly' as const } : {}),
  }
}

function resolveDesktopUpdateChannel(version: string): 'latest' | 'nightly' {
  return NIGHTLY_VERSION_PATTERN.test(version) ? 'nightly' : 'latest'
}

function createBuildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    appId: 'com.izakfilmalter.laborer',
    productName: resolveDesktopAppName({
      isDevelopment: false,
      version: BUILD_VERSION,
    }),
    artifactName: ARTIFACT_NAME,
    directories: {
      buildResources: 'apps/desktop/resources',
    },
    files: ['**/*'],
    extraResources: [
      {
        from: 'packages/server/dist/task-mcp-main.mjs',
        to: `${MCP_RESOURCE_DIRECTORY}/${MCP_SCRIPT_NAME}`,
      },
      {
        from: `packages/server/dist/${MCP_RUNTIME_NAME}`,
        to: `${MCP_RESOURCE_DIRECTORY}/${MCP_RUNTIME_NAME}`,
      },
      {
        from: 'packages/server/dist/migrations',
        to: `${MCP_RESOURCE_DIRECTORY}/migrations`,
      },
    ],
    mac: {
      target: ['dmg', 'zip'],
      icon: 'icon.icns',
      category: 'public.app-category.developer-tools',
    },
  }

  const publishConfig = resolveGitHubPublishConfig()
  if (publishConfig) {
    config.publish = [publishConfig]
  }

  return config
}

function resolvePackagedResourcesDirectory(stageAppDir: string): string {
  const appName = resolveDesktopAppName({
    isDevelopment: false,
    version: BUILD_VERSION,
  })
  return join(
    stageAppDir,
    'dist',
    `mac-${ARCH}`,
    `${appName}.app`,
    'Contents',
    'Resources'
  )
}

function validatePackagedMcpResources(stageAppDir: string): void {
  const resourcesDirectory = resolvePackagedResourcesDirectory(stageAppDir)
  const mcpDirectory = join(resourcesDirectory, MCP_RESOURCE_DIRECTORY)
  const scriptPath = join(mcpDirectory, MCP_SCRIPT_NAME)
  const requiredFiles = [
    scriptPath,
    join(mcpDirectory, MCP_RUNTIME_NAME),
    ...REQUIRED_MCP_MIGRATIONS.map((name) =>
      join(mcpDirectory, 'migrations', name)
    ),
  ]
  const missing = requiredFiles.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(
      `Packaged MCP resources are missing: ${missing.map((path) => relative(resourcesDirectory, path)).join(', ')}`
    )
  }

  if (!readFileSync(scriptPath, 'utf8').startsWith(NODE_SHEBANG)) {
    throw new Error(
      `Packaged MCP script is missing its Node shebang: ${scriptPath}`
    )
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX executable bits are a bit mask.
  if ((statSync(scriptPath).mode & 0o111) === 0) {
    throw new Error(`Packaged MCP script is not executable: ${scriptPath}`)
  }

  log(
    `Validated executable MCP resources in ${relative(stageAppDir, mcpDirectory)}`
  )
}

function smokeTestPackagedMcp(stageAppDir: string): void {
  const scriptPath = join(
    resolvePackagedResourcesDirectory(stageAppDir),
    MCP_RESOURCE_DIRECTORY,
    MCP_SCRIPT_NAME
  )
  const smokeRoot = mkdtempSync(join(tmpdir(), 'laborer-mcp-package-smoke-'))
  const env = {
    ...process.env,
    HOME: smokeRoot,
    XDG_STATE_HOME: join(smokeRoot, 'state'),
  }
  const smokeClient = join(REPO_ROOT, 'scripts/smoke-test-packaged-mcp.mjs')

  try {
    run(process.execPath, [smokeClient, process.execPath, scriptPath], { env })
    run(process.execPath, [smokeClient, scriptPath], { env })
    log('Packaged MCP completed initialize + tool call via Node and shebang')
  } finally {
    rmSync(smokeRoot, { force: true, recursive: true })
  }
}

function validatePackagedAsar(stageAppDir: string): void {
  const appName = resolveDesktopAppName({
    isDevelopment: false,
    version: BUILD_VERSION,
  })
  const appAsarPath = join(
    stageAppDir,
    'dist',
    `mac-${ARCH}`,
    `${appName}.app`,
    'Contents',
    'Resources',
    'app.asar'
  )

  if (!existsSync(appAsarPath)) {
    throw new Error(`Missing packaged app.asar at ${appAsarPath}`)
  }

  const result = spawnSync('bunx', ['asar', 'list', appAsarPath], {
    cwd: stageAppDir,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect packaged app.asar: ${result.stderr.trim() || result.stdout.trim()}`
    )
  }

  const files = new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim().replace(LEADING_SLASHES_PATTERN, ''))
      .filter((line) => line.length > 0)
  )

  // Derive the optional v4 payload marker from the production install that
  // electron-builder actually packed. This avoids making the validator stale
  // when platform-node stops installing platform-node-shared transitively.
  const requiredFiles = [
    ...resolveEffectRuntimeAsarMarkers(join(stageAppDir, 'node_modules')),
    ...REQUIRED_ASAR_FILES,
  ]
  const missing = requiredFiles.filter((file) => !files.has(file))
  if (missing.length > 0) {
    throw new Error(
      `Packaged app.asar is missing runtime dependencies: ${missing.join(', ')}`
    )
  }

  const removedPayloads = [...files].filter((file) =>
    REMOVED_PERSISTENCE_PAYLOAD_PATTERN.test(file)
  )
  if (removedPayloads.length > 0) {
    throw new Error(
      `Packaged app.asar contains removed persistence payloads: ${removedPayloads.slice(0, 20).join(', ')}`
    )
  }

  log(
    `Validated runtime dependencies and removed payloads in ${relative(stageAppDir, appAsarPath)}`
  )
}

function smokeTestPackagedApp(stageAppDir: string): void {
  const appName = resolveDesktopAppName({
    isDevelopment: false,
    version: BUILD_VERSION,
  })
  const executablePath = join(
    stageAppDir,
    'dist',
    `mac-${ARCH}`,
    `${appName}.app`,
    'Contents',
    'MacOS',
    appName
  )
  if (!existsSync(executablePath)) {
    throw new Error(`Missing packaged executable at ${executablePath}`)
  }

  const smokeRoot = mkdtempSync(join(tmpdir(), 'laborer-desktop-smoke-'))
  const markerPath = join(smokeRoot, 'renderer-ready.json')
  const stateRoot = join(smokeRoot, 'state')
  const databasePath = join(stateRoot, 'laborer', 'laborer.sqlite')
  const output = VERBOSE ? 'inherit' : 'ignore'
  let childPid: number | undefined
  try {
    const child = spawn(executablePath, [], {
      detached: true,
      env: {
        HOME: smokeRoot,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        LABORER_DESKTOP_SMOKE_TEST_FILE: markerPath,
        LABORER_DISABLE_AUTO_UPDATE: '1',
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        SHELL: process.env.SHELL ?? '/bin/zsh',
        TMPDIR: smokeRoot,
        XDG_CONFIG_HOME: join(smokeRoot, 'config'),
        XDG_STATE_HOME: stateRoot,
      },
      stdio: ['ignore', output, output],
    })
    // A failed spawn reports both an undefined pid and an asynchronous error.
    // The listener prevents that error from escaping after this function throws.
    child.once('error', () => undefined)
    childPid = child.pid
    if (childPid === undefined) {
      throw new Error('Packaged app did not start')
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < PACKAGED_SMOKE_TIMEOUT_MS) {
      // This script intentionally blocks between probes, so ChildProcess
      // events and exitCode cannot be used to observe liveness here.
      if (!isProcessRunning(childPid)) {
        throw new Error('Packaged app exited before smoke readiness')
      }
      if (hasValidSmokeMarker(markerPath) && existsSync(databasePath)) {
        log(
          'Packaged app loaded its renderer against the shared laborer.sqlite'
        )
        return
      }
      sleep(100)
    }
    throw new Error(
      `Packaged app did not load its renderer and shared database within ${String(PACKAGED_SMOKE_TIMEOUT_MS)}ms`
    )
  } finally {
    if (childPid !== undefined) {
      terminateProcessGroup(childPid)
    }
    rmSync(smokeRoot, { force: true, recursive: true })
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

interface StagePackageJson {
  readonly author: string
  readonly build: Record<string, unknown>
  readonly dependencies: Record<string, unknown>
  readonly description: string
  readonly devDependencies: { readonly electron: string }
  readonly laborerCommitHash: string
  readonly main: string
  readonly name: string
  readonly overrides?: Record<string, unknown>
  readonly private: true
  readonly version: string
}

/**
 * Build the staging directory structure:
 *
 *   <stage>/app/
 *     package.json              <- generated production package.json
 *     node_modules/             <- installed via `bun install --production --omit optional`
 *     apps/
 *       desktop/
 *         dist-electron/        <- main.cjs, preload.cjs, utility-process-bootstrap.cjs
 *         resources/            <- icons
 *       web/
 *         dist/                 <- bundled frontend
 *     packages/
 *       server/
 *         dist/                 <- utility-main.mjs (MessagePort RPC server)
 *       terminal/
 *         dist/                 <- utility-main.mjs (node-pty direct, MessagePort RPC)
 *       file-watcher/
 *         dist/                 <- utility-main.mjs (@parcel/watcher, MessagePort RPC)
 *     dist/                     <- electron-builder output
 */
function stage(stageRoot: string): void {
  const stageAppDir = join(stageRoot, 'app')

  // Validate all dist dirs exist.
  for (const [label, dir] of Object.entries(DIST_DIRS)) {
    if (!existsSync(dir)) {
      throw new Error(
        `Missing ${label} at ${dir}. Run 'turbo build' first or omit --skip-build.`
      )
    }
  }

  // Validate bundled client assets.
  validateBundledClientAssets(DIST_DIRS.webDist)

  log('Staging release app...')

  // Create directory structure.
  mkdirSync(join(stageAppDir, 'apps/desktop'), { recursive: true })
  mkdirSync(join(stageAppDir, 'apps/web'), { recursive: true })
  mkdirSync(join(stageAppDir, 'packages/server'), { recursive: true })
  mkdirSync(join(stageAppDir, 'packages/terminal'), { recursive: true })
  mkdirSync(join(stageAppDir, 'packages/file-watcher'), { recursive: true })

  // Copy built artifacts.
  cpSync(
    DIST_DIRS.desktopDist,
    join(stageAppDir, 'apps/desktop/dist-electron'),
    { recursive: true }
  )
  cpSync(
    DIST_DIRS.desktopResources,
    join(stageAppDir, 'apps/desktop/resources'),
    { recursive: true }
  )
  cpSync(DIST_DIRS.webDist, join(stageAppDir, 'apps/web/dist'), {
    recursive: true,
  })
  cpSync(DIST_DIRS.serverDist, join(stageAppDir, 'packages/server/dist'), {
    recursive: true,
  })
  cpSync(DIST_DIRS.terminalDist, join(stageAppDir, 'packages/terminal/dist'), {
    recursive: true,
  })
  cpSync(
    DIST_DIRS.fileWatcherDist,
    join(stageAppDir, 'packages/file-watcher/dist'),
    { recursive: true }
  )
  // Resolve dependencies from all service packages.
  const resolvedServerDeps = resolveServiceDeps(serverPkg, 'packages/server')
  const resolvedTerminalDeps = resolveServiceDeps(
    terminalPkg,
    'packages/terminal'
  )
  const resolvedFileWatcherDeps = resolveServiceDeps(
    fileWatcherPkg,
    'packages/file-watcher'
  )
  const resolvedDesktopDeps = resolveDesktopRuntimeDeps()

  const electronVersion = desktopPkg.dependencies.electron
  const appVersion = BUILD_VERSION
  const commitHash = resolveGitCommitHash()

  const stagePackageJson: StagePackageJson = {
    name: 'laborer-desktop',
    version: appVersion,
    laborerCommitHash: commitHash,
    private: true,
    description: 'Laborer desktop build',
    author: 'Izak Filmalter',
    main: 'apps/desktop/dist-electron/main.cjs',
    build: createBuildConfig(),
    dependencies: {
      ...resolvedServerDeps,
      ...resolvedTerminalDeps,
      ...resolvedFileWatcherDeps,
      ...resolvedDesktopDeps,
    },
    devDependencies: {
      electron: electronVersion,
    },
    overrides: rootPkg.overrides,
  }

  writeFileSync(
    join(stageAppDir, 'package.json'),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`
  )

  const stagedDependencyNames = Object.keys(stagePackageJson.dependencies)
  const removedDependencyNames = stagedDependencyNames.filter((name) =>
    REMOVED_PERSISTENCE_PAYLOAD_PATTERN.test(name)
  )
  if (removedDependencyNames.length > 0) {
    throw new Error(
      `Generated production dependencies contain removed packages: ${removedDependencyNames.join(', ')}`
    )
  }

  // Install production dependencies in the staging directory.
  log('Installing staged production dependencies...')
  run('bun', ['install', '--production', '--omit', 'optional', '--offline'], {
    cwd: stageAppDir,
  })
  validateNoRemovedPersistencePayloads(
    join(stageAppDir, 'node_modules'),
    'staged production dependencies'
  )

  // Run electron-builder.
  log(`Building mac/dmg+zip (arch=${ARCH}, version=${appVersion})...`)

  // Build a clean environment for electron-builder.
  // When not signed, strip code-signing vars to prevent auto-discovery.
  const buildEnv: Record<string, string> = {}
  const signingKeysToStrip = SIGNED
    ? []
    : [
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
        'APPLE_API_KEY',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER',
      ]
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value !== '' &&
      !signingKeysToStrip.includes(key)
    ) {
      buildEnv[key] = value
    }
  }
  if (!SIGNED) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }

  run(
    'bunx',
    ['electron-builder', '--mac', `--${ARCH}`, '--publish', 'never'],
    { cwd: stageAppDir, env: buildEnv }
  )

  validatePackagedAsar(stageAppDir)
  validatePackagedMcpResources(stageAppDir)
  smokeTestPackagedMcp(stageAppDir)
  smokeTestPackagedApp(stageAppDir)

  // Copy artifacts to output dir.
  const stageDistDir = join(stageAppDir, 'dist')
  if (!existsSync(stageDistDir)) {
    throw new Error(
      `Build completed but dist directory was not found at ${stageDistDir}`
    )
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })

  const copiedArtifacts: string[] = []
  for (const entry of readdirSync(stageDistDir)) {
    const from = join(stageDistDir, entry)
    const stat = statSync(from)
    if (!stat.isFile()) {
      continue
    }

    const to = join(OUTPUT_DIR, entry)
    copyFileSync(from, to)
    copiedArtifacts.push(to)
  }

  if (copiedArtifacts.length === 0) {
    throw new Error(
      `Build completed but no files were produced in ${stageDistDir}`
    )
  }

  log('Done. Artifacts:')
  for (const artifact of copiedArtifacts) {
    console.info(`  ${artifact}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  log('Starting Laborer desktop build...')

  // Step 1: Build all packages (unless --skip-build).
  if (!SKIP_BUILD) {
    log('Building all packages (turbo build)...')
    run('turbo', ['build'], { cwd: REPO_ROOT })
  }

  // Step 2: Create staging directory.
  const stageRoot = mkdtempSync(join(tmpdir(), 'laborer-desktop-mac-stage-'))

  try {
    stage(stageRoot)
  } finally {
    if (KEEP_STAGE) {
      log(`Staging directory preserved at: ${stageRoot}`)
    } else {
      log('Cleaning up staging directory...')
      rmSync(stageRoot, { recursive: true, force: true })
    }
  }
}

main()
