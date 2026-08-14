import type {
  ContextMenuItem,
  DesktopBridge,
} from '@laborer/shared/desktop-bridge'
import { getDesktopBridge } from './desktop'

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

// Transport helpers remain implementation details of the current desktop
// runtime until phase 3 removes MessagePort transport. Re-exporting them here
// keeps every renderer-side local capability behind one module boundary.
export {
  acquireServicePort,
  acquireTerminalDataPort,
  focusExistingWindowForWorkspace,
  getCurrentWindowId,
} from './desktop'
