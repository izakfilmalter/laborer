/**
 * Electron desktop bridge detection and utility functions.
 *
 * In Electron mode, the frontend communicates with backend services via
 * MessagePort connections to utility processes. The DesktopBridge provides
 * methods to acquire these ports.
 *
 * Runtime contexts:
 * - **Electron dev** (`turbo dev`): Vite dev server + Electron shell.
 *   Services run as utility processes. Communication via MessagePort.
 * - **Electron production**: Frontend served via `laborer://` protocol.
 *   Services run as utility processes. Communication via MessagePort.
 *
 * @see packages/shared/src/desktop-bridge.ts — DesktopBridge contract
 * @see apps/desktop/src/preload.ts — preload script implementation
 */

import type { DesktopBridge } from '@laborer/shared/desktop-bridge'

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

/** Return the desktop-managed backend WebSocket URL, when running in Electron. */
export function getBackendWsUrl(): string | null {
  return getDesktopBridge()?.getBackendWsUrl() ?? null
}

export function getBackendRpcWsUrl(): string | null {
  const backendUrl = getBackendWsUrl()
  if (!backendUrl) {
    return null
  }

  const url = new URL(backendUrl)
  url.pathname = '/rpc'
  return url.toString()
}

export function getBackendSyncWsUrl(): string | null {
  const backendUrl = getBackendWsUrl()
  if (!backendUrl) {
    return null
  }

  const url = new URL(backendUrl)
  const token = url.searchParams.get('token')
  url.search = ''
  url.pathname = token ? `/sync/${encodeURIComponent(token)}` : '/sync'
  return url.toString()
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

/**
 * IPC channel constants — must match ipc.ts in the desktop app.
 */
const ACQUIRE_SERVICE_PORT_CHANNEL = 'laborer:acquire-service-port'
const SERVICE_PORT_RESPONSE_CHANNEL = 'laborer:service-port-response'
const ACQUIRE_TERMINAL_DATA_PORT_CHANNEL = 'laborer:acquire-terminal-data-port'
const TERMINAL_DATA_PORT_RESPONSE_CHANNEL =
  'laborer:terminal-data-port-response'
const ACQUIRE_SYNC_PORT_CHANNEL = 'laborer:acquire-sync-port'
const SYNC_PORT_RESPONSE_CHANNEL = 'laborer:sync-port-response'

/**
 * Acquire a `MessagePort` from a utility process, following VS Code's pattern.
 *
 * Flow:
 * 1. Install `window` `message` listener to catch the relayed port
 * 2. Call preload's `ipcMessagePort.acquire()` to install the IPC relay
 * 3. Call preload's `ipcSend()` to trigger the main process
 * 4. Main process creates a MessageChannelMain pair, sends one end to the
 *    utility process, responds with the other end via `webContents.postMessage`
 * 5. Preload relay fires: `window.postMessage(nonce, '*', e.ports)`
 * 6. Window listener catches the port, resolves the promise
 *
 * @see VS Code's `acquirePort()` in
 *   `.reference/vscode/src/vs/base/parts/ipc/electron-browser/ipc.mp.ts`
 */
function acquirePort(
  bridge: DesktopBridge,
  responseChannel: string,
  requestChannel: string,
  requestPayload: Record<string, unknown>
): Promise<MessagePort | null> {
  const nonce = crypto.randomUUID()

  // Step 1: Install window listener FIRST — must be ready before the
  // IPC response arrives to avoid a race condition.
  const portPromise = new Promise<MessagePort | null>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve(null)
    }, 10_000)

    const handler = (event: MessageEvent) => {
      if (event.data === nonce && event.source === window) {
        clearTimeout(timeout)
        window.removeEventListener('message', handler)
        resolve(event.ports[0] ?? null)
      }
    }
    window.addEventListener('message', handler)
  })

  // Step 2: Tell the preload to listen on the responseChannel and
  // relay the port via window.postMessage when it arrives.
  bridge.ipcMessagePort.acquire(responseChannel, nonce)

  // Step 3: Send the request to the main process.
  bridge.ipcSend(requestChannel, { ...requestPayload, nonce })

  return portPromise
}

/**
 * Acquire a service port (RPC connection to a utility process).
 */
export function acquireServicePort(name: string): Promise<MessagePort | null> {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return Promise.resolve(null)
  }
  return acquirePort(
    bridge,
    SERVICE_PORT_RESPONSE_CHANNEL,
    ACQUIRE_SERVICE_PORT_CHANNEL,
    { name }
  )
}

/**
 * Acquire a sync port (LiveStore sync connection to the server).
 */
export function acquireSyncPort(): Promise<MessagePort | null> {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return Promise.resolve(null)
  }
  return acquirePort(
    bridge,
    SYNC_PORT_RESPONSE_CHANNEL,
    ACQUIRE_SYNC_PORT_CHANNEL,
    {}
  )
}

/**
 * Acquire a terminal data port (PTY I/O data channel).
 */
export function acquireTerminalDataPort(
  terminalId: string
): Promise<MessagePort | null> {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return Promise.resolve(null)
  }
  return acquirePort(
    bridge,
    TERMINAL_DATA_PORT_RESPONSE_CHANNEL,
    ACQUIRE_TERMINAL_DATA_PORT_CHANNEL,
    { terminalId }
  )
}

export { getDesktopBridge }
