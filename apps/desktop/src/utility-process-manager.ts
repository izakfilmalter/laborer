/**
 * Manages the lifecycle of Electron utility processes.
 *
 * Replaces the HTTP-based `SidecarManager` with Electron's native
 * `utilityProcess.fork()` API and MessagePort IPC. Each service is
 * forked using the bootstrap entry point script, which dynamically
 * imports the actual service module specified via `LABORER_ENTRYPOINT`.
 *
 * Key responsibilities:
 * - Fork utility processes with MessagePort IPC channels
 * - Capture stdout/stderr for logging and crash diagnostics
 * - Track process lifecycle (spawn, exit events)
 * - Graceful shutdown: SIGTERM-equivalent kill with escalation timeout
 * - Restart: kill old process, wait for exit, fork a new one
 *
 * Follows VS Code's UtilityProcess pattern:
 * @see .reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts
 */

import { join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  app,
  MessageChannelMain,
  type MessagePortMain,
  type UtilityProcess,
  utilityProcess,
} from 'electron'

import type { UtilityProcessBootstrapMessage } from './utility-process-types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of stderr lines retained per process for crash diagnostics. */
const MAX_STDERR_LINES = 50

/** Grace period (ms) between kill() and force-kill during shutdown. */
const KILL_GRACE_MS = 2000

/**
 * Environment variables that should not leak into utility processes.
 *
 * `ELECTRON_RUN_AS_NODE` would cause the process to behave as a plain
 * Node.js runtime instead of a utility process. `DEBUG` can enable
 * verbose logging that interferes with structured IPC.
 */
const BLOCKED_ENV_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_PORT',
  'DEBUG',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies a utility process service. */
export type ServiceName = 'server' | 'terminal' | 'file-watcher' | 'mcp'

/** Callback invoked when a utility process exits unexpectedly. */
export type ProcessExitHandler = (
  name: ServiceName,
  code: number,
  lastStderr: string
) => void

/** A tracked utility process with its metadata. */
interface TrackedProcess {
  /** Whether the process was intentionally stopped (not a crash). */
  intentionallyStopped: boolean
  /** Service name. */
  readonly name: ServiceName
  /** Process ID (set after 'spawn' event). */
  pid: number | undefined
  /** The main-process side of the MessagePort pair for RPC. */
  readonly port: MessagePortMain
  /** The Electron UtilityProcess instance. */
  readonly process: UtilityProcess
  /** Ring buffer of recent stderr lines for crash diagnostics. */
  readonly stderrLines: string[]
}

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
    return join(import.meta.dirname, '..', '..', '..')
  }
  return app.getAppPath()
}

/**
 * Resolve the path to the bootstrap script that all utility processes use.
 *
 * The bootstrap is co-located with main.cjs in the dist-electron/ directory.
 */
function resolveBootstrapPath(): string {
  return join(import.meta.dirname, 'utility-process-bootstrap.cjs')
}

/**
 * Resolve the entry point for a service module.
 *
 * In dev mode: services are pre-built to dist/ via tsdown --watch.
 * In prod mode: services are bundled to dist/ directories in the app package.
 */
function resolveEntryPath(name: ServiceName): string {
  const root = resolveAppRoot()

  // Both dev and prod use the built output — dev uses tsdown --watch
  // for incremental builds, prod uses the final bundle.
  //
  // The terminal service uses `utility-main.mjs` — the flattened entry
  // point that uses node-pty directly with MessagePort RPC transport,
  // instead of `main.mjs` which starts an HTTP server.
  switch (name) {
    case 'server':
      return join(root, 'packages/server/dist/utility-main.mjs')
    case 'terminal':
      return join(root, 'packages/terminal/dist/utility-main.mjs')
    case 'file-watcher':
      return join(root, 'packages/file-watcher/dist/main.mjs')
    default:
      return join(root, 'packages/mcp/dist/main.mjs')
  }
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

/**
 * Build the environment variables for a utility process.
 *
 * Deep-clones `process.env`, strips dangerous variables, and sets
 * `LABORER_ENTRYPOINT` for the bootstrap script.
 *
 * Follows VS Code's `createEnv()` pattern:
 * @see .reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts line 276
 */
function buildProcessEnv(name: ServiceName): Record<string, string> {
  const env: Record<string, string> = {}

  // Deep-clone process.env, filtering out undefined values and blocked vars.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.has(key)) {
      env[key] = value
    }
  }

  // Set the entrypoint for the bootstrap script.
  env.LABORER_ENTRYPOINT = resolveEntryPath(name)

  // In production, set DATA_DIR so services store data in the app data path.
  if (app.isPackaged) {
    env.DATA_DIR = join(app.getPath('appData'), 'data')
  }

  return env
}

