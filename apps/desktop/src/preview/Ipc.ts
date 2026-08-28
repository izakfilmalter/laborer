// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import {
  PreviewArtifactRequestSchema,
  PreviewAutomationClickRequestSchema,
  PreviewAutomationEvaluateRequestSchema,
  PreviewAutomationPressRequestSchema,
  PreviewAutomationScrollRequestSchema,
  PreviewAutomationTypeRequestSchema,
  PreviewAutomationWaitForRequestSchema,
  PreviewCreateTabRequestSchema,
  PreviewEmptyRequestSchema,
  PreviewGetConfigRequestSchema,
  PreviewIpcDecodeError,
  PreviewNavigateRequestSchema,
  PreviewRecordingSaveRequestSchema,
  PreviewRegisterWebviewRequestSchema,
  PreviewSetAnnotationThemeRequestSchema,
  PreviewSetAudioMutedRequestSchema,
  PreviewSetColorSchemeRequestSchema,
  PreviewTabRequestSchema,
} from '@laborer/shared/desktop-bridge'
import { Schema } from 'effect'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
// biome-ignore lint/performance/noNamespaceImport: keeps the preview channel registry auditable.
import * as PreviewChannels from './channels.js'
import type { PreviewManager } from './Manager.js'

function decode<S extends Schema.ConstraintDecoder<unknown>>(
  channel: string,
  schema: S,
  payload: unknown
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema)(payload)
  } catch {
    throw PreviewIpcDecodeError.make({
      channel,
      message: `Invalid payload for ${channel}`,
    })
  }
}

function owner(event: Electron.IpcMainInvokeEvent): WebContents {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    throw PreviewIpcDecodeError.make({
      channel: 'sender',
      message: 'Preview IPC must come from a Laborer renderer window',
    })
  }
  return event.sender
}

