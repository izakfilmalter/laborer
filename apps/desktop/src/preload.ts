import type { DesktopBridge } from '@laborer/shared/desktop-bridge'
import { contextBridge, ipcRenderer } from 'electron'

import { parseWindowBootstrapArgs } from './window-identity.js'

// ---------------------------------------------------------------------------
// IPC channel constants (must match ipc.ts)
// Alphabetical order for easier lookup.
// ---------------------------------------------------------------------------

const PICK_FOLDER_CHANNEL = 'desktop:pick-folder'
const CONFIRM_CHANNEL = 'desktop:confirm'
const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external'
const MENU_ACTION_CHANNEL = 'desktop:menu-action'
const UPDATE_TRAY_COUNT_CHANNEL = 'desktop:update-tray-count'
const RESTART_SIDECAR_CHANNEL = 'desktop:restart-sidecar'
const GET_SIDECAR_STATUSES_CHANNEL = 'desktop:get-sidecar-statuses'
const SIDECAR_STATUS_CHANNEL = 'sidecar:status'
const SEND_NOTIFICATION_CHANNEL = 'desktop:send-notification'
const NOTIFICATION_CLICKED_CHANNEL = 'desktop:notification-clicked'
const REPORT_VISIBLE_WORKSPACES_CHANNEL = 'desktop:report-visible-workspaces'
const FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL = 'desktop:focus-window-for-workspace'
const ACTIVATE_WORKSPACE_CHANNEL = 'desktop:activate-workspace'
const UPDATE_STATE_CHANNEL = 'desktop:update-state'
const UPDATE_GET_STATE_CHANNEL = 'desktop:update-get-state'
const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update-download'
const UPDATE_INSTALL_CHANNEL = 'desktop:update-install'
const GITHUB_OAUTH_CALLBACK_CHANNEL = 'desktop:github-oauth-callback'
const START_GITHUB_OAUTH_CHANNEL = 'desktop:start-github-oauth'
const BEFORE_QUIT_CHANNEL = 'desktop:before-quit'
const QUIT_REPLY_CHANNEL = 'desktop:quit-reply'
// Port acquisition channel constants are no longer needed in the preload.
// The renderer sends IPC requests directly via `ipcSend()` and the preload
// only needs to relay ports via `ipcMessagePort.acquire(responseChannel, nonce)`.
// Channel constants now live in `apps/web/src/lib/desktop.ts`.

// ---------------------------------------------------------------------------
// Window identity — injected via `additionalArguments` from the main process.
//
// In sandbox mode, `process.env` is unavailable. Instead, the main process
// passes the window ID as `--laborer-window-id=<value>` via BrowserWindow's
// `webPreferences.additionalArguments`. This appears in `process.argv`.
// ---------------------------------------------------------------------------

const { windowId } = parseWindowBootstrapArgs(process.argv)

// ---------------------------------------------------------------------------
// DesktopBridge implementation
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('desktopBridge', {
  // -----------------------------------------------------------------------
  // MessagePort relay — VS Code's ipcMessagePort.acquire() pattern
  //
  // MessagePort objects cannot traverse contextBridge (structured clone
  // strips them). The preload relays ports via window.postMessage() with
  // the port in the transfer array. The renderer listens on window for
  // the relayed port.
  //
  // @see .reference/vscode/src/vs/base/parts/sandbox/electron-browser/preload.ts
  // -----------------------------------------------------------------------

  ipcMessagePort: {
    acquire: (responseChannel: string, nonce: string) => {
      console.log(
        `[preload] ipcMessagePort.acquire(${responseChannel}, ${nonce})`
      )
      let timeout: ReturnType<typeof setTimeout> | null = null
      const listener = (
        _event: Electron.IpcRendererEvent,
        responseNonce: unknown
      ) => {
        console.log(
          `[preload] IPC response on ${responseChannel}: nonce=${JSON.stringify(responseNonce)} ports=${_event.ports.length} match=${responseNonce === nonce}`
        )
        if (responseNonce !== nonce) {
          return
        }
        if (timeout !== null) {
          clearTimeout(timeout)
          timeout = null
        }
        ipcRenderer.off(responseChannel, listener)
        console.log(
          `[preload] Relaying ${_event.ports.length} port(s) via window.postMessage nonce=${nonce}`
        )
        window.postMessage(nonce, '*', _event.ports)
      }
      ipcRenderer.on(responseChannel, listener)
      timeout = setTimeout(() => {
        ipcRenderer.off(responseChannel, listener)
        timeout = null
        console.warn(
          `[preload] Timed out waiting for ${responseChannel} nonce=${nonce}; removed IPC relay listener`
        )
      }, 10_000)
    },
  },

  ipcSend: (channel: string, ...args: unknown[]) => {
    console.log(
      `[preload] ipcSend(${channel}, ${JSON.stringify(args[0])?.slice(0, 100)})`
    )
    ipcRenderer.send(channel, ...args)
  },

  getSidecarStatuses: () => ipcRenderer.invoke(GET_SIDECAR_STATUSES_CHANNEL),

  getWindowId: () => windowId,

  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),

  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),

  focusWindowForWorkspace: (workspaceId) =>
    ipcRenderer.invoke(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL, workspaceId),

  showContextMenu: (items, position) =>
    ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),

  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),

  onActivateWorkspace: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      workspaceId: unknown
    ) => {
      if (typeof workspaceId !== 'string') {
        return
      }
      listener(workspaceId)
    }

    ipcRenderer.on(ACTIVATE_WORKSPACE_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(ACTIVATE_WORKSPACE_CHANNEL, wrappedListener)
    }
  },

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

  reportVisibleWorkspaces: (workspaceIds) =>
    ipcRenderer.invoke(REPORT_VISIBLE_WORKSPACES_CHANNEL, workspaceIds),

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
  onGithubOAuthCallback: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      url: unknown
    ) => {
      if (typeof url !== 'string') {
        return
      }
      listener(url)
    }

    ipcRenderer.on(GITHUB_OAUTH_CALLBACK_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(GITHUB_OAUTH_CALLBACK_CHANNEL, wrappedListener)
    }
  },

  onBeforeQuit: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: unknown
    ) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('id' in payload) ||
        !('reason' in payload)
      ) {
        return
      }
      listener(payload as Parameters<typeof listener>[0])
    }

    ipcRenderer.on(BEFORE_QUIT_CHANNEL, wrappedListener)
    return () => {
      ipcRenderer.removeListener(BEFORE_QUIT_CHANNEL, wrappedListener)
    }
  },

  respondToQuit: (id, veto) => {
    ipcRenderer.send(QUIT_REPLY_CHANNEL, { id, veto })
  },

  startGithubOAuth: (state) =>
    ipcRenderer.invoke(START_GITHUB_OAUTH_CHANNEL, state),
} satisfies DesktopBridge)
