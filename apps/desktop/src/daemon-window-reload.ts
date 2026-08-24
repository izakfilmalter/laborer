/**
 * Decides when an open BrowserWindow must reload because the daemon that
 * served its current document has been replaced.
 *
 * The desktop daemon is detached and survives app restarts by design, so a
 * freshly launched (or updated) app can connect to an older daemon, load its
 * stale web bundle into windows, and later restart the daemon. The renderer's
 * reconnect logic re-establishes the WebSocket without reloading the page, so
 * without intervention those windows run the old JavaScript bundle forever.
 *
 * This module is pure so the reload policy can be unit tested without
 * Electron: the main process feeds it what each window loaded and what the
 * supervisor just ensured, and it answers "reload or not".
 */

export interface WindowReloadInput {
  /** Origin the ensured daemon serves the web bundle from. */
  readonly currentOrigin: string
  /** Version of the daemon the supervisor just ensured. */
  readonly currentVersion: string
  /** Origin of the window's current document, or null when unknown. */
  readonly loadedOrigin: string | null
  /** Daemon version the window's document was served by, or null when unknown. */
  readonly loadedVersion: string | null
}

/**
 * A window must reload when the daemon version its document came from differs
 * from the ensured daemon's version, or when the ensured daemon serves from a
 * different origin (the old origin is dead, so relative WebSocket reconnects
 * would fail forever). Unknown loaded state never triggers a reload — that is
 * the safe default against reload loops.
 */
export const shouldReloadWindow = (input: WindowReloadInput): boolean => {
  const versionDiffers =
    input.loadedVersion !== null && input.loadedVersion !== input.currentVersion
  const originDiffers =
    input.loadedOrigin !== null && input.loadedOrigin !== input.currentOrigin
  return versionDiffers || originDiffers
}

/**
 * Builds the URL a stale window should reload from, preserving the in-app
 * route (path, query, hash) of its current document against the ensured
 * daemon's origin. Falls back to the bare origin when the current URL is
 * unusable (about:blank, parse failure).
 */
export const reloadTargetUrl = (
  currentUrl: string,
  daemonOrigin: string
): string => {
  try {
    const current = new URL(currentUrl)
    if (current.protocol === 'http:' || current.protocol === 'https:') {
      return new URL(
        `${current.pathname}${current.search}${current.hash}`,
        daemonOrigin
      ).href
    }
  } catch {
    // Fall through to the bare origin.
  }
  return daemonOrigin
}

/**
 * Per-window bookkeeping for the reload policy with a one-reload-per-daemon-
 * transition guard: once a reload has been commanded toward a given
 * origin+version target, repeated ensure completions against that same target
 * stay quiet until the window actually navigates (which re-arms tracking).
 *
 * Generic over the window key so tests never need Electron.
 */
export class DaemonWindowReloadTracker<W> {
  private readonly loadedVersions = new Map<W, string>()
  private readonly commandedTargets = new Map<W, string>()

  /** Record which daemon version served the window's current document. */
  recordLoad(window: W, version: string): void {
    this.loadedVersions.set(window, version)
    this.commandedTargets.delete(window)
  }

  /** Drop all bookkeeping for a closed window. */
  forget(window: W): void {
    this.loadedVersions.delete(window)
    this.commandedTargets.delete(window)
  }

  /**
   * Decide whether the window must reload for the ensured daemon. When it
   * must, the target is recorded immediately so another ensure completion
   * against the same daemon cannot command a second reload.
   */
  shouldReload(
    window: W,
    input: {
      readonly currentOrigin: string
      readonly currentVersion: string
      readonly loadedOrigin: string | null
    }
  ): boolean {
    const target = `${input.currentOrigin}|${input.currentVersion}`
    if (this.commandedTargets.get(window) === target) {
      return false
    }
    const reload = shouldReloadWindow({
      currentOrigin: input.currentOrigin,
      currentVersion: input.currentVersion,
      loadedOrigin: input.loadedOrigin,
      loadedVersion: this.loadedVersions.get(window) ?? null,
    })
    if (reload) {
      this.commandedTargets.set(window, target)
      this.loadedVersions.set(window, input.currentVersion)
    }
    return reload
  }
}
