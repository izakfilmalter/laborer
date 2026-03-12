import type { DesktopBridge } from '@laborer/shared/desktop-bridge'
import { contextBridge, ipcRenderer } from 'electron'

import { parseWindowBootstrapArgs } from './window-identity.js'

// ---------------------------------------------------------------------------
// IPC channel constants (must match ipc.ts)
// ---------------------------------------------------------------------------

const PICK_FOLDER_CHANNEL = 'desktop:pick-folder'
const CONFIRM_CHANNEL = 'desktop:confirm'
const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external'
const MENU_ACTION_CHANNEL = 'desktop:menu-action'
const UPDATE_TRAY_COUNT_CHANNEL = 'desktop:update-tray-count'
const RESTART_SIDECAR_CHANNEL = 'desktop:restart-sidecar'
const SIDECAR_STATUS_CHANNEL = 'sidecar:status'
const SEND_NOTIFICATION_CHANNEL = 'desktop:send-notification'
const NOTIFICATION_CLICKED_CHANNEL = 'desktop:notification-clicked'
const UPDATE_STATE_CHANNEL = 'desktop:update-state'
const UPDATE_GET_STATE_CHANNEL = 'desktop:update-get-state'
const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update-download'
const UPDATE_INSTALL_CHANNEL = 'desktop:update-install'

// ---------------------------------------------------------------------------
// Service URLs — injected via `additionalArguments` from the main process.
//
// In sandbox mode, `process.env` is unavailable. Instead, the main process
// passes URLs as `--laborer-<key>=<value>` arguments via BrowserWindow's
// `webPreferences.additionalArguments`. These appear in `process.argv`.
// ---------------------------------------------------------------------------

const { serverUrl, terminalUrl, windowId } = parseWindowBootstrapArgs(
  process.argv
)

// ---------------------------------------------------------------------------
// DesktopBridge implementation
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('desktopBridge', {
  getServerUrl: () => serverUrl,
  getTerminalUrl: () => terminalUrl,
  getWindowId: () => windowId,

  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),

  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),

  showContextMenu: (items, position) =>
    ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),

  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),

  onMenuAction: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      action: unknown
    ) => {
      if (typeof action !== 'string') {
        return
      }
      listener(action)
    }

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener)
    }
  },

  updateTrayWorkspaceCount: (count) =>
    ipcRenderer.invoke(UPDATE_TRAY_COUNT_CHANNEL, count),

  restartSidecar: (name) => ipcRenderer.invoke(RESTART_SIDECAR_CHANNEL, name),

  sendNotification: (payload) =>
    ipcRenderer.invoke(SEND_NOTIFICATION_CHANNEL, payload),

  onNotificationClicked: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      workspaceId: unknown
    ) => {
      if (typeof workspaceId !== 'string') {
        return
      }
      listener(workspaceId)
    }

    ipcRenderer.on(NOTIFICATION_CLICKED_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(NOTIFICATION_CLICKED_CHANNEL, wrappedListener)
    }
  },

  onSidecarStatus: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      status: unknown
    ) => {
      if (typeof status !== 'object' || status === null) {
        return
      }
      listener(status as Parameters<typeof listener>[0])
    }

    ipcRenderer.on(SIDECAR_STATUS_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(SIDECAR_STATUS_CHANNEL, wrappedListener)
    }
  },

  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),

  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),

  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),

  onUpdateState: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      state: unknown
    ) => {
      if (typeof state !== 'object' || state === null) {
        return
      }
      listener(state as Parameters<typeof listener>[0])
    }

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener)
    }
  },
} satisfies DesktopBridge)
