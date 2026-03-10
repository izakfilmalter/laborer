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
 * - **Tauri production** (`tauri build`): Frontend served on localhost:4101.
 *   Backend services run as sidecars on localhost:4100 and localhost:4102.
 *   Uses port range 4100+ to avoid conflicts with dev mode (2100+).
 *   Must use absolute URLs.
 *
 * @see Issue 6: Wire sidecars into Tauri app setup and frontend routing
 */

/**
 * Tauri production sidecar ports.
 * These use a different range (4100+) than dev mode (2100+) so both can run simultaneously.
 */
const SERVER_PORT = 4100
const TERMINAL_PORT = 4102

/**
 * Wait for Tauri sidecar services to become healthy.
 *
 * In Tauri production mode, invokes the `await_initialization` command
 * which blocks until both the server and terminal sidecars pass health
 * checks. In dev mode or non-Tauri environments, resolves immediately.
 *
 * Call this before rendering any components that connect to backend
 * services (LiveStore, RPC clients, terminal WebSockets).
 */
export async function waitForSidecars(): Promise<void> {
  if (!isTauriProduction()) {
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('await_initialization')
}

/**
 * Check if running inside a Tauri webview.
 * Returns true in both `tauri dev` and `tauri build` modes.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Check if the frontend is in Tauri production mode where the Vite
 * dev proxy is NOT available. In production, the frontend is served
 * via tauri-plugin-localhost on http://localhost:4101 (a different port
 * than dev's 2101 so both can coexist). We detect this by checking for
 * the Tauri runtime AND a non-dev origin (tauri:// scheme or the
 * localhost plugin port without a Vite dev server).
 *
 * Returns false in `tauri dev` mode (where Vite proxy handles routing)
 * and in plain browser mode.
 */
function isTauriProduction(): boolean {
  if (typeof globalThis.location === 'undefined') {
    return false
  }
  // tauri:// scheme (fallback if localhost plugin isn't used)
  if (globalThis.location.origin.startsWith('tauri://')) {
    return true
  }
  // Localhost plugin serves on port 4101. In dev mode, Vite serves
  // on 2101 but __TAURI_INTERNALS__ differentiates. The key difference:
  // in production there is no Vite HMR WebSocket, and the build output
  // includes a marker. We use a simpler check: Tauri runtime + release
  // build detection via import.meta.env.
  return isTauri() && import.meta.env.PROD
}

/**
 * Resolve the HTTP URL for the main server's RPC endpoint.
 *
 * - Dev mode: `/rpc` (Vite proxy handles routing)
 * - Tauri production: `http://localhost:4100/rpc` (direct to sidecar)
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
 * - Tauri production: `ws://localhost:4100/rpc` (direct to sidecar)
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
 * - Tauri production: `ws://localhost:4102/terminal?id=<id>` (direct)
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
