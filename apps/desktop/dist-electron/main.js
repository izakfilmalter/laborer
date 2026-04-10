let node_fs = require("node:fs");
let node_path = require("node:path");
let electron = require("electron");

//#region src/main.ts
const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const DESKTOP_SCHEME = "laborer";
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "Laborer (Dev)" : "Laborer";
const APP_USER_MODEL_ID = "com.izakfilmalter.laborer";
const USER_DATA_DIR_NAME = isDevelopment ? "laborer-dev" : "laborer";
const LEADING_SLASHES = /^\/+/;
let mainWindow = null;
let desktopProtocolRegistered = false;
const resolveRuntimeArch = () => {
	if (process.arch === "arm64") return "arm64";
	if (process.arch === "x64") return "x64";
	return "other";
};
electron.protocol.registerSchemesAsPrivileged([{
	scheme: DESKTOP_SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true
	}
}]);
const createDisabledUpdateState = (currentVersion) => {
	const runtimeArch = resolveRuntimeArch();
	return {
		enabled: false,
		status: "disabled",
		currentVersion,
		hostArch: runtimeArch,
		appArch: runtimeArch,
		runningUnderArm64Translation: false,
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt: null,
		message: "Automatic updates are not configured for this app yet.",
		errorContext: null,
		canRetry: false
	};
};
let updateState = createDisabledUpdateState(electron.app.getVersion());
const emitUpdateState = () => {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(UPDATE_STATE_CHANNEL, updateState);
};
const formatErrorMessage = (error) => {
	if (error instanceof Error) return error.message;
	return String(error);
};
const getSafeExternalUrl = (rawUrl) => {
	if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
	let parsedUrl;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		return null;
	}
	if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return null;
	return parsedUrl.toString();
};
const getSafeTheme = (rawTheme) => {
	if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") return rawTheme;
	return null;
};
const resolveDesktopStaticDir = () => {
	const repoRoot = (0, node_path.resolve)(electron.app.getAppPath(), "../..");
	const candidates = electron.app.isPackaged ? [(0, node_path.join)(process.resourcesPath, "web")] : [(0, node_path.join)(repoRoot, "apps/web/dist")];
	for (const candidate of candidates) if ((0, node_fs.existsSync)((0, node_path.join)(candidate, "index.html"))) return candidate;
	return null;
};
const resolveDesktopStaticPath = (staticRoot, requestUrl) => {
	const url = new URL(requestUrl);
	const rawPath = decodeURIComponent(url.pathname);
	const normalizedPath = node_path.posix.normalize(rawPath).replace(LEADING_SLASHES, "");
	if (normalizedPath.includes("..")) return (0, node_path.join)(staticRoot, "index.html");
	const resolvedPath = (0, node_path.join)(staticRoot, normalizedPath.length > 0 ? normalizedPath : "index.html");
	if ((0, node_path.extname)(resolvedPath)) return resolvedPath;
	const nestedIndex = (0, node_path.join)(resolvedPath, "index.html");
	if ((0, node_fs.existsSync)(nestedIndex)) return nestedIndex;
	return (0, node_path.join)(staticRoot, "index.html");
};
const isStaticAssetRequest = (requestUrl) => {
	try {
		return (0, node_path.extname)(new URL(requestUrl).pathname).length > 0;
	} catch {
		return false;
	}
};
const registerDesktopProtocol = () => {
	if (isDevelopment || desktopProtocolRegistered) return;
	const staticRoot = resolveDesktopStaticDir();
	if (!staticRoot) throw new Error("Desktop static bundle missing. Build apps/web before starting Electron.");
	const staticRootResolved = (0, node_path.resolve)(staticRoot);
	const staticRootPrefix = `${staticRootResolved}${node_path.sep}`;
	const fallbackIndex = (0, node_path.join)(staticRootResolved, "index.html");
	electron.protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
		try {
			const resolvedCandidate = (0, node_path.resolve)(resolveDesktopStaticPath(staticRootResolved, request.url));
			const isInRoot = resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
			const isAsset = isStaticAssetRequest(request.url);
			const candidateExists = (0, node_fs.existsSync)(resolvedCandidate);
			if (!(isInRoot && candidateExists)) {
				if (isAsset) {
					callback({ error: -6 });
					return;
				}
				callback({ path: fallbackIndex });
				return;
			}
			callback({ path: resolvedCandidate });
		} catch {
			callback({ path: fallbackIndex });
		}
	});
	desktopProtocolRegistered = true;
};
const dispatchMenuAction = (action) => {
	const window = electron.BrowserWindow.getFocusedWindow() ?? mainWindow ?? electron.BrowserWindow.getAllWindows()[0];
	if (!window || window.isDestroyed()) return;
	window.webContents.send(MENU_ACTION_CHANNEL, action);
};
const buildAppMenu = () => {
	const isMac = process.platform === "darwin";
	const template = [];
	if (isMac) template.push({
		label: APP_DISPLAY_NAME,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "quit" }
		]
	});
	const closeWindowMenu = isMac ? { role: "close" } : { role: "quit" };
	template.push({
		label: "File",
		submenu: [
			{
				label: "New Thread",
				accelerator: "CmdOrCtrl+N",
				click: () => dispatchMenuAction("thread:new")
			},
			{ type: "separator" },
			closeWindowMenu
		]
	});
	const windowSubmenu = isMac ? [
		{ role: "minimize" },
		{ role: "zoom" },
		{ role: "front" }
	] : [{ role: "minimize" }];
	template.push({
		label: "View",
		submenu: [
			{ role: "reload" },
			{ role: "forceReload" },
			{ role: "toggleDevTools" },
			{ type: "separator" },
			{ role: "resetZoom" },
			{ role: "zoomIn" },
			{ role: "zoomOut" },
			{ type: "separator" },
			{ role: "togglefullscreen" }
		]
	});
	template.push({
		label: "Window",
		submenu: windowSubmenu
	});
	return electron.Menu.buildFromTemplate(template);
};
const registerIpcHandlers = () => {
	electron.ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
	electron.ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
		event.returnValue = null;
	});
	electron.ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
	electron.ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
		const owner = electron.BrowserWindow.getFocusedWindow() ?? mainWindow ?? void 0;
		const result = owner ? await electron.dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] }) : await electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
		if (result.canceled) return null;
		return result.filePaths[0] ?? null;
	});
	electron.ipcMain.removeHandler(CONFIRM_CHANNEL);
	electron.ipcMain.handle(CONFIRM_CHANNEL, async (_event, message) => {
		if (typeof message !== "string" || message.length === 0) return false;
		const owner = electron.BrowserWindow.getFocusedWindow() ?? mainWindow ?? void 0;
		return (owner ? await electron.dialog.showMessageBox(owner, {
			type: "question",
			buttons: ["Cancel", "OK"],
			defaultId: 1,
			cancelId: 0,
			message
		}) : await electron.dialog.showMessageBox({
			type: "question",
			buttons: ["Cancel", "OK"],
			defaultId: 1,
			cancelId: 0,
			message
		})).response === 1;
	});
	electron.ipcMain.removeHandler(SET_THEME_CHANNEL);
	electron.ipcMain.handle(SET_THEME_CHANNEL, (_event, rawTheme) => {
		const theme = getSafeTheme(rawTheme);
		if (!theme) return;
		electron.nativeTheme.themeSource = theme;
	});
	electron.ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
	electron.ipcMain.handle(CONTEXT_MENU_CHANNEL, (_event, items, position) => {
		const normalizedItems = items.filter((item) => typeof item.id === "string" && typeof item.label === "string").map((item) => ({
			id: item.id,
			label: item.label,
			destructive: item.destructive === true,
			disabled: item.disabled === true
		}));
		if (normalizedItems.length === 0) return null;
		const popupPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 ? {
			x: Math.floor(position.x),
			y: Math.floor(position.y)
		} : null;
		const window = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
		if (!window) return null;
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const template = [];
			let hasInsertedDestructiveSeparator = false;
			for (const item of normalizedItems) {
				if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
					template.push({ type: "separator" });
					hasInsertedDestructiveSeparator = true;
				}
				template.push({
					label: item.label,
					enabled: !item.disabled,
					click: () => finish(item.id)
				});
			}
			electron.Menu.buildFromTemplate(template).popup({
				window,
				...popupPosition,
				callback: () => finish(null)
			});
		});
	});
	electron.ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
	electron.ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl) => {
		const externalUrl = getSafeExternalUrl(rawUrl);
		if (!externalUrl) return false;
		try {
			await electron.shell.openExternal(externalUrl);
			return true;
		} catch {
			return false;
		}
	});
	electron.ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
	electron.ipcMain.handle(UPDATE_GET_STATE_CHANNEL, () => updateState);
	electron.ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
	electron.ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, () => {
		updateState = {
			...updateState,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		emitUpdateState();
		return {
			accepted: false,
			completed: false,
			state: updateState
		};
	});
	electron.ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
	electron.ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => ({
		accepted: false,
		completed: false,
		state: updateState
	}));
	electron.ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
	electron.ipcMain.handle(UPDATE_CHECK_CHANNEL, () => {
		updateState = {
			...updateState,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		emitUpdateState();
		return {
			checked: false,
			state: updateState
		};
	});
};
const createWindow = () => {
	const window = new electron.BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 840,
		minHeight: 620,
		show: false,
		autoHideMenuBar: true,
		title: APP_DISPLAY_NAME,
		...process.platform === "darwin" ? {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 16,
				y: 18
			}
		} : {},
		webPreferences: {
			preload: (0, node_path.join)(electron.app.getAppPath(), "dist-electron/preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.webContents.on("context-menu", (event, params) => {
		event.preventDefault();
		const menuTemplate = [
			{
				role: "cut",
				enabled: params.editFlags.canCut
			},
			{
				role: "copy",
				enabled: params.editFlags.canCopy
			},
			{
				role: "paste",
				enabled: params.editFlags.canPaste
			},
			{
				role: "selectAll",
				enabled: params.editFlags.canSelectAll
			}
		];
		electron.Menu.buildFromTemplate(menuTemplate).popup({ window });
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		const externalUrl = getSafeExternalUrl(url);
		if (externalUrl) electron.shell.openExternal(externalUrl).catch(() => void 0);
		return { action: "deny" };
	});
	window.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(APP_DISPLAY_NAME);
	});
	window.webContents.on("did-finish-load", () => {
		window.setTitle(APP_DISPLAY_NAME);
		emitUpdateState();
	});
	window.once("ready-to-show", () => {
		window.show();
	});
	if (isDevelopment) {
		window.loadURL(process.env.VITE_DEV_SERVER_URL).catch((error) => {
			electron.dialog.showErrorBox("Laborer failed to load", formatErrorMessage(error));
		});
		window.webContents.openDevTools({ mode: "detach" });
	} else window.loadURL(`${DESKTOP_SCHEME}://app/index.html`).catch((error) => {
		electron.dialog.showErrorBox("Laborer failed to load", formatErrorMessage(error));
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});
	return window;
};
const bootstrap = () => {
	registerDesktopProtocol();
	registerIpcHandlers();
	electron.Menu.setApplicationMenu(buildAppMenu());
	mainWindow = createWindow();
};
electron.app.setAppUserModelId(APP_USER_MODEL_ID);
electron.app.setPath("userData", (0, node_path.join)(electron.app.getPath("appData"), USER_DATA_DIR_NAME));
electron.app.whenReady().then(bootstrap).catch((error) => {
	const message = formatErrorMessage(error);
	electron.dialog.showErrorBox("Laborer failed to start", message);
	electron.app.quit();
});
electron.app.on("activate", () => {
	if (electron.BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
});
electron.app.on("window-all-closed", () => {
	if (process.platform !== "darwin") electron.app.quit();
});

//#endregion
//# sourceMappingURL=main.js.map