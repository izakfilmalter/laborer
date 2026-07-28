import { contextBridge, ipcRenderer } from "electron";
import {
  COMPANION_QUIT_CHANNEL,
  COMPANION_RECONNECT_CHANNEL,
  COMPANION_STATUS_CHANNEL,
  isOperatorStatusView,
  type LaborerCompanionBridge,
} from "./shared.ts";

const bridge: LaborerCompanionBridge = {
  quit: async () => {
    await ipcRenderer.invoke(COMPANION_QUIT_CHANNEL);
  },
  reconnect: async () => {
    await ipcRenderer.invoke(COMPANION_RECONNECT_CHANNEL);
  },
  subscribeStatus: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      value: unknown
    ): void => {
      if (isOperatorStatusView(value)) {
        listener(value);
      }
    };
    ipcRenderer.on(COMPANION_STATUS_CHANNEL, receive);
    ipcRenderer.send(COMPANION_STATUS_CHANNEL);
    return () => ipcRenderer.off(COMPANION_STATUS_CHANNEL, receive);
  },
};

contextBridge.exposeInMainWorld("laborerCompanion", bridge);
