import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
} from "electron";
import { OperatorStatusClient } from "../operator-status/client.ts";
import { operatorStatusPaths } from "../operator-status/server.ts";
import { LABORER_VERSION } from "../version.ts";
import {
  makeBundledServiceManagementRunner,
  reconcileLaunchAgent,
  type ServiceReconciliationState,
} from "./service-management.ts";
import {
  COMPANION_CONTENT_HEIGHT_CHANNEL,
  COMPANION_QUIT_CHANNEL,
  COMPANION_RECONNECT_CHANNEL,
  COMPANION_STATUS_CHANNEL,
  type CompanionStatusView,
} from "./shared.ts";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const POPOVER_WIDTH = 380;
const POPOVER_INITIAL_HEIGHT = 400;
const POPOVER_SCREEN_GAP = 8;
const createTrayIcon = (base64: string): Electron.NativeImage => {
  // Electron 43 does not decode SVG data URLs into NativeImage instances.
  // Decode a high-resolution PNG and downsample it for a crisp menu-bar mask.
  const icon = nativeImage
    .createFromBuffer(Buffer.from(base64, "base64"))
    .resize({ height: 18, quality: "best", width: 18 });
  icon.setTemplateImage(true);
  return icon;
};

// A distinct glyph keeps a stalled daemon legible in the menu bar without
// opening the popover; template images cannot carry color on macOS.
const trayIcons = {
  attention: createTrayIcon(
    "iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAAbElEQVR42u3auwkAMAhAQfdfWmew83MP0oZwhSAkQpIkSZIkSeqVww8gQIAAAQLUB/r6DkCAAAE6BzTlDkCAAAECBAgQIECAAAECBMg2DwgQIEMaECBAgAAB8nkBECBAgAAtBJIkSZIkSdKeCpK7noxIUSMSAAAAAElFTkSuQmCC"
  ),
  nominal: createTrayIcon(
    "iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAAcElEQVR42u3asQkAMAhFQfdf2swgGDDxHtiHa36TCEmSJEmSJKlWDj9AgAABAgSoDrT1HYAAAQIE6Fegm9MNCBAgQIAAmXlAgAABAgSoZ+YBAQIECBAgMw8IEKB9QD4vAAIECBCg+UCSJEmSJEl6pwOIS+BKUAtIywAAAABJRU5ErkJggg=="
  ),
} as const;

const trayPresentation: Record<
  CompanionStatusView["state"],
  { readonly icon: Electron.NativeImage; readonly tooltip: string }
> = {
  connecting: { icon: trayIcons.nominal, tooltip: "Laborer — connecting…" },
  incompatible: {
    icon: trayIcons.attention,
    tooltip: "Laborer — update required",
  },
  reconnecting: {
    icon: trayIcons.attention,
    tooltip: "Laborer — reconnecting…",
  },
  "service-already-registered": {
    icon: trayIcons.nominal,
    tooltip: "Laborer — reconnecting to registered daemon…",
  },
  "service-denied": {
    icon: trayIcons.attention,
    tooltip: "Laborer — service permission denied",
  },
  "service-registering": {
    icon: trayIcons.nominal,
    tooltip: "Laborer — registering daemon…",
  },
  "service-registered": {
    icon: trayIcons.nominal,
    tooltip: "Laborer — daemon registered",
  },
  "service-requires-approval": {
    icon: trayIcons.attention,
    tooltip: "Laborer — service approval required",
  },
  "service-unavailable": {
    icon: trayIcons.attention,
    tooltip: "Laborer — service unavailable",
  },
  "service-version-mismatch": {
    icon: trayIcons.attention,
    tooltip: "Laborer — installation mismatch",
  },
  running: { icon: trayIcons.nominal, tooltip: "Laborer — daemon running" },
  unavailable: {
    icon: trayIcons.attention,
    tooltip: "Laborer — daemon unavailable",
  },
  "version-mismatch": {
    icon: trayIcons.attention,
    tooltip: "Laborer — daemon executable mismatch",
  },
};

const trayPresentationFor = (
  status: CompanionStatusView
): { readonly icon: Electron.NativeImage; readonly tooltip: string } => {
  if (status.state !== "running") {
    return trayPresentation[status.state];
  }
  if (
    status.receiver !== "connected" ||
    status.workspaces.some((workspace) => workspace.readiness !== "ready")
  ) {
    return {
      icon: trayIcons.attention,
      tooltip: "Laborer — workspace binding not ready",
    };
  }
  return trayPresentation.running;
};

