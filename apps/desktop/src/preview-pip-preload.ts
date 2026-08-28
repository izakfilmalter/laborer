import type { DesktopPreviewRecordingFrame } from '@laborer/shared/desktop-bridge'
import { contextBridge, ipcRenderer } from 'electron'
import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from './preview/channels.js'

contextBridge.exposeInMainWorld('previewPictureInPicture', {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      if (typeof frame === 'object' && frame !== null) {
        listener(frame as DesktopPreviewRecordingFrame)
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
