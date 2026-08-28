import {
  type DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingFrameSchema,
} from '@laborer/shared/desktop-bridge'
import { Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from './preview/channels.js'

contextBridge.exposeInMainWorld('previewPictureInPicture', {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      try {
        listener(
          Schema.decodeUnknownSync(DesktopPreviewRecordingFrameSchema)(frame)
        )
      } catch {
        // Ignore malformed main-process events at the bridge boundary.
      }
    }
    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrapped)
    return () =>
      ipcRenderer.removeListener(
        PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
        wrapped
      )
  },
})
