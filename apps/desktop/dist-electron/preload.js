let electron = require("electron");

//#region src/preload.ts
const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
electron.contextBridge.exposeInMainWorld("desktopBridge", {
	getWsUrl: () => {
		const result = electron.ipcRenderer.sendSync(GET_WS_URL_CHANNEL);
		return typeof result === "string" ? result : null;
	},
	pickFolder: () => electron.ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
	confirm: (message) => electron.ipcRenderer.invoke(CONFIRM_CHANNEL, message),
	setTheme: (theme) => electron.ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
	showContextMenu: (items, position) => electron.ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
	openExternal: (url) => electron.ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
	onMenuAction: (listener) => {
		const wrappedListener = (_event, action) => {
			if (typeof action !== "string") return;
			listener(action);
		};
		electron.ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
		return () => {
			electron.ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
		};
	},
	getUpdateState: () => electron.ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
	checkForUpdate: () => electron.ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
	downloadUpdate: () => electron.ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
	installUpdate: () => electron.ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
	onUpdateState: (listener) => {
		const wrappedListener = (_event, state) => {
			if (typeof state !== "object" || state === null) return;
			listener(state);
		};
		electron.ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
		return () => {
			electron.ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
		};
	}
});

//#endregion
//# sourceMappingURL=preload.js.map