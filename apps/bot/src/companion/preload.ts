import { contextBridge, ipcRenderer } from 'electron'
import {
  COMPANION_CONTENT_HEIGHT_CHANNEL,
  COMPANION_QUIT_CHANNEL,
  COMPANION_RECONNECT_CHANNEL,
  COMPANION_STATUS_CHANNEL,
  isOperatorStatusView,
  type LaborerCompanionBridge,
} from './shared.ts'

const bridge: LaborerCompanionBridge = {
  quit: async () => {
    await ipcRenderer.invoke(COMPANION_QUIT_CHANNEL)
  },
  reconnect: async () => {
    await ipcRenderer.invoke(COMPANION_RECONNECT_CHANNEL)
  },
  setContentHeight: (height) => {
    ipcRenderer.send(COMPANION_CONTENT_HEIGHT_CHANNEL, height)
  },
  subscribeStatus: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      value: unknown
    ): void => {
      if (isOperatorStatusView(value)) {
        listener(value)
      }
    }
    ipcRenderer.on(COMPANION_STATUS_CHANNEL, receive)
    ipcRenderer.send(COMPANION_STATUS_CHANNEL)
    return () => ipcRenderer.off(COMPANION_STATUS_CHANNEL, receive)
  },
}

contextBridge.exposeInMainWorld('laborerCompanion', bridge)
