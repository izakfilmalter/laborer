/**
 * Build script for compiling backend services into standalone sidecar binaries.
 *
 * Usage:
 *   bun run scripts/build-sidecars.ts          # Build all sidecars
 *   bun run scripts/build-sidecars.ts mcp      # Build only the MCP sidecar
 *   bun run scripts/build-sidecars.ts server    # Build only the server sidecar
 *   bun run scripts/build-sidecars.ts terminal  # Build only the terminal sidecar
 *
 * The script:
 * 1. Determines the Rust target triple for the current platform.
 * 2. Compiles each service using `bun build --compile`.
 * 3. Places the output in `src-tauri/sidecars/<name>-<target-triple>`.
 * 4. For the server sidecar, uses Bun.build() API with plugins to handle
 *    native dependencies (@parcel/watcher, wa-sqlite WASM, undici re-exports).
 */

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Bun type declarations (inline — the web app tsconfig does not include bun types)
// ---------------------------------------------------------------------------

declare const Bun: {
  build(options: {
    compile: { outfile: string }
    entrypoints: string[]
    external?: string[]
    plugins?: ReadonlyArray<{
      name: string
      setup: (builder: BunPluginBuilder) => void
    }>
    target: string
  }): Promise<{
    logs: unknown[]
    outputs: Array<{ path: string; size: number }>
    success: boolean
  }>
}

interface BunPluginBuilder {
  onLoad(
    config: { filter: RegExp; namespace?: string },
    callback: (args: {
      path: string
    }) => { contents: string; loader: 'js' } | undefined
  ): void
  onResolve(
    config: { filter: RegExp },
    callback: (args: {
      importer?: string
      path: string
    }) => { namespace: string; path: string } | undefined
  ): void
}

