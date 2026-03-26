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
