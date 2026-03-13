/**
 * Electron desktop bridge detection and service URL resolution utilities.
 *
 * In Electron production mode, the frontend is served from `laborer://app/`
 * rather than the Vite dev server. This means relative URLs like `/rpc`
 * won't work — the DesktopBridge provides absolute service URLs instead.
 *
 * Runtime contexts:
 * - **Browser dev** (no Electron): Vite dev server on localhost:2101 proxies
 *   /rpc, /terminal-rpc, /terminal to backend services
 * - **Electron dev** (`turbo dev`): Same as browser dev — Vite dev server
 *   proxies requests. `isElectron()` returns true but relative URLs still work.
 * - **Electron production**: Frontend served via `laborer://` protocol.
 *   Backend services run as child processes on ephemeral ports.
 *   Uses `desktopBridge.getServerUrl()` / `getTerminalUrl()` for absolute URLs.
 *
 * @see packages/shared/src/desktop-bridge.ts — DesktopBridge contract
 * @see apps/desktop/src/preload.ts — preload script implementation
 */

import type { DesktopBridge } from '@laborer/shared/desktop-bridge'

/** Regex for converting http(s) URLs to ws(s) URLs. */
const HTTP_TO_WS_RE = /^http/

/**
 * Access the DesktopBridge injected by the Electron preload script.
 * Returns undefined when running outside Electron (plain browser).
 */
function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window !== 'undefined' && 'desktopBridge' in window) {
    return (window as unknown as { desktopBridge: DesktopBridge }).desktopBridge
  }
  return undefined
}

/**
 * Check if running inside the Electron desktop shell.
 * Returns true when the DesktopBridge is available (preload script loaded).
 */
export function isElectron(): boolean {
  return getDesktopBridge() !== undefined
}

/**
 * Returns the stable identity of the current native window when running in
 * Electron. Browser-based development does not have a native window ID.
 */
export function getCurrentWindowId(): string | null {
  return getDesktopBridge()?.getWindowId() ?? null
}

/**
 * Check if the frontend is in Electron production mode where the Vite
 * dev proxy is NOT available.
 *
 * Returns false in Electron dev mode (where Vite proxy handles routing)
 * and in plain browser mode.
 */
function isElectronProduction(): boolean {
  return isElectron() && import.meta.env.PROD
}

/** Interval between server health check polls (ms). */
const HEALTH_POLL_INTERVAL_MS = 500

/** Per-request timeout for health check fetch (ms). */
const HEALTH_FETCH_TIMEOUT_MS = 2000

/**
 * Resolve the URL used to check whether the server is ready.
 *
 * - Dev mode: `/server-health` — Vite proxy rewrites this to `GET /` on the
 *   server, returning `{ status: "ok" }` with a 2XX response only once the
 *   server's HTTP routes are fully initialized.
 * - Electron production: `${desktopBridge.getServerUrl()}/` — direct to the
 *   sidecar child process.
 */
function serverHealthUrl(): string {
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      return bridge.getServerUrl()
    }
  }
  return '/server-health'
}

/**
 * Poll the server's health endpoint until it responds with a 2XX status.
 *
 * The app renders a loading state while this promise is pending, ensuring
 * that LiveStore sync, AtomRpc clients, and WebSocket connections are not
 * attempted until the server is confirmed ready. This prevents the
 * "connecting..." hang on initial boot in both dev and production modes.
 *
 * The poll runs indefinitely (no timeout) — if the server never becomes
 * ready, the app stays in the loading state rather than rendering in a
 * broken state.
 */
export async function waitForServer(): Promise<void> {
  const url = serverHealthUrl()

  while (true) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        HEALTH_FETCH_TIMEOUT_MS
      )

      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        return
      }
    } catch {
      // Connection refused, timeout, network error — server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
  }
}

/**
 * Resolve the HTTP URL for the main server's RPC endpoint.
 *
 * - Dev mode: `/rpc` (Vite proxy handles routing)
 * - Electron production: `${desktopBridge.getServerUrl()}/rpc` (direct to child process)
 */
export function serverRpcUrl(): string {
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      return `${bridge.getServerUrl()}/rpc`
    }
  }
  return '/rpc'
}

/**
 * Resolve the HTTP URL for the terminal service's RPC endpoint.
 *
 * - Dev mode: `/terminal-rpc` (Vite proxy rewrites to terminal's /rpc)
 * - Electron production: `${desktopBridge.getTerminalUrl()}/rpc` (direct)
 */
export function terminalRpcUrl(): string {
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      return `${bridge.getTerminalUrl()}/rpc`
    }
  }
  return '/terminal-rpc'
}

/**
 * Resolve the WebSocket URL for the server's RPC sync endpoint.
 *
 * - Dev mode: `ws://localhost:2101/rpc` (Vite proxy with WS upgrade)
 * - Electron production: `ws://<serverHost>/rpc` (direct to child process)
 */
export function serverWsSyncUrl(): string {
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      const httpUrl = bridge.getServerUrl()
      const wsUrl = httpUrl.replace(HTTP_TO_WS_RE, 'ws')
      return `${wsUrl}/rpc`
    }
  }
  return `${globalThis.location.origin}/rpc`
}

/**
 * Resolve the WebSocket URL for a terminal connection.
 *
 * - Dev mode: `ws://localhost:2101/terminal?id=<id>` (Vite proxy)
 * - Electron production: `ws://<terminalHost>/terminal?id=<id>` (direct)
 *
 * @param terminalId - The terminal session ID to connect to.
 */
export function terminalWsUrl(terminalId: string): string {
  const encoded = encodeURIComponent(terminalId)
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      const httpUrl = bridge.getTerminalUrl()
      const wsUrl = httpUrl.replace(HTTP_TO_WS_RE, 'ws')
      return `${wsUrl}/terminal?id=${encoded}`
    }
  }
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${globalThis.location.host}/terminal?id=${encoded}`
}

/**
 * Open a URL in the user's default browser.
 *
 * In Electron, this delegates to the preload bridge so the OS browser opens
 * instead of a new Electron window. In plain browser mode, it falls back to
 * `window.open()`.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const bridge = getDesktopBridge()
  if (bridge) {
    return await bridge.openExternal(url)
  }

  if (typeof window === 'undefined') {
    return false
  }

  const openedWindow = window.open(url, '_blank', 'noopener,noreferrer')
  return openedWindow !== null
}

/**
 * Attempt to focus an existing window that has the given workspace open.
 * Returns true if another window was focused (the caller should abort its
 * local workspace-opening flow). Returns false if the workspace is not open
 * in any other window (the caller should proceed normally).
 *
 * In non-Electron contexts, always returns false.
 */
export async function focusExistingWindowForWorkspace(
  workspaceId: string
): Promise<boolean> {
  const bridge = getDesktopBridge()
  if (!bridge?.focusWindowForWorkspace) {
    return false
  }
  try {
    return await bridge.focusWindowForWorkspace(workspaceId)
  } catch {
    return false
  }
}

export { getDesktopBridge }
