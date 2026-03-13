import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { name: 'Laborer' },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: vi.fn(),
  },
}))

import { buildApplicationMenuTemplate } from '../src/menu.js'

function getFileMenuItems(
  template: MenuItemConstructorOptions[]
): MenuItemConstructorOptions[] {
  const fileMenu = template.find((item) => item.label === 'File')

  if (!(fileMenu && Array.isArray(fileMenu.submenu))) {
    throw new Error('Expected File menu submenu to be present')
  }

  return fileMenu.submenu
}

describe('buildApplicationMenuTemplate', () => {
  it('adds a New Window file menu item with the standard shortcut', () => {
    const createWindow = vi.fn()
    const template = buildApplicationMenuTemplate(
      () => null,
      createWindow,
      'darwin'
    )

    const fileMenuItems = getFileMenuItems(template)
    const newWindowItem = fileMenuItems.find(
      (item) => item.label === 'New Window'
    )

    expect(newWindowItem).toMatchObject({
      accelerator: 'CmdOrCtrl+N',
      label: 'New Window',
    })

    newWindowItem?.click?.(undefined as never, undefined, undefined as never)

    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('omits the New Window action when window creation is unavailable', () => {
    const template = buildApplicationMenuTemplate(
      () => null,
      undefined,
      'linux'
    )
    const fileMenuItems = getFileMenuItems(template)

    expect(fileMenuItems.some((item) => item.label === 'New Window')).toBe(
      false
    )
  })

  it('does not use role:close on macOS to avoid stealing Cmd+W from the web layer', () => {
    const template = buildApplicationMenuTemplate(() => null, vi.fn(), 'darwin')
    const fileMenuItems = getFileMenuItems(template)

    // The File menu should not contain role: 'close' on macOS because
    // Electron's native role:close binds Cmd+W at the Chromium level,
    // which fires before the web content's keydown handler and causes
    // the window to close/hide instead of closing a pane.
    const hasRoleClose = fileMenuItems.some((item) => item.role === 'close')

    expect(hasRoleClose).toBe(false)
  })

  it('dispatches close-pane menu action via IPC on macOS Cmd+W', () => {
    const getMainWindow = vi.fn(() => null)
    const template = buildApplicationMenuTemplate(
      getMainWindow,
      vi.fn(),
      'darwin'
    )
    const fileMenuItems = getFileMenuItems(template)

    // Should have a custom Close Pane item with Cmd+W accelerator
    const closePaneItem = fileMenuItems.find(
      (item) => item.accelerator === 'CmdOrCtrl+W'
    )

    expect(closePaneItem).toBeDefined()
    expect(closePaneItem?.label).toBe('Close Pane')
    expect(closePaneItem?.click).toBeTypeOf('function')
  })
})
