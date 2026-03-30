/**
 * Watches sidecar `dist/` directories for changes and automatically restarts
 * the corresponding utility processes. Used in dev mode only.
 *
 * When `tsdown --watch` rebuilds a sidecar's `dist/utility-main.mjs`, this
 * watcher detects the file change and calls `LifecycleMonitor.manualRestart()`
 * for that service. This gives developers hot reload for utility process code
 * with ~300–500ms total latency (rebuild + restart).
 *
 * Key behaviors:
 * - Watches `packages/<name>/dist/` for each service
 * - Debounces rapid file changes to avoid multiple restarts during a single
 *   rebuild (tsdown may write multiple files in quick succession)
 * - Disabled when `LABORER_SKIP_WATCH=1` env var is set
 * - Graceful cleanup on shutdown
 *
 * @see Issue #17: Dev mode hot reload (tsdown --watch + auto-restart)
 */

import { join } from 'node:path'

import type { LifecycleMonitor } from './lifecycle-monitor.js'
import type { ServiceName } from './utility-process-manager.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Debounce delay in milliseconds for file change events.
 *
 * `tsdown` may emit multiple file writes in quick succession during a single
 * rebuild (e.g., `.mjs`, `.mjs.map`, `.d.mts`). We wait this long after the
 * last change event before triggering a restart.
 *
 * 200ms is long enough to coalesce a rebuild's multiple file writes but short
 * enough to keep total hot reload latency under 500ms.
 */
export const DEBOUNCE_MS = 200

/**
 * The services to watch and their corresponding package directories.
 */
const SERVICE_PACKAGES: ReadonlyArray<{
  readonly name: ServiceName
  readonly pkg: string
}> = [
  { name: 'terminal', pkg: 'terminal' },
  { name: 'server', pkg: 'server' },
  { name: 'file-watcher', pkg: 'file-watcher' },
  { name: 'mcp', pkg: 'mcp' },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Abstraction over `node:fs.watch()` for testability. */
export interface FsWatcher {
  close(): void
}

/** Abstraction over `node:fs` watch function for testability. */
export type WatchFn = (
  path: string,
  options: { recursive?: boolean },
  callback: (eventType: string, filename: string | null) => void
) => FsWatcher

// ---------------------------------------------------------------------------
// DevWatcher
// ---------------------------------------------------------------------------

/**
 * Watches sidecar dist directories for changes and triggers utility process
 * restarts via the LifecycleMonitor.
 *
 * Only active in dev mode. Disabled by `LABORER_SKIP_WATCH=1`.
 */
export class DevWatcher {
  private readonly lifecycleMonitor: LifecycleMonitor
  private readonly watchers = new Map<ServiceName, FsWatcher>()
  private readonly debounceTimers = new Map<
    ServiceName,
    ReturnType<typeof setTimeout>
  >()
  private readonly repoRoot: string
  private readonly watchFn: WatchFn
  private isShutdown = false

  constructor(options: {
    lifecycleMonitor: LifecycleMonitor
    repoRoot: string
    watchFn: WatchFn
  }) {
    this.lifecycleMonitor = options.lifecycleMonitor
    this.repoRoot = options.repoRoot
    this.watchFn = options.watchFn
  }

  /**
   * Start watching all sidecar dist directories.
   *
   * For each service, watches `packages/<pkg>/dist/` recursively. When a
   * file changes, debounces the event and then restarts the corresponding
   * utility process via the LifecycleMonitor.
   */
  startWatching(): void {
    if (this.isShutdown) {
      return
    }

    for (const { name, pkg } of SERVICE_PACKAGES) {
      const distPath = join(this.repoRoot, 'packages', pkg, 'dist')

      try {
        const watcher = this.watchFn(
          distPath,
          { recursive: true },
          (_eventType, _filename) => {
            this.handleChange(name)
          }
        )
        this.watchers.set(name, watcher)
        console.info(`[dev-watcher:${name}] Watching ${distPath}`)
      } catch (err: unknown) {
        // The dist directory may not exist yet if the package hasn't been
        // built. Log a warning and continue — tsdown --watch will create
        // it, and we can re-try or the developer can restart manually.
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.warn(
          `[dev-watcher:${name}] Failed to watch ${distPath}: ${message}`
        )
      }
    }
  }

  /**
   * Handle a file change event for a service.
   *
   * Debounces rapid changes to avoid multiple restarts during a single
   * rebuild. After the debounce delay, triggers `manualRestart()` on the
   * LifecycleMonitor.
   */
  private handleChange(name: ServiceName): void {
    if (this.isShutdown) {
      return
    }

    // Clear any existing debounce timer for this service.
    const existing = this.debounceTimers.get(name)
    if (existing) {
      clearTimeout(existing)
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(name)
      this.triggerRestart(name)
    }, DEBOUNCE_MS)

    // Don't let the timer prevent app exit.
    timer.unref()

    this.debounceTimers.set(name, timer)
  }

  /**
   * Trigger a restart for a service after the debounce period.
   */
  private triggerRestart(name: ServiceName): void {
    if (this.isShutdown) {
      return
    }

    console.info(
      `[dev-watcher:${name}] Dist changed — restarting utility process`
    )

    this.lifecycleMonitor.manualRestart(name).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[dev-watcher:${name}] Restart failed: ${message}`)
    })
  }

  /**
   * Stop all file watchers and cancel pending debounce timers.
   *
   * NOTE: We intentionally avoid `console.info` here because shutdown often
   * runs after the parent process's stdio streams have been destroyed (e.g.,
   * Ctrl+C during dev mode). Writing to a broken pipe throws `Error: write
   * EIO` which Electron surfaces as an uncaught-exception dialog.
   */
  shutdown(): void {
    this.isShutdown = true

    for (const [, watcher] of this.watchers) {
      watcher.close()
    }
    this.watchers.clear()

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }
}
