import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { app } from 'electron'

import type { ServicePorts } from './ports.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of stderr lines retained per sidecar for crash diagnostics. */
const MAX_STDERR_LINES = 50

/** Grace period (ms) between SIGTERM and SIGKILL during shutdown. */
const KILL_GRACE_MS = 2000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies a sidecar service. */
export type SidecarName = 'server' | 'terminal' | 'file-watcher' | 'mcp'

/** A tracked child process with its stderr ring buffer. */
interface TrackedSidecar {
  /** Whether the process was intentionally stopped (not a crash). */
  intentionallyStopped: boolean
  readonly name: SidecarName
  readonly process: ChildProcess
  /** Ring buffer of recent stderr lines for crash diagnostics. */
  readonly stderrLines: string[]
}

/** Callback invoked when a sidecar exits unexpectedly. */
export type SidecarExitHandler = (
  name: SidecarName,
  code: number | null,
  signal: string | null,
  lastStderr: string
) => void

// ---------------------------------------------------------------------------
// Entry point resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the root of the monorepo / app bundle.
 *
 * In development: `__dirname` is `apps/desktop/dist-electron/`, so the repo
 * root is three levels up.
 * In production: `app.getAppPath()` points to the packaged resources.
 */
function resolveAppRoot(): string {
  if (!app.isPackaged) {
    // dist-electron/ -> apps/desktop -> apps -> repo root
    return join(import.meta.dirname, '..', '..', '..')
  }
  return app.getAppPath()
}

/**
 * Resolve the entry point for a sidecar service.
 *
 * In dev mode, services are run via tsx with their TypeScript source.
 * In prod mode, they are bundled to dist/ directories.
 */
function resolveEntryPath(name: SidecarName): string {
  const root = resolveAppRoot()

  if (!app.isPackaged) {
    // Dev mode: TypeScript source run via tsx
    switch (name) {
      case 'server':
        return join(root, 'packages/server/src/main.ts')
      case 'terminal':
        return join(root, 'packages/terminal/src/main.ts')
      case 'file-watcher':
        return join(root, 'packages/file-watcher/src/main.ts')
      default:
        return join(root, 'packages/mcp/src/main.ts')
    }
  }

  // Production: bundled entry points.
  // tsdown outputs .mjs for ESM format, so use the correct extension.
  switch (name) {
    case 'server':
      return join(root, 'packages/server/dist/main.mjs')
    case 'terminal':
      return join(root, 'packages/terminal/dist/main.mjs')
    case 'file-watcher':
      return join(root, 'packages/file-watcher/dist/main.mjs')
    default:
      return join(root, 'packages/mcp/dist/main.mjs')
  }
}

/**
 * Resolve the executable and args for spawning a sidecar.
 *
 * In dev mode: uses tsx to run TypeScript directly.
 * In prod mode: uses the Electron binary with ELECTRON_RUN_AS_NODE=1.
 */