// ---------------------------------------------------------------------------
// UtilityProcessManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of Electron utility processes for all services.
 *
 * Replaces `SidecarManager` — no HTTP servers, no port allocation, no
 * auth tokens. Each service communicates via MessagePort IPC.
 *
 * @see .reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts
 */
export class UtilityProcessManager {
  private readonly processes = new Map<ServiceName, TrackedProcess>()
  private onUnexpectedExit: ProcessExitHandler | null = null
  private isQuitting = false

  /**
   * Register a handler called when a utility process exits unexpectedly.
   * Used by the LifecycleMonitor to detect crashes and schedule restarts.
   */
  setExitHandler(handler: ProcessExitHandler): void {
    this.onUnexpectedExit = handler
  }

  /**
   * Fork a utility process for the named service.
   *
   * Creates a `MessageChannelMain` pair — one port is sent to the utility
   * process, the other is retained by the manager for the caller.
   *
   * Returns the main-process side `MessagePortMain` for RPC communication.
   *
   * @see VS Code's `connect()` at utilityProcess.ts line 397
   */
  fork(name: ServiceName): MessagePortMain {
    // Kill existing instance if any.
    if (this.processes.has(name)) {
      this.kill(name)
    }

    const bootstrapPath = resolveBootstrapPath()
    const env = buildProcessEnv(name)
    const serviceName = `laborer-${name}`

    console.info(
      `[utility:${name}] Forking utility process (bootstrap: ${bootstrapPath})`
    )

    // Fork the utility process using the bootstrap script.
    const child = utilityProcess.fork(bootstrapPath, [], {
      serviceName,
      env,
      stdio: 'pipe',
    })

    // Create a MessagePort pair for RPC communication.
    // One port goes to the utility process, the other stays with us.
    const { port1: mainPort, port2: utilityPort } = new MessageChannelMain()

    const tracked: TrackedProcess = {
      name,
      process: child,
      port: mainPort,
      stderrLines: [],
      intentionallyStopped: false,
      pid: undefined,
    }

    this.processes.set(name, tracked)

    // Register event listeners.
    this.registerListeners(tracked, utilityPort)

    return mainPort
  }

  /**
   * Register event listeners on a forked utility process.
   *
   * Captures stdout/stderr, tracks spawn/exit, and forwards the
   * utility-side MessagePort after spawn.
   */
  private registerListeners(
    tracked: TrackedProcess,
    utilityPort: MessagePortMain
  ): void {
    const { name, process: child } = tracked

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

    // Track PID after spawn and send the MessagePort.
    child.once('spawn', () => {
      tracked.pid = child.pid
      console.info(`[utility:${name}] Spawned with PID ${child.pid}`)

      // Transfer the utility-side port to the child process.
      // The bootstrap/service can receive this via process.parentPort's
      // 'message' event with the port in the `ports` array.
      child.postMessage({ type: 'port' }, [utilityPort])
    })

    // Listen for messages from the utility process (bootstrap protocol).
    child.on('message', (message: unknown) => {
      const msg = message as UtilityProcessBootstrapMessage
      if (msg?.type === 'ready') {
        console.info(`[utility:${name}] Service ready`)
      } else if (msg?.type === 'error') {
        console.error(`[utility:${name}] Bootstrap error: ${msg.message}`)
      }
    })

    // Monitor for exit.
    child.once('exit', (code: number) => {
      console.info(`[utility:${name}] Exited with code ${code}`)

      const current = this.processes.get(name)
      if (!current || current.process !== child) {
        // Already replaced by a new instance.
        return
      }

      if (!(current.intentionallyStopped || this.isQuitting)) {
        const lastStderr = current.stderrLines.join('\n')
        this.onUnexpectedExit?.(name, code, lastStderr)
      }

      // Close the main-side port since the process is gone.
      current.port.close()
      this.processes.delete(name)
    })
  }

