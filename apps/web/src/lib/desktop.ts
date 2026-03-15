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

/**
 * Resolve the HTTP URL for the server's init-status endpoint.
 *
 * Used by the phase transition driver to poll whether all deferred
 * services have finished initializing (triggering the Eventually phase).
 *
 * - Dev mode: `/server-init-status` (Vite proxy rewrites to server's /init-status)
 * - Electron production: `${desktopBridge.getServerUrl()}/init-status` (direct)
 *
 * @see Issue #15: Server "fully initialized" event
 */
export function serverInitStatusUrl(): string {
  if (isElectronProduction()) {
    const bridge = getDesktopBridge()
    if (bridge) {
      return `${bridge.getServerUrl()}/init-status`
    }
  }
  return '/server-init-status'
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