const runtimeRoot =
  process.env.LABORER_RUNTIME_ROOT ??
  resolve(process.env.LABORER_ROOT ?? process.cwd(), ".laborer-runtime");
const statusClient = new OperatorStatusClient({
  expectedDaemonVersion: LABORER_VERSION,
  paths: operatorStatusPaths(runtimeRoot),
});
let latestStatus: CompanionStatusView = {
  state: app.isPackaged ? "service-registering" : "connecting",
  uptimeSeconds: null,
  version: null,
};
let popover: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let serviceReconciliation: Promise<void> | null = null;
let requestedPopoverHeight = POPOVER_INITIAL_HEIGHT;

const serviceStatusState = (
  state: ServiceReconciliationState
):
  | "service-already-registered"
  | "service-denied"
  | "service-registered"
  | "service-requires-approval"
  | "service-unavailable"
  | "service-version-mismatch" => `service-${state}`;

const publishStatus = (status: CompanionStatusView): void => {
  if (tray !== null) {
    const presentation = trayPresentationFor(status);
    tray.setImage(presentation.icon);
    tray.setToolTip(presentation.tooltip);
  }
  latestStatus = status;
  if (popover !== null && !popover.isDestroyed()) {
    popover.webContents.send(COMPANION_STATUS_CHANNEL, status);
  }
};

const reconcileService = (): Promise<void> => {
  if (!app.isPackaged) {
    statusClient.reconnect();
    return Promise.resolve();
  }
  if (serviceReconciliation !== null) {
    return serviceReconciliation;
  }
  publishStatus({
    state: "service-registering",
    uptimeSeconds: null,
    version: null,
  });
  serviceReconciliation = reconcileLaunchAgent(
    makeBundledServiceManagementRunner(
      resolve(process.resourcesPath, "service-management")
    )
  )
    .then((state) => {
      publishStatus({
        state: serviceStatusState(state),
        uptimeSeconds: null,
        version: null,
      });
      if (state === "already-registered" || state === "registered") {
        statusClient.start();
        return;
      }
    })
    .finally(() => {
      serviceReconciliation = null;
    });
  return serviceReconciliation;
};

const positionPopover = (): void => {
  if (popover === null || tray === null) {
    return;
  }
  const trayBounds = tray.getBounds();
  const workArea = screen.getDisplayMatching(trayBounds).workArea;
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  const idealX = Math.round(
    trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2
  );
  const minimumX = workArea.x + POPOVER_SCREEN_GAP;
  const maximumX =
    workArea.x + workArea.width - POPOVER_WIDTH - POPOVER_SCREEN_GAP;
  const x = Math.min(Math.max(idealX, minimumX), maximumX);
  const maximumHeight = Math.max(
    1,
    workArea.y + workArea.height - y - POPOVER_SCREEN_GAP
  );
  const height = Math.min(requestedPopoverHeight, maximumHeight);
  popover.setBounds({ height, width: POPOVER_WIDTH, x, y }, false);
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

// Matches the renderer background so opening the popover never flashes a
// light panel in dark appearance.
const popoverBackground = (): string =>
  nativeTheme.shouldUseDarkColors ? "#2b2825" : "#f7f7f4";

const createPopover = (): BrowserWindow => {
  const window = new BrowserWindow({
    alwaysOnTop: true,
    backgroundColor: popoverBackground(),
    frame: false,
    height: POPOVER_INITIAL_HEIGHT,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(dirname, "../preload/preload.cjs"),
      sandbox: true,
    },
    width: POPOVER_WIDTH,
  });
  window.on("blur", () => window.hide());
  nativeTheme.on("updated", () => {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(popoverBackground());
    }
  });
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
      const initialTrayPresentation = trayPresentationFor(latestStatus);
      tray = new Tray(initialTrayPresentation.icon);
      tray.setToolTip(initialTrayPresentation.tooltip);
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
      ipcMain.on(COMPANION_CONTENT_HEIGHT_CHANNEL, (event, height) => {
        if (
          event.sender !== popover?.webContents ||
          !Number.isSafeInteger(height) ||
          height < 1 ||
          height > 100_000
        ) {
          return;
        }
        requestedPopoverHeight = height;
        positionPopover();
      });
      ipcMain.handle(COMPANION_RECONNECT_CHANNEL, () => reconcileService());
      ipcMain.handle(COMPANION_QUIT_CHANNEL, () => app.quit());
      statusClient.subscribe((status) => {
        publishStatus(status);
      });
      return reconcileService();
    })
    .catch(() => app.quit());
} else {
  app.quit();
}
