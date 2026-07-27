import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import {
  OperatorStatusClient,
  type OperatorStatusView,
} from "../operator-status/client.ts";
import { operatorStatusPaths } from "../operator-status/server.ts";
import {
  COMPANION_RECONNECT_CHANNEL,
  COMPANION_STATUS_CHANNEL,
} from "./shared.ts";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const POPOVER_WIDTH = 380;
const POPOVER_HEIGHT = 430;
const trayIcon = nativeImage.createFromDataURL(
  "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 4.5h10v9H4zM6.5 7h5M6.5 10h3"/></svg>'
    )
);
trayIcon.setTemplateImage(true);

const runtimeRoot =
  process.env.LABORER_RUNTIME_ROOT ??
  resolve(process.cwd(), ".laborer-runtime");
const statusClient = new OperatorStatusClient({
  paths: operatorStatusPaths(runtimeRoot),
});
let latestStatus: OperatorStatusView = {
  state: "connecting",
  uptimeSeconds: null,
  version: null,
};
let popover: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const positionPopover = (): void => {
  if (popover === null || tray === null) {
    return;
  }
  const trayBounds = tray.getBounds();
  const displayBounds = popover.getBounds();
  popover.setPosition(
    Math.round(trayBounds.x + trayBounds.width / 2 - displayBounds.width / 2),
    Math.round(trayBounds.y + trayBounds.height + 4),
    false
  );
};

const togglePopover = (): void => {
  if (popover === null) {
    return;
  }
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  positionPopover();
  popover.show();
  popover.focus();
};

const createPopover = (): BrowserWindow => {
  const window = new BrowserWindow({
    alwaysOnTop: true,
    backgroundColor: "#f7f7f4",
    frame: false,
    height: POPOVER_HEIGHT,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(dirname, "../preload/preload.mjs"),
      sandbox: true,
    },
    width: POPOVER_WIDTH,
  });
  window.on("blur", () => window.hide());
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      window.hide();
    }
  });
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  const quitAfterLoadFailure = (): void => app.quit();
  if (process.env.ELECTRON_RENDERER_URL) {
    window
      .loadURL(process.env.ELECTRON_RENDERER_URL)
      .catch(quitAfterLoadFailure);
  } else {
    window
      .loadFile(resolve(dirname, "../renderer/index.html"))
      .catch(quitAfterLoadFailure);
  }
  return window;
};

if (app.requestSingleInstanceLock()) {
  app.on("before-quit", () => {
    isQuitting = true;
    statusClient.close();
  });
  app.on("window-all-closed", () => undefined);
  app.on("second-instance", () => togglePopover());

  app
    .whenReady()
    .then(() => {
      if (process.platform === "darwin") {
        app.dock?.hide();
      }
      popover = createPopover();
      tray = new Tray(trayIcon);
      tray.setToolTip("Laborer");
      tray.on("click", togglePopover);
      tray.on("right-click", () => {
        Menu.buildFromTemplate([
          { click: togglePopover, label: "Show Laborer" },
          { type: "separator" },
          { role: "quit" },
        ]).popup();
      });

      ipcMain.on(COMPANION_STATUS_CHANNEL, (event) => {
        event.sender.send(COMPANION_STATUS_CHANNEL, latestStatus);
      });
      ipcMain.handle(COMPANION_RECONNECT_CHANNEL, () =>
        statusClient.reconnect()
      );
      statusClient.subscribe((status) => {
        latestStatus = status;
        if (popover !== null && !popover.isDestroyed()) {
          popover.webContents.send(COMPANION_STATUS_CHANNEL, status);
        }
      });
      statusClient.start();
    })
    .catch(() => app.quit());
} else {
  app.quit();
}
