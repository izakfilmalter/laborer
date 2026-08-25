import {
  type DesktopBridge,
  decodeWorkspaceActivationIntent,
} from '@laborer/shared/desktop-bridge'
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
const ENSURE_DAEMON_CHANNEL = 'desktop:ensure-daemon'
const QUIT_REPLY_CHANNEL = 'desktop:quit-reply'
const QUIT_CONFIRMED_CHANNEL = 'desktop:quit-confirmed'
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
  quitApp: () => ipcRenderer.send(QUIT_CONFIRMED_CHANNEL),

  ensureDaemon: () => ipcRenderer.invoke(ENSURE_DAEMON_CHANNEL),

  getWindowId: () => windowId,

  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),

  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),

  focusWindowForWorkspace: (workspaceId, intent) =>
    ipcRenderer.invoke(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL, workspaceId, intent),

  showContextMenu: (items, position) =>
    ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),

  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),

  onActivateWorkspace: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: unknown
    ) => {
      if (typeof payload === 'string') {
        listener({ workspaceId: payload })
        return
      }
      if (typeof payload !== 'object' || payload === null) {
        return
      }
      const intent = decodeWorkspaceActivationIntent(payload)
      if (intent !== undefined) {
        listener(intent)
      }
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

  reportWindowWorkspaces: (workspaceIds, contexts = []) =>
    ipcRenderer.invoke(REPORT_VISIBLE_WORKSPACES_CHANNEL, {
      contexts,
      workspaceIds,
    }),

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
