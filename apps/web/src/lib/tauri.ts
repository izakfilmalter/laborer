/**
 * Tauri runtime detection and service URL resolution utilities.
 *
 * In Tauri production mode, the frontend is served from `tauri://localhost`
 * rather than the Vite dev server. This means relative URLs like `/rpc`
 * resolve to `tauri://localhost/rpc` instead of going through the Vite proxy.
 * These utilities detect the runtime context and provide the correct
 * absolute URLs for backend services.
 *
 * Runtime contexts:
 * - **Browser dev** (no Tauri): Vite dev server on localhost:2101 proxies
 *   /rpc, /terminal-rpc, /terminal to backend services
 * - **Tauri dev** (`tauri dev`): Same as browser dev — Vite dev server
 *   proxies requests. `isTauri()` returns true but `location.origin` is
 *   `http://localhost:2101` so relative URLs still work.
 * - **Tauri production** (`tauri build`): Frontend served from
 *   `tauri://localhost`. Backend services run as sidecars on localhost:2100
 *   and localhost:2102. Must use absolute URLs.
 *
 * @see Issue 6: Wire sidecars into Tauri app setup and frontend routing
 */

/** Default ports matching `@laborer/env/server`. */
const SERVER_PORT = 2100
const TERMINAL_PORT = 2102

/**
 * Check if running inside a Tauri webview.
 * Returns true in both `tauri dev` and `tauri build` modes.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Check if the frontend is in Tauri production mode where the Vite
 * dev proxy is NOT available. In this mode, `location.origin` is
 * `tauri://localhost` and we must use absolute URLs to reach services.
 *
 * Returns false in `tauri dev` mode (where Vite proxy handles routing)
 * and in plain browser mode.
 */
function isTauriProduction(): boolean {
  if (typeof globalThis.location === 'undefined') {
    return false
  }
  return globalThis.location.origin.startsWith('tauri://')
}

/**
 * Resolve the HTTP URL for the main server's RPC endpoint.
 *
 * - Dev mode: `/rpc` (Vite proxy handles routing)
 * - Tauri production: `http://localhost:2100/rpc` (direct to sidecar)
 */
export function serverRpcUrl(): string {
  if (isTauriProduction()) {
    return `http://localhost:${SERVER_PORT}/rpc`
  }
  return '/rpc'
}

/**
 * Resolve the HTTP URL for the terminal service's RPC endpoint.
 *
 * - Dev mode: `/terminal-rpc` (Vite proxy rewrites to terminal's /rpc)
 * - Tauri production: `http://localhost:${TERMINAL_PORT}/rpc` (direct)
 */
export function terminalRpcUrl(): string {
  if (isTauriProduction()) {
    return `http://localhost:${TERMINAL_PORT}/rpc`
  }
  return '/terminal-rpc'
}

/**
 * Resolve the WebSocket URL for the server's RPC sync endpoint.
 *
 * - Dev mode: `ws://localhost:2101/rpc` (Vite proxy with WS upgrade)
 * - Tauri production: `ws://localhost:2100/rpc` (direct to sidecar)
 */
export function serverWsSyncUrl(): string {
  if (isTauriProduction()) {
    return `ws://localhost:${SERVER_PORT}/rpc`
  }
  return `${globalThis.location.origin}/rpc`
}

/**
 * Resolve the WebSocket URL for a terminal connection.
 *
 * - Dev mode: `ws://localhost:2101/terminal?id=<id>` (Vite proxy)
 * - Tauri production: `ws://localhost:2102/terminal?id=<id>` (direct)
 *
 * @param terminalId - The terminal session ID to connect to.
 */
export function terminalWsUrl(terminalId: string): string {
  const encoded = encodeURIComponent(terminalId)
  if (isTauriProduction()) {
    return `ws://localhost:${TERMINAL_PORT}/terminal?id=${encoded}`
  }
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${globalThis.location.host}/terminal?id=${encoded}`
}