function resolveSpawnCommand(name: SidecarName): {
  executable: string
  args: string[]
} {
  const entryPath = resolveEntryPath(name)

  if (!app.isPackaged) {
    // Dev mode: run via tsx for TypeScript support.
    // tsx is a devDependency of each package, available in node_modules/.bin/
    const root = resolveAppRoot()
    const tsxPath = join(root, 'node_modules', '.bin', 'tsx')
    return { executable: tsxPath, args: [entryPath] }
  }

  // Production: use the Electron binary as a Node.js runtime.
  return { executable: process.execPath, args: [entryPath] }
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

/**
 * Build the environment variables for a sidecar process.
 *
 * Inherits the current process.env (which includes the fixed PATH from
 * fix-path.ts), then overlays service-specific variables.
 */
function buildSidecarEnv(
  _name: SidecarName,
  ports: ServicePorts
): Record<string, string> {
  const dataDir = app.isPackaged
    ? join(app.getPath('appData'), 'data')
    : undefined

  const baseEnv: Record<string, string> = {
    ...filterEnv(process.env),
    PORT: String(ports.serverPort),
    TERMINAL_PORT: String(ports.terminalPort),
    FILE_WATCHER_PORT: String(ports.fileWatcherPort),
  }

  // In production, set ELECTRON_RUN_AS_NODE so the Electron binary
  // behaves as a plain Node.js runtime (no GUI window).
  if (app.isPackaged) {
    baseEnv.ELECTRON_RUN_AS_NODE = '1'
  }

  if (dataDir) {
    baseEnv.DATA_DIR = dataDir
  }

  return baseEnv
}

/**
 * Filter process.env to a plain Record<string, string>, removing
 * undefined values and Electron-specific vars that should not leak
 * into child processes.
 */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  const blocklist = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_PORT'])

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !blocklist.has(key)) {
      result[key] = value
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Sidecar Manager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of sidecar child processes (server, terminal, MCP).
 *
 * Responsibilities:
 * - Spawn child processes with correct environment and entry points
 * - Capture stderr in a ring buffer for crash diagnostics
 * - Log stdout/stderr lines
 * - Graceful shutdown: SIGTERM first, SIGKILL after timeout
 * - Track intentional vs unexpected exits
 */
export class SidecarManager {
  private readonly sidecars = new Map<SidecarName, TrackedSidecar>()
  private readonly ports: ServicePorts
  private onUnexpectedExit: SidecarExitHandler | null = null
  private isQuitting = false

  constructor(ports: ServicePorts) {
    this.ports = ports
  }

  /**
   * Register a handler called when a sidecar exits unexpectedly.
   * Used by the main process to emit events to the renderer (Issue 9).
   */
  setExitHandler(handler: SidecarExitHandler): void {
    this.onUnexpectedExit = handler
  }

  /**
   * Spawn a sidecar child process.
   *
   * The process's stdout and stderr are captured line-by-line:
   * - stdout lines are logged at info level
   * - stderr lines are logged at warn level and stored in a ring buffer
   *
   * Returns once the process is spawned (does not wait for health check).
   */
  spawn(name: SidecarName): ChildProcess {
    // Kill existing instance if any.
    if (this.sidecars.has(name)) {
      this.killOne(name)
    }

    const { executable, args } = resolveSpawnCommand(name)
    const env = buildSidecarEnv(name, this.ports)

    // MCP uses pipe for stdin (stdio transport), server/terminal ignore stdin.
    const stdinMode = name === 'mcp' ? 'pipe' : 'ignore'

    console.info(`[sidecar:${name}] Spawning: ${executable} ${args.join(' ')}`)

    const child = spawn(executable, args, {
      cwd: app.isPackaged ? app.getPath('home') : resolveAppRoot(),
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
    })

    const tracked: TrackedSidecar = {
      name,
      process: child,
      stderrLines: [],
      intentionallyStopped: false,
    }

    this.sidecars.set(name, tracked)

    // Stream stdout to console (line-by-line).
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line: string) => {
        console.info(`[${name}:stdout] ${line}`)
      })
    }

    // Stream stderr to console and ring buffer.
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line: string) => {
        console.warn(`[${name}:stderr] ${line}`)
        tracked.stderrLines.push(line)
        if (tracked.stderrLines.length > MAX_STDERR_LINES) {
          tracked.stderrLines.shift()
        }
      })
    }

    // Monitor for unexpected exits.
    child.once('exit', (code: number | null, signal: string | null) => {
      console.info(`[sidecar:${name}] Exited: code=${code} signal=${signal}`)

      const current = this.sidecars.get(name)
      if (!current || current.process !== child) {
        // Already replaced by a new instance.
        return
      }

      if (!(current.intentionallyStopped || this.isQuitting)) {
        const lastStderr = current.stderrLines.join('\n')
        this.onUnexpectedExit?.(name, code, signal, lastStderr)
      }

      this.sidecars.delete(name)
    })

    return child
  }

  /**
   * @deprecated Use `HealthMonitor.spawnServices()` instead, which replaces
   * delay-based startup with proper HTTP health check polling.
   *
   * Spawn terminal then server with fixed delays between them.
   * Kept only as a fallback — the HealthMonitor is the primary interface.
   */
  async spawnServices(): Promise<void> {
    this.spawn('terminal')
    await delay(1500)
    this.spawn('server')
    await delay(1500)
  }

  /**
   * Get the last stderr lines for a sidecar (for crash diagnostics).
   */
  getLastStderr(name: SidecarName): string {
    const tracked = this.sidecars.get(name)
    if (!tracked) {
      return ''
    }
    return tracked.stderrLines.join('\n')
  }

  /**
   * Get the child process for a sidecar (if running).
   */
  getProcess(name: SidecarName): ChildProcess | undefined {
    return this.sidecars.get(name)?.process
  }

  /**
   * Check if a sidecar is currently running.
   */
  isRunning(name: SidecarName): boolean {
    const tracked = this.sidecars.get(name)
    if (!tracked) {
      return false
    }
    return (
      tracked.process.exitCode === null && tracked.process.signalCode === null
    )
  }

  /**
   * Kill a specific sidecar gracefully: SIGTERM first, SIGKILL after timeout.
   */
  killOne(name: SidecarName): void {
    const tracked = this.sidecars.get(name)
    if (!tracked) {
      return
    }

    tracked.intentionallyStopped = true
    const child = tracked.process

    if (child.exitCode !== null || child.signalCode !== null) {
      // Already exited.
      this.sidecars.delete(name)
      return
    }

    console.info(`[sidecar:${name}] Sending SIGTERM`)
    child.kill('SIGTERM')

    // Escalate to SIGKILL after grace period.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        console.warn(`[sidecar:${name}] SIGTERM timeout, sending SIGKILL`)
        child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS).unref()
  }

  /**
   * Kill all tracked sidecars gracefully.
   * Called during app shutdown.
   */
  killAll(): void {
    this.isQuitting = true
    console.info(
      `[sidecar] Killing all sidecars: ${[...this.sidecars.keys()].join(', ')}`
    )

    for (const name of this.sidecars.keys()) {
      this.killOne(name)
    }
  }

  /**
   * Kill all sidecars and wait for them to exit.
   * Returns a promise that resolves once all processes have terminated
   * or the timeout has elapsed.
   */
  async killAllAndWait(timeoutMs = 5000): Promise<void> {
    this.killAll()

    const exitPromises = [...this.sidecars.values()].map(
      (tracked) =>
        new Promise<void>((resolve) => {
          if (
            tracked.process.exitCode !== null ||
            tracked.process.signalCode !== null
          ) {
            resolve()
            return
          }
          tracked.process.once('exit', () => resolve())
        })
    )

    // Race between all processes exiting and a timeout.
    await Promise.race([Promise.all(exitPromises), delay(timeoutMs)])
  }

  /**
   * Restart a specific sidecar: kill it, then re-spawn.
   * Note: Does not wait for health check (that's Issue 9).
   */
  restart(name: SidecarName): ChildProcess {
    console.info(`[sidecar:${name}] Restarting`)
    this.killOne(name)
    return this.spawn(name)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
