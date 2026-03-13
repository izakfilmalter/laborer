import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron'

import { MENU_ACTION_CHANNEL } from './ipc.js'

type CreateWindowFn = () => void

// ---------------------------------------------------------------------------
// Menu action dispatch
// ---------------------------------------------------------------------------

/**
 * Send a menu action to the renderer process via IPC.
 *
 * If no window is available, one is created. If the page is still loading,
 * the action is deferred until `did-finish-load`.
 *
 * @param action — the action identifier (e.g., `"open-settings"`)
 * @param getMainWindow — callback returning the current main window
 * @param createWindowFn — factory to create a new window if none exists
 */
export function dispatchMenuAction(
  action: string,
  getMainWindow: () => BrowserWindow | null,
  createWindowFn?: () => void
): void {
  let targetWindow =
    BrowserWindow.getFocusedWindow() ??
    getMainWindow() ??
    BrowserWindow.getAllWindows()[0]

  if (!targetWindow && createWindowFn) {
    createWindowFn()
    targetWindow =
      BrowserWindow.getFocusedWindow() ??
      getMainWindow() ??
      BrowserWindow.getAllWindows()[0]
  }

  if (!targetWindow) {
    return
  }

  const send = () => {
    if (targetWindow.isDestroyed()) {
      return
    }
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action)

    if (!targetWindow.isVisible()) {
      targetWindow.show()
    }
    targetWindow.focus()
  }

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once('did-finish-load', send)
    return
  }

  send()
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

/**
 * Build and set the application menu.
 *
 * On macOS, this includes the standard app-name submenu (About, Settings,
 * Services, Hide, Quit) plus Edit, View, and Window role menus.
 *
 * On other platforms, Settings lives under the File menu.
 *
 * @param getMainWindow — callback returning the current main window
 * @param createWindowFn — optional factory to create a new window
 */
export function configureApplicationMenu(
  getMainWindow: () => BrowserWindow | null,
  createWindowFn?: CreateWindowFn
): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate(getMainWindow, createWindowFn)
    )
  )
}

export function buildApplicationMenuTemplate(
  getMainWindow: () => BrowserWindow | null,
  createWindowFn?: CreateWindowFn,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  // macOS app-name menu
  if (platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () =>
            dispatchMenuAction('open-settings', getMainWindow, createWindowFn),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  // File menu
  const fileMenu: MenuItemConstructorOptions[] = []
  const newWindowMenuItem = createNewWindowMenuItem(createWindowFn)

  if (newWindowMenuItem) {
    fileMenu.push(newWindowMenuItem, { type: 'separator' })
  }

  template.push({
    label: 'File',
    submenu: [
      ...fileMenu,
      // On non-macOS, put Settings in the File menu.
      ...(platform === 'darwin'
        ? []
        : [
            {
              label: 'Settings...',
              accelerator: 'CmdOrCtrl+,' as const,
              click: () =>
                dispatchMenuAction(
                  'open-settings',
                  getMainWindow,
                  createWindowFn
                ),
            },
            { type: 'separator' as const },
          ]),
      ...(platform === 'darwin'
        ? [
            {
              label: 'Close Pane',
              accelerator: 'CmdOrCtrl+W' as const,
              click: () =>
                dispatchMenuAction('close-pane', getMainWindow, createWindowFn),
            },
          ]
        : [{ role: 'quit' as const }]),
    ],
  })

  // Standard role menus
  template.push(
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  )

  return template
}

function createNewWindowMenuItem(
  createWindowFn?: CreateWindowFn
): MenuItemConstructorOptions | null {
  if (!createWindowFn) {
    return null
  }

  return {
    label: 'New Window',
    accelerator: 'CmdOrCtrl+N',
    click: () => createWindowFn(),
  }
}