  /**
   * Kill a specific utility process.
   *
   * Electron's `UtilityProcess.kill()` sends SIGTERM on POSIX.
   * If the process doesn't exit within the grace period, we consider
   * it stuck (Electron handles process reaping internally).
   */
  kill(name: ServiceName): void {
    const tracked = this.processes.get(name)
    if (!tracked) {
      return
    }

    tracked.intentionallyStopped = true
    const child = tracked.process

    // Check if already exited (pid becomes undefined after exit).
    if (child.pid === undefined) {
      tracked.port.close()
      this.processes.delete(name)
      return
    }

    console.info(`[utility:${name}] Killing process (PID ${child.pid})`)
    const killed = child.kill()

    if (!killed) {
      console.warn(
        `[utility:${name}] kill() returned false — process may already be dead`
      )
      tracked.port.close()
      this.processes.delete(name)
    }

    // The 'exit' event handler will clean up the tracked entry.
    // Set a timeout to force cleanup if the process doesn't exit.
    setTimeout(() => {
      const current = this.processes.get(name)
      if (current && current.process === child) {
        console.warn(
          `[utility:${name}] Process did not exit within ${KILL_GRACE_MS}ms — cleaning up`
        )
        current.port.close()
        this.processes.delete(name)
      }
    }, KILL_GRACE_MS).unref()
  }

  /**
   * Restart a utility process: kill the old one, wait for exit, fork a new one.
   *
   * Returns the new MessagePortMain for the restarted service.
   */
  async restart(name: ServiceName): Promise<MessagePortMain> {
    console.info(`[utility:${name}] Restarting`)

    const existing = this.processes.get(name)
    if (existing) {
      // Kill and wait for exit.
      await this.killAndWait(name)
    }

    return this.fork(name)
  }

  /**
   * Kill a process and wait for it to exit.
   */
  private killAndWait(name: ServiceName): Promise<void> {
    const tracked = this.processes.get(name)
    if (!tracked) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const child = tracked.process

      // If already exited, resolve immediately.
      if (child.pid === undefined) {
        this.kill(name)
        resolve()
        return
      }

      // Listen for exit, then resolve.
      child.once('exit', () => {
        resolve()
      })

      // Initiate kill.
      this.kill(name)

      // Safety timeout in case exit event never fires.
      setTimeout(() => {
        resolve()
      }, KILL_GRACE_MS + 500).unref()
    })
  }

  /**
   * Kill all tracked utility processes.
   * Called during app shutdown.
   */
  killAll(): void {
    this.isQuitting = true
    const names = [...this.processes.keys()]
    console.info(`[utility] Killing all processes: ${names.join(', ')}`)

    for (const name of names) {
      this.kill(name)
    }
  }

  /**
   * Kill all utility processes and wait for them to exit.
   * Returns a promise that resolves once all processes have terminated
   * or the timeout has elapsed.
   */
  async killAllAndWait(timeoutMs = 5000): Promise<void> {
    this.isQuitting = true
    const names = [...this.processes.keys()]

    if (names.length === 0) {
      return
    }

    console.info(
      `[utility] Killing all processes and waiting: ${names.join(', ')}`
    )

    const exitPromises = [...this.processes.values()].map(
      (tracked) =>
        new Promise<void>((resolve) => {
          if (tracked.process.pid === undefined) {
            resolve()
            return
          }
          tracked.process.once('exit', () => resolve())
        })
    )

    // Initiate kills.
    for (const name of names) {
      this.kill(name)
    }

    // Race between all processes exiting and a timeout.
    await Promise.race([Promise.all(exitPromises), delay(timeoutMs)])
  }

  /**
   * Get the last stderr lines for a process (for crash diagnostics).
   */
  getLastStderr(name: ServiceName): string {
    const tracked = this.processes.get(name)
    if (!tracked) {
      return ''
    }
    return tracked.stderrLines.join('\n')
  }

  /**
   * Get the MessagePortMain for a running process.
   * Returns undefined if the process is not running.
   */
  getPort(name: ServiceName): MessagePortMain | undefined {
    return this.processes.get(name)?.port
  }

  /**
   * Get the PID of a running process.
   * Returns undefined if the process is not running or hasn't spawned yet.
   */
  getPid(name: ServiceName): number | undefined {
    return this.processes.get(name)?.pid
  }

  /**
   * Check if a utility process is currently running.
   */
  isRunning(name: ServiceName): boolean {
    const tracked = this.processes.get(name)
    if (!tracked) {
      return false
    }
    return tracked.process.pid !== undefined
  }

  /**
   * Get the underlying Electron UtilityProcess instance for a running service.
   * Returns undefined if the process is not running or hasn't spawned yet.
   *
   * Used by the main process to transfer additional MessagePorts (e.g., for
   * direct renderer-to-utility-process connections).
   */
  getProcess(name: ServiceName): UtilityProcess | undefined {
    const tracked = this.processes.get(name)
    if (!tracked || tracked.process.pid === undefined) {
      return undefined
    }
    return tracked.process
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
