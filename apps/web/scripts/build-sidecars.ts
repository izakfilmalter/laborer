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
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

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

/** Sidecar definitions — extend this object to add new sidecars. */
interface SidecarDef {
  /** Entry point relative to the monorepo root */
  entryPoint: string
  /** Extra flags for `bun build` (e.g. `--external`) */
  extraFlags?: readonly string[]
  /** Name used for the output binary (e.g. `laborer-mcp`) */
  name: string
}

const SIDECARS: Record<string, SidecarDef> = {
  mcp: {
    name: 'laborer-mcp',
    entryPoint: 'packages/mcp/src/main.ts',
  },
  // Future: extend with server and terminal
  // server: {
  //   name: "laborer-server",
  //   entryPoint: "packages/server/src/main.ts",
  //   extraFlags: ["--external", "@parcel/watcher", "--external", "@livestore/adapter-node"],
  // },
}

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

function buildSidecar(def: SidecarDef, targetTriple: string): void {
  const entryPath = resolve(MONOREPO_ROOT, def.entryPoint)
  const outputPath = resolve(SIDECARS_DIR, `${def.name}-${targetTriple}`)

  console.log(`\n--- Building sidecar: ${def.name} ---`)
  console.log(`  Entry:  ${entryPath}`)
  console.log(`  Output: ${outputPath}`)
  console.log(`  Target: ${targetTriple}`)

  const flags = def.extraFlags ? def.extraFlags.join(' ') : ''
  const cmd =
    `bun build --compile ${flags} "${entryPath}" --outfile "${outputPath}"`.trim()

  console.log(`  Command: ${cmd}\n`)

  execSync(cmd, {
    cwd: MONOREPO_ROOT,
    stdio: 'inherit',
  })

  console.log(`  ✓ Built ${def.name}-${targetTriple}`)
}

function main(): void {
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
    buildSidecar(def, targetTriple)
  }

  console.log('\nAll sidecars built successfully.')
}

main()
