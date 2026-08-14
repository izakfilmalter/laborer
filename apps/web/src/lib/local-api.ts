import type {
  ContextMenuItem,
  DesktopBridge,
} from '@laborer/shared/desktop-bridge'
import {
  acquireServicePort as acquireDesktopServicePort,
  acquireTerminalDataPort as acquireDesktopTerminalDataPort,
  focusExistingWindowForWorkspace as focusExistingDesktopWindowForWorkspace,
  getDesktopBridge,
  getCurrentWindowId as getDesktopWindowId,
} from './desktop'

export type BrowserFolderPicker = () => Promise<string | null>
export type BrowserContextMenu<T extends string> = (
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number }
) => Promise<T | null>

/**
 * The renderer's single capability boundary for local OS integrations.
 * Electron uses native chrome through DesktopBridge; browser mode degrades to
 * browser or DOM implementations supplied by the calling surface.
 */
class LocalApi {
  get desktopBridge(): DesktopBridge | undefined {
    return getDesktopBridge()
  }

  get isDesktop(): boolean {
    return this.desktopBridge !== undefined
  }

  get contextMenuKind(): 'native' | 'dom' {
    return this.isDesktop ? 'native' : 'dom'
  }

  async openExternal(url: string): Promise<boolean> {
    const bridge = this.desktopBridge
    if (bridge) {
      return await bridge.openExternal(url)
    }
    if (typeof window === 'undefined') {
      return false
    }
    return window.open(url, '_blank', 'noopener,noreferrer') !== null
  }

  async pickFolder(fallback: BrowserFolderPicker): Promise<string | null> {
    const bridge = this.desktopBridge
    return bridge ? await bridge.pickFolder() : await fallback()
  }

  async showContextMenu<T extends string>(
    items: readonly ContextMenuItem<T>[],
    position: { x: number; y: number } | undefined,
    fallback: BrowserContextMenu<T>
  ): Promise<T | null> {
    const bridge = this.desktopBridge
    return bridge
      ? await bridge.showContextMenu(items, position)
      : await fallback(items, position)
  }
}

export const localApi = new LocalApi()

export const acquireServicePort = (name: string) =>
  acquireDesktopServicePort(name)

export const acquireTerminalDataPort = (terminalId: string) =>
  acquireDesktopTerminalDataPort(terminalId)

export const focusExistingWindowForWorkspace = (workspaceId: string) =>
  focusExistingDesktopWindowForWorkspace(workspaceId)

export const getCurrentWindowId = () => getDesktopWindowId()
