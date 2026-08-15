/**
 * Electron desktop bridge detection and utility functions.
 *
 * Backend access is always same-origin WebSocket RPC. The DesktopBridge is
 * limited to Electron chrome and daemon recovery during a production outage.
 *
 * @see packages/shared/src/desktop-bridge.ts — DesktopBridge contract
 * @see apps/desktop/src/preload.ts — preload script implementation
 */

import type { DesktopBridge } from '@laborer/shared/desktop-bridge'

/**
 * Access the DesktopBridge injected by the Electron preload script.
 * Returns undefined when running outside Electron (plain browser).
 */
export function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window !== 'undefined' && 'desktopBridge' in window) {
    return (window as unknown as { desktopBridge: DesktopBridge }).desktopBridge
  }
  return undefined
}

/**
 * Returns the stable identity of the current native window when running in
 * Electron. Browser-based development does not have a native window ID.
 */
export function getCurrentWindowId(): string | null {
  return getDesktopBridge()?.getWindowId() ?? null
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