export function registerPreviewIpcHandlers(manager: PreviewManager): void {
  const handle = (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown
  ) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }
  const tabMethod = (
    channel: string,
    method: (requestOwner: WebContents, tabId: string) => unknown
  ) => {
    handle(channel, (event, payload) => {
      const request = decode(channel, PreviewTabRequestSchema, payload)
      return method(owner(event), request.tabId)
    })
  }
  const emptyMethod = (
    channel: string,
    method: (requestOwner: WebContents) => unknown
  ) => {
    handle(channel, (event, payload) => {
      decode(channel, PreviewEmptyRequestSchema, payload)
      return method(owner(event))
    })
  }

  handle(PreviewChannels.PREVIEW_CREATE_TAB_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_CREATE_TAB_CHANNEL,
      PreviewCreateTabRequestSchema,
      payload
    )
    return manager.createTab(owner(event), request.tabId, {
      ...(request.colorScheme === undefined
        ? {}
        : { colorScheme: request.colorScheme }),
      ...(request.zoomFactor === undefined
        ? {}
        : { zoomFactor: request.zoomFactor }),
    })
  })
  tabMethod(PreviewChannels.PREVIEW_CLOSE_TAB_CHANNEL, (requestOwner, tabId) =>
    manager.closeTab(requestOwner, tabId)
  )
  handle(PreviewChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
      PreviewRegisterWebviewRequestSchema,
      payload
    )
    return manager.registerWebview(
      owner(event),
      request.tabId,
      request.webContentsId
    )
  })
  handle(PreviewChannels.PREVIEW_NAVIGATE_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_NAVIGATE_CHANNEL,
      PreviewNavigateRequestSchema,
      payload
    )
    return manager.navigate(owner(event), request.tabId, request.url)
  })
  tabMethod(PreviewChannels.PREVIEW_GO_BACK_CHANNEL, (requestOwner, tabId) =>
    manager.goBack(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_GO_FORWARD_CHANNEL, (requestOwner, tabId) =>
    manager.goForward(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_REFRESH_CHANNEL, (requestOwner, tabId) =>
    manager.refresh(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_STOP_CHANNEL, (requestOwner, tabId) =>
    manager.stop(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_HARD_RELOAD_CHANNEL,
    (requestOwner, tabId) => manager.hardReload(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_ZOOM_IN_CHANNEL, (requestOwner, tabId) =>
    manager.zoomIn(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_ZOOM_OUT_CHANNEL, (requestOwner, tabId) =>
    manager.zoomOut(requestOwner, tabId)
  )
  tabMethod(PreviewChannels.PREVIEW_RESET_ZOOM_CHANNEL, (requestOwner, tabId) =>
    manager.resetZoom(requestOwner, tabId)
  )
  handle(PreviewChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
      PreviewSetColorSchemeRequestSchema,
      payload
    )
    return manager.setColorScheme(
      owner(event),
      request.tabId,
      request.colorScheme
    )
  })
  handle(PreviewChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
      PreviewSetAudioMutedRequestSchema,
      payload
    )
    return manager.setAudioMuted(
      owner(event),
      request.tabId,
      request.audioMuted
    )
  })
  tabMethod(
    PreviewChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
    (requestOwner, tabId) => manager.openDevTools(requestOwner, tabId)
  )
  emptyMethod(PreviewChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, () =>
    manager.clearCookies()
  )
  emptyMethod(PreviewChannels.PREVIEW_CLEAR_CACHE_CHANNEL, () =>
    manager.clearCache()
  )
  handle(PreviewChannels.PREVIEW_GET_CONFIG_CHANNEL, (event, payload) => {
    owner(event)
    const request = decode(
      PreviewChannels.PREVIEW_GET_CONFIG_CHANNEL,
      PreviewGetConfigRequestSchema,
      payload
    )
    manager.getBrowserSession(request.environmentId)
    return {
      partition: manager.getBrowserPartition(request.environmentId),
      preloadUrl: manager.pickPreloadUrl,
      webPreferences: manager.webviewPreferences,
    }
  })
  handle(
    PreviewChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
    (event, payload) => {
      owner(event)
      const request = decode(
        PreviewChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
        PreviewSetAnnotationThemeRequestSchema,
        payload
      )
      manager.setAnnotationTheme(request.theme)
    }
  )
  tabMethod(
    PreviewChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
    (requestOwner, tabId) => manager.pickElement(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
    (requestOwner, tabId) => manager.cancelPickElement(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
    (requestOwner, tabId) => manager.captureScreenshot(requestOwner, tabId)
  )
  handle(PreviewChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, (event, payload) => {
    owner(event)
    const request = decode(
      PreviewChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
      PreviewArtifactRequestSchema,
      payload
    )
    return manager.revealArtifact(request.path)
  })
  handle(PreviewChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, (event, payload) => {
    owner(event)
    const request = decode(
      PreviewChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
      PreviewArtifactRequestSchema,
      payload
    )
    return manager.copyArtifactToClipboard(request.path)
  })
  tabMethod(
    PreviewChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
    (requestOwner, tabId) => manager.openPictureInPicture(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
    (requestOwner, tabId) => manager.closePictureInPicture(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_RECORDING_START_CHANNEL,
    (requestOwner, tabId) => manager.startRecording(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_RECORDING_STOP_CHANNEL,
    (requestOwner, tabId) => manager.stopRecording(requestOwner, tabId)
  )
  handle(PreviewChannels.PREVIEW_RECORDING_SAVE_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
      PreviewRecordingSaveRequestSchema,
      payload
    )
    return manager.saveRecording(
      owner(event),
      request.tabId,
      request.mimeType,
      request.data
    )
  })
  tabMethod(
    PreviewChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
    (requestOwner, tabId) => manager.automationStatus(requestOwner, tabId)
  )
  tabMethod(
    PreviewChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
    (requestOwner, tabId) => manager.automationSnapshot(requestOwner, tabId)
  )

  handle(PreviewChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
      PreviewAutomationClickRequestSchema,
      payload
    )
    return manager.automationClick(owner(event), request.tabId, request.input)
  })
  handle(PreviewChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
      PreviewAutomationTypeRequestSchema,
      payload
    )
    return manager.automationType(owner(event), request.tabId, request.input)
  })
  handle(PreviewChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, (event, payload) => {
    const request = decode(
      PreviewChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
      PreviewAutomationPressRequestSchema,
      payload
    )
    return manager.automationPress(owner(event), request.tabId, request.input)
  })
  handle(
    PreviewChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
    (event, payload) => {
      const request = decode(
        PreviewChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
        PreviewAutomationScrollRequestSchema,
        payload
      )
      return manager.automationScroll(
        owner(event),
        request.tabId,
        request.input
      )
    }
  )
  handle(
    PreviewChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
    (event, payload) => {
      const request = decode(
        PreviewChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
        PreviewAutomationEvaluateRequestSchema,
        payload
      )
      return manager.automationEvaluate(
        owner(event),
        request.tabId,
        request.input
      )
    }
  )
  handle(
    PreviewChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
    (event, payload) => {
      const request = decode(
        PreviewChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
        PreviewAutomationWaitForRequestSchema,
        payload
      )
      return manager.automationWaitFor(
        owner(event),
        request.tabId,
        request.input
      )
    }
  )
}
