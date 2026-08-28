import {
  type DesktopBridge,
  DesktopPreviewPointerEventSchema,
  DesktopPreviewRecordingFrameSchema,
  DesktopPreviewStateChangeEventSchema,
  type WorkspaceActivationIntent,
} from '@laborer/shared/desktop-bridge'
import { Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
// biome-ignore lint/performance/noNamespaceImport: mirrors the isolated preview channel surface.
import * as PreviewChannels from './preview/channels.js'
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
// Activation intent narrowing
//
// A sandboxed preload has no module resolver and no ordinary module scope, so
// it cannot carry a runtime dependency: a bare `require` or a bundled library
// that declares globals such as `setImmediate` fails the whole script and takes
// `window.desktopBridge` with it. The main process already decodes this payload
// against WorkspaceActivationIntentSchema before it is sent (see ipc.ts), so
// this end only re-narrows the trusted shape for the renderer's type.
// ---------------------------------------------------------------------------

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function narrowActivationIntent(
  payload: object
): WorkspaceActivationIntent | undefined {
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.workspaceId !== 'string') {
    return undefined
  }
  if (candidate.action === 'open-agent-pane') {
    return isOptionalString(candidate.initialPrompt)
      ? (candidate as unknown as WorkspaceActivationIntent)
      : undefined
  }
  if (candidate.action !== undefined) {
    return undefined
  }
  return isOptionalString(candidate.terminalId)
    ? (candidate as unknown as WorkspaceActivationIntent)
    : undefined
}

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
      const intent = narrowActivationIntent(payload)
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

  preview: {
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        colorScheme: defaults?.colorScheme,
        tabId,
        zoomFactor: defaults?.zoomFactor,
      }),
    closeTab: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, {
        tabId,
        webContentsId,
      }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_NAVIGATE_CHANNEL, {
        tabId,
        url,
      }),
    goBack: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    stop: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_STOP_CHANNEL, { tabId }),
    zoomIn: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    hardReload: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_HARD_RELOAD_CHANNEL, {
        tabId,
      }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, {
        colorScheme,
        tabId,
      }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, {
        audioMuted,
        tabId,
      }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, {
        tabId,
      }),
    clearCookies: () =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CLEAR_COOKIES_CHANNEL),
    clearCache: () =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CLEAR_CACHE_CHANNEL),
    getPreviewConfig: (environmentId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_GET_CONFIG_CHANNEL, {
        environmentId,
      }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, {
        theme,
      }),
    pickElement: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_PICK_ELEMENT_CHANNEL, {
        tabId,
      }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, {
        tabId,
      }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, {
        tabId,
      }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, {
        path,
      }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(PreviewChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, {
        path,
      }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(
          PreviewChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
          {
            tabId,
          }
        ),
      close: (tabId) =>
        ipcRenderer.invoke(
          PreviewChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
          {
            tabId,
          }
        ),
    },
    recording: {
      startScreencast: (tabId) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_RECORDING_START_CHANNEL, {
          tabId,
        }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_RECORDING_STOP_CHANNEL, {
          tabId,
        }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          data,
          mimeType,
          tabId,
        }),
      onFrame: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          try {
            listener(
              Schema.decodeUnknownSync(DesktopPreviewRecordingFrameSchema)(
                frame
              )
            )
          } catch {
            // Ignore malformed main-process events at the bridge boundary.
          }
        }
        ipcRenderer.on(PreviewChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrapped)
        return () =>
          ipcRenderer.removeListener(
            PreviewChannels.PREVIEW_RECORDING_FRAME_CHANNEL,
            wrapped
          )
      },
    },
    automation: {
      status: (tabId) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL, {
          tabId,
        }),
      snapshot: (tabId) =>
        ipcRenderer.invoke(
          PreviewChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
          {
            tabId,
          }
        ),
      click: (tabId, input) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, {
          input,
          tabId,
        }),
      type: (tabId, input) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, {
          input,
          tabId,
        }),
      press: (tabId, input) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, {
          input,
          tabId,
        }),
      scroll: (tabId, input) =>
        ipcRenderer.invoke(PreviewChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL, {
          input,
          tabId,
        }),
      evaluate: (tabId, input) =>
        ipcRenderer.invoke(
          PreviewChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
          {
            input,
            tabId,
          }
        ),
      waitFor: (tabId, input) =>
        ipcRenderer.invoke(
          PreviewChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
          {
            input,
            tabId,
          }
        ),
    },
    onStateChange: (listener) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown
      ) => {
        try {
          const decoded = Schema.decodeUnknownSync(
            DesktopPreviewStateChangeEventSchema
          )([tabId, state])
          listener(decoded[0], decoded[1])
        } catch {
          // Ignore malformed main-process events at the bridge boundary.
        }
      }
      ipcRenderer.on(PreviewChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(
          PreviewChannels.PREVIEW_STATE_CHANGE_CHANNEL,
          wrapped
        )
    },
    onPointerEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
        try {
          listener(
            Schema.decodeUnknownSync(DesktopPreviewPointerEventSchema)(value)
          )
        } catch {
          // Ignore malformed main-process events at the bridge boundary.
        }
      }
      ipcRenderer.on(PreviewChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(
          PreviewChannels.PREVIEW_POINTER_EVENT_CHANNEL,
          wrapped
        )
    },
  },
} satisfies DesktopBridge)