interface BuildPlugin {
  name: string
  setup: (builder: BunPluginBuilder) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dirname
const WEB_DIR = resolve(SCRIPT_DIR, '..')
const SIDECARS_DIR = resolve(WEB_DIR, 'src-tauri', 'sidecars')
const MONOREPO_ROOT = resolve(WEB_DIR, '..', '..')

/** Map of arch from `uname -m` to Rust target arch */
const ARCH_MAP: Record<string, string> = {
  arm64: 'aarch64',
  aarch64: 'aarch64',
  x86_64: 'x86_64',
}

/** Map of OS from `uname -s` to Rust target OS+ABI */
const OS_MAP: Record<string, string> = {
  Darwin: 'apple-darwin',
  Linux: 'unknown-linux-gnu',
}

// ---------------------------------------------------------------------------
// Regex patterns — defined at module scope per biome lint rules
// ---------------------------------------------------------------------------

const PARCEL_WATCHER_RE = /^@parcel\/watcher$/
const UNDICI_RE = /Undici\.js$/
const WA_SQLITE_NODE_RE = /wa-sqlite\.node\.mjs$/
const STUB_NAMESPACE_RE = /./

// ---------------------------------------------------------------------------
// Server build plugins
// ---------------------------------------------------------------------------

/**
 * Build plugins for the server sidecar.
 *
 * The server has complex native dependency requirements:
 * 1. `@parcel/watcher` — native C++ addon that may not be available. The server
 *    gracefully falls back to `fs.watch`, but `@effect/platform-node-shared`
 *    statically imports it. We stub it at build time to prevent startup crashes.
 * 2. `@effect/platform-node/Undici.js` — re-exports `undici` via `export * from "undici"`.
 *    Bun's bundler generates a `__reExport(exports, undici)` call referencing an
 *    undeclared `undici` namespace variable (bundler bug). We don't need the undici
 *    HTTP client since the server uses `@effect/platform-bun`. Stubbed at build time.
 * 3. `wa-sqlite.node.wasm` — LiveStore's SQLite WASM module. The Emscripten-generated
 *    loader resolves the `.wasm` file via `new URL("wa-sqlite.node.wasm", import.meta.url)`,
 *    which points to the virtual `/$bunfs/root/` in compiled binaries. We patch the
 *    loader to resolve relative to `process.execPath` (the real binary on disk).
 */

/**
 * The original wa-sqlite WASM resolution string that uses import.meta.url.
 * This fails in compiled binaries because import.meta.url points to /$bunfs/root/.
 */
const WA_SQLITE_WASM_ORIGINAL =
  'return new URL("wa-sqlite.node.wasm",import.meta.url).href'

/**
 * Replacement that resolves the WASM file relative to the compiled binary's
 * real location on disk (process.execPath).
 */
const WA_SQLITE_WASM_REPLACEMENT =
  'return require("url").pathToFileURL(require("path").join(require("path").dirname(process.execPath),"wa-sqlite.node.wasm")).href'

function makeServerBuildPlugins(): BuildPlugin[] {
  return [
    {
      name: 'sidecar-server-plugins',
      setup(build: BunPluginBuilder) {
        // Stub @parcel/watcher — server falls back to fs.watch.
        // The @effect/platform-node-shared parcelWatcher module has a static
        // `import * as ParcelWatcher from "@parcel/watcher"` that would crash
        // the compiled binary at startup since the native addon can't be loaded
        // from the virtual filesystem.
        build.onResolve({ filter: PARCEL_WATCHER_RE }, (args) => ({
          path: args.path,
          namespace: 'sidecar-stub',
        }))

        // Stub @effect/platform-node's Undici.js re-export module.
        // This module does `export * from "undici"` which triggers a Bun bundler
        // bug: the generated code references an undeclared `undici` namespace
        // variable via `__reExport(exports, undici)`. Since the server uses
        // @effect/platform-bun (not node), this module is never actually used
        // at runtime.
        build.onResolve({ filter: UNDICI_RE }, (args) => {
          if (args.importer?.includes('@effect/platform-node')) {
            return { path: 'undici-stub', namespace: 'sidecar-stub' }
          }
          return undefined
        })

        // Patch wa-sqlite.node.mjs to find WASM relative to process.execPath.
        // The Emscripten-generated factory function resolves the .wasm file via:
        //   new URL("wa-sqlite.node.wasm", import.meta.url).href
        // In compiled binaries, import.meta.url is /$bunfs/root/..., so we
        // replace this with process.execPath-relative resolution. The WASM file
        // is copied alongside the binary by the build script's copyFiles config.
        build.onLoad({ filter: WA_SQLITE_NODE_RE }, (args) => {
          let contents = readFileSync(args.path, 'utf-8')

          if (contents.includes(WA_SQLITE_WASM_ORIGINAL)) {
            contents = contents.replace(
              WA_SQLITE_WASM_ORIGINAL,
              WA_SQLITE_WASM_REPLACEMENT
            )
          }

          return { contents, loader: 'js' as const }
        })

        // Generic stub loader — returns an empty default export.
        build.onLoad(
          { filter: STUB_NAMESPACE_RE, namespace: 'sidecar-stub' },
          () => ({
            contents: 'export default {};',
            loader: 'js' as const,
          })
        )
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Sidecar definitions
// ---------------------------------------------------------------------------

/** Sidecar definitions — extend this object to add new sidecars. */
interface SidecarDef {
  /**
   * Files to copy alongside the compiled binary.
   * Each entry maps a source path (absolute) to a destination filename
   * that will be placed in the sidecars directory.
   */
  copyFiles?: ReadonlyArray<{ readonly dest: string; readonly src: string }>
  /** Entry point relative to the monorepo root */
  entryPoint: string
  /** Extra flags for `bun build --compile` CLI (e.g. `--external`) */
  extraFlags?: readonly string[]
  /** Name used for the output binary (e.g. `laborer-mcp`) */
  name: string
  /**
   * Build plugins. When present, the build uses `Bun.build()` API
   * instead of the CLI for plugin support.
   */
  plugins?: readonly BuildPlugin[]
}

/**
 * Resolve the path to wa-sqlite.node.wasm in the monorepo's node_modules.
 * This file is shipped alongside the server binary so LiveStore can load it.
 */
function findWaSqliteWasm(): string {
  const candidates: string[] = [
    join(
      MONOREPO_ROOT,
      'node_modules',
      '@livestore',
      'wa-sqlite',
      'dist',
      'wa-sqlite.node.wasm'
    ),
  ]

  // Also search bun's cached node_modules
  const bunCacheDir = join(MONOREPO_ROOT, 'node_modules', '.bun')
  if (existsSync(bunCacheDir)) {
    const output = execSync(
      `find "${bunCacheDir}" -name "wa-sqlite.node.wasm" -path "*/dist/wa-sqlite.node.wasm" -not -path "*/fts5/*" 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim()
    if (output) {
      const firstResult = output.split('\n')[0]
      if (firstResult !== undefined) {
        candidates.unshift(firstResult)
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not find wa-sqlite.node.wasm. Searched:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
  )
}

const SIDECARS: Record<string, SidecarDef> = {
  mcp: {
    name: 'laborer-mcp',
    entryPoint: 'packages/mcp/src/main.ts',
  },
  server: {
    name: 'laborer-server',
    entryPoint: 'packages/server/src/main.ts',
    extraFlags: ['--external', 'lightningcss'],
    plugins: makeServerBuildPlugins(),
    copyFiles: [
      {
        src: findWaSqliteWasm(),
        dest: 'wa-sqlite.node.wasm',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function getTargetTriple(): string {
  const arch = execSync('uname -m', { encoding: 'utf-8' }).trim()
  const os = execSync('uname -s', { encoding: 'utf-8' }).trim()

  const rustArch = ARCH_MAP[arch]
  if (!rustArch) {
    throw new Error(`Unsupported architecture: ${arch}`)
  }

  const rustOs = OS_MAP[os]
  if (!rustOs) {
    throw new Error(`Unsupported OS: ${os}`)
  }

  return `${rustArch}-${rustOs}`
}

/**
 * Extract `--external` package names from CLI-style flags array.
 */
function extractExternals(flags: readonly string[]): string[] {
  const externals: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const nextFlag = flags[i + 1]
    if (flag === '--external' && nextFlag !== undefined) {
      externals.push(nextFlag)
      i++
    }
  }
  return externals
}

/**
 * Build a sidecar using the `Bun.build()` JavaScript API.
 *
 * Used when plugins are required (e.g., the server sidecar needs to stub
 * native modules and patch WASM resolution at build time).
 */
async function buildWithApi(
  def: SidecarDef,
  targetTriple: string
): Promise<void> {
  const entryPath = resolve(MONOREPO_ROOT, def.entryPoint)
  const outputPath = resolve(SIDECARS_DIR, `${def.name}-${targetTriple}`)

  const external = extractExternals(def.extraFlags ?? [])

  console.log('  Using Bun.build() API (plugins required)')

  const result = await Bun.build({
    entrypoints: [entryPath],
    compile: { outfile: outputPath },
    target: 'bun',
    external,
    plugins: [...(def.plugins ?? [])],
  })

  if (!result.success) {
    console.error('  Build failed:')
    for (const log of result.logs) {
      console.error(`    ${String(log)}`)
    }
    process.exit(1)
  }

  console.log(`  Built ${def.name}-${targetTriple}`)
}

/**
 * Build a sidecar using the `bun build --compile` CLI.
 *
 * Used for simple sidecars without plugin requirements (e.g., MCP).
 */
function buildWithCli(def: SidecarDef, targetTriple: string): void {
  const entryPath = resolve(MONOREPO_ROOT, def.entryPoint)
  const outputPath = resolve(SIDECARS_DIR, `${def.name}-${targetTriple}`)

  const flags = def.extraFlags ? def.extraFlags.join(' ') : ''
  const cmd =
    `bun build --compile ${flags} "${entryPath}" --outfile "${outputPath}"`.trim()

  console.log(`  Command: ${cmd}\n`)

  execSync(cmd, {
    cwd: MONOREPO_ROOT,
    stdio: 'inherit',
  })

  console.log(`  Built ${def.name}-${targetTriple}`)
}

async function buildSidecar(
  def: SidecarDef,
  targetTriple: string
): Promise<void> {
  const outputPath = resolve(SIDECARS_DIR, `${def.name}-${targetTriple}`)

  console.log(`\n--- Building sidecar: ${def.name} ---`)
  console.log(`  Entry:  ${resolve(MONOREPO_ROOT, def.entryPoint)}`)
  console.log(`  Output: ${outputPath}`)
  console.log(`  Target: ${targetTriple}`)

  // Use Bun.build() API when plugins are needed, CLI otherwise
  if (def.plugins !== undefined && def.plugins.length > 0) {
    await buildWithApi(def, targetTriple)
  } else {
    buildWithCli(def, targetTriple)
  }

  // Copy companion files alongside the binary
  if (def.copyFiles !== undefined) {
    for (const { src, dest } of def.copyFiles) {
      const destPath = join(SIDECARS_DIR, dest)
      copyFileSync(src, destPath)
      console.log(`  Copied ${dest}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const requestedSidecars = process.argv.slice(2)

  // Determine target triple
  const targetTriple = getTargetTriple()
  console.log(`Target triple: ${targetTriple}`)

  // Ensure sidecars directory exists
  if (!existsSync(SIDECARS_DIR)) {
    mkdirSync(SIDECARS_DIR, { recursive: true })
    console.log(`Created ${SIDECARS_DIR}`)
  }

  // Determine which sidecars to build
  const toBuild =
    requestedSidecars.length > 0 ? requestedSidecars : Object.keys(SIDECARS)

  for (const key of toBuild) {
    const def = SIDECARS[key]
    if (!def) {
      console.error(
        `Unknown sidecar: "${key}". Available: ${Object.keys(SIDECARS).join(', ')}`
      )
      process.exit(1)
    }
    await buildSidecar(def, targetTriple)
  }

  console.log('\nAll sidecars built successfully.')
}

main()
