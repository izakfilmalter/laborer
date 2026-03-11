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

import { spawnSync } from 'node:child_process'
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
import { dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import desktopPkg from '../apps/desktop/package.json' with { type: 'json' }
import rootPkg from '../package.json' with { type: 'json' }
import mcpPkg from '../packages/mcp/package.json' with { type: 'json' }
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
  mcpDist: join(REPO_ROOT, 'packages/mcp/dist'),
}

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
      readonly releaseType: 'release'
    }
  | undefined {
  const rawRepo =
    process.env.LABORER_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    ''
  if (!rawRepo) {
    return undefined
  }

  const parts = rawRepo.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (!(owner && repo) || parts.length !== 2) {
    return undefined
  }

  return {
    provider: 'github',
    owner,
    repo,
    releaseType: 'release',
  }
}

function createBuildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    appId: 'com.izakfilmalter.laborer',
    productName: 'Laborer',
    artifactName: ARTIFACT_NAME,
    directories: {
      buildResources: 'apps/desktop/resources',
    },
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
  readonly private: true
  readonly version: string
}

/**
 * Build the staging directory structure:
 *
 *   <stage>/app/
 *     package.json              <- generated production package.json
 *     node_modules/             <- installed via `bun install --production`
 *     apps/
 *       desktop/
 *         dist-electron/        <- main.js, preload.js
 *         resources/            <- icons
 *       web/
 *         dist/                 <- bundled frontend
 *     packages/
 *       server/
 *         dist/                 <- bundled server
 *       terminal/
 *         dist/                 <- bundled terminal service
 *       mcp/
 *         dist/                 <- bundled MCP service
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
  mkdirSync(join(stageAppDir, 'packages/mcp'), { recursive: true })

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
  cpSync(DIST_DIRS.mcpDist, join(stageAppDir, 'packages/mcp/dist'), {
    recursive: true,
  })

  // Resolve dependencies from all service packages.
  const resolvedServerDeps = resolveServiceDeps(serverPkg, 'packages/server')
  const resolvedTerminalDeps = resolveServiceDeps(
    terminalPkg,
    'packages/terminal'
  )
  const resolvedMcpDeps = resolveServiceDeps(mcpPkg, 'packages/mcp')
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
    main: 'apps/desktop/dist-electron/main.js',
    build: createBuildConfig(),
    dependencies: {
      ...resolvedServerDeps,
      ...resolvedTerminalDeps,
      ...resolvedMcpDeps,
      ...resolvedDesktopDeps,
    },
    devDependencies: {
      electron: electronVersion,
    },
  }

  writeFileSync(
    join(stageAppDir, 'package.json'),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`
  )

  // Install production dependencies in the staging directory.
  log('Installing staged production dependencies...')
  run('bun', ['install', '--production'], { cwd: stageAppDir })

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
