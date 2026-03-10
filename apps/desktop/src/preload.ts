import { contextBridge } from 'electron'

/**
 * Minimal desktop bridge exposed to the renderer.
 * This is an empty stub — the full DesktopBridge interface will be
 * implemented in a later issue (Issue 10).
 */
contextBridge.exposeInMainWorld('desktopBridge', {})
