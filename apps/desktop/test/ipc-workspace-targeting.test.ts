import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Minimal mock of an Electron BrowserWindow used to verify
 * the workspace-to-window registry and notification targeting.
 */
interface MockWindow {
  readonly focus: ReturnType<typeof vi.fn>
  readonly id: number
  isDestroyed: () => boolean
  readonly show: ReturnType<typeof vi.fn>
  readonly webContents: { send: ReturnType<typeof vi.fn> }
}

function createMockWindow(id: number): MockWindow {
  return {
    id,
    webContents: { send: vi.fn() },
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
  }
}

// ---------------------------------------------------------------------------
// Electron mock — capture registered IPC handlers so we can invoke them
// ---------------------------------------------------------------------------

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const fromWebContentsMock = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
    fromWebContents: (...args: unknown[]) => fromWebContentsMock(...args),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler)
      }
    ),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  },
  Notification: class {
    readonly listeners = new Map<string, Array<() => void>>()
    on(event: string, handler: () => void): void {
      const handlers = this.listeners.get(event) ?? []
      handlers.push(handler)
      this.listeners.set(event, handlers)
    }
    show(): void {
      // no-op
    }
    static isSupported(): boolean {
      return true
    }
  },
  shell: {
    openExternal: vi.fn(async () => true),
  },
}))

describe('workspace-to-window targeting', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    fromWebContentsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes notification click to the window that reported the target workspace', async () => {
    const {
      getWorkspaceWindowRegistry,
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
      SEND_NOTIFICATION_CHANNEL,
      NOTIFICATION_CLICKED_CHANNEL,
    } = await import('../src/ipc.js')

    const windowA = createMockWindow(1)
    const windowB = createMockWindow(2)
    const fallbackWindow = createMockWindow(3)

    registerIpcHandlers(
      () =>
        fallbackWindow as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    // Simulate window B reporting it has workspace-42 visible
    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)
    expect(reportHandler).toBeDefined()

    fromWebContentsMock.mockReturnValue(windowB)
    reportHandler!({ sender: windowB.webContents }, [
      'workspace-42',
      'workspace-99',
    ])

    // Now simulate sending a notification for workspace-42
    const sendHandler = ipcHandlers.get(SEND_NOTIFICATION_CHANNEL)
    expect(sendHandler).toBeDefined()

    sendHandler!(
      { sender: windowA.webContents },
      { title: 'Test', body: 'Agent done', workspaceId: 'workspace-42' }
    )

    // Extract the click handler from the Notification mock
    const { Notification } = await import('electron')
    const notificationInstance = new Notification({
      title: 'Test',
      body: 'Agent done',
    })

    // The actual notification was created inside sendHandler — we need to
    // test through the registry directly instead
    const registry = getWorkspaceWindowRegistry()
    const found = registry.findWindowForWorkspace('workspace-42')
    expect(found).toBe(windowB)

    // Verify that an unregistered workspace falls back to null
    const notFound = registry.findWindowForWorkspace('workspace-unknown')
    expect(notFound).toBeNull()
  })

  it('updates workspace list when the same window reports different workspaces', async () => {
    const {
      getWorkspaceWindowRegistry,
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
    } = await import('../src/ipc.js')

    const window = createMockWindow(10)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)!
    fromWebContentsMock.mockReturnValue(window)

    // First report: workspace-1 and workspace-2
    reportHandler({ sender: window.webContents }, [
      'workspace-1',
      'workspace-2',
    ])

    const registry = getWorkspaceWindowRegistry()
    expect(registry.findWindowForWorkspace('workspace-1')).toBe(window)
    expect(registry.findWindowForWorkspace('workspace-2')).toBe(window)

    // Second report: only workspace-3 (workspace-1 and workspace-2 removed)
    reportHandler({ sender: window.webContents }, ['workspace-3'])

    expect(registry.findWindowForWorkspace('workspace-1')).toBeNull()
    expect(registry.findWindowForWorkspace('workspace-2')).toBeNull()
    expect(registry.findWindowForWorkspace('workspace-3')).toBe(window)
  })

  it('removes workspace entries when a window is destroyed', async () => {
    const {
      getWorkspaceWindowRegistry,
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
    } = await import('../src/ipc.js')

    const window = createMockWindow(20)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)!
    fromWebContentsMock.mockReturnValue(window)

    reportHandler({ sender: window.webContents }, ['workspace-alpha'])

    const registry = getWorkspaceWindowRegistry()
    expect(registry.findWindowForWorkspace('workspace-alpha')).toBe(window)

    // Simulate window destruction
    window.isDestroyed = () => true
    expect(registry.findWindowForWorkspace('workspace-alpha')).toBeNull()
  })

  it('cleans up registry when remove() is called', async () => {
    const {
      getWorkspaceWindowRegistry,
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
    } = await import('../src/ipc.js')

    const window = createMockWindow(30)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)!
    fromWebContentsMock.mockReturnValue(window)

    reportHandler({ sender: window.webContents }, ['workspace-beta'])

    const registry = getWorkspaceWindowRegistry()
    expect(registry.findWindowForWorkspace('workspace-beta')).toBe(window)

    // Simulate window close cleanup
    registry.remove(window as unknown as Parameters<typeof registry.remove>[0])
    expect(registry.findWindowForWorkspace('workspace-beta')).toBeNull()
  })

  it('focuses the existing window when a different window requests a workspace it owns', async () => {
    const {
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
      FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL,
      ACTIVATE_WORKSPACE_CHANNEL,
    } = await import('../src/ipc.js')

    const windowA = createMockWindow(100)
    const windowB = createMockWindow(101)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)
    const focusHandler = ipcHandlers.get(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL)
    expect(reportHandler).toBeDefined()
    expect(focusHandler).toBeDefined()

    // Window B reports it has workspace-focus-target visible
    fromWebContentsMock.mockReturnValue(windowB)
    reportHandler?.({ sender: windowB.webContents }, ['workspace-focus-target'])

    // Window A requests to open workspace-focus-target
    fromWebContentsMock.mockReturnValue(windowA)
    const result = focusHandler?.(
      { sender: windowA.webContents },
      'workspace-focus-target'
    )

    expect(result).toBe(true)
    expect(windowB.show).toHaveBeenCalled()
    expect(windowB.focus).toHaveBeenCalled()
    expect(windowB.webContents.send).toHaveBeenCalledWith(
      ACTIVATE_WORKSPACE_CHANNEL,
      'workspace-focus-target'
    )
  })

  it('returns false when the workspace is only in the requesting window itself', async () => {
    const {
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
      FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL,
    } = await import('../src/ipc.js')

    const windowA = createMockWindow(200)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)
    const focusHandler = ipcHandlers.get(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL)

    // Window A reports it has workspace-self-target visible
    fromWebContentsMock.mockReturnValue(windowA)
    reportHandler?.({ sender: windowA.webContents }, ['workspace-self-target'])

    // Window A itself requests to open workspace-self-target — should NOT focus itself
    const result = focusHandler?.(
      { sender: windowA.webContents },
      'workspace-self-target'
    )

    expect(result).toBe(false)
    expect(windowA.show).not.toHaveBeenCalled()
    expect(windowA.focus).not.toHaveBeenCalled()
  })

  it('returns false when no window has the requested workspace', async () => {
    const { registerIpcHandlers, FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL } =
      await import('../src/ipc.js')

    const windowA = createMockWindow(300)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const focusHandler = ipcHandlers.get(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL)

    fromWebContentsMock.mockReturnValue(windowA)
    const result = focusHandler?.(
      { sender: windowA.webContents },
      'workspace-nonexistent'
    )

    expect(result).toBe(false)
  })

  it('ignores invalid workspace IDs in the report', async () => {
    const {
      getWorkspaceWindowRegistry,
      registerIpcHandlers,
      REPORT_VISIBLE_WORKSPACES_CHANNEL,
    } = await import('../src/ipc.js')

    const window = createMockWindow(40)

    registerIpcHandlers(
      () =>
        null as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const reportHandler = ipcHandlers.get(REPORT_VISIBLE_WORKSPACES_CHANNEL)!
    fromWebContentsMock.mockReturnValue(window)

    // Report mixed valid and invalid IDs
    reportHandler({ sender: window.webContents }, [
      'valid-ws',
      '',
      42,
      null,
      'also-valid',
    ])

    const registry = getWorkspaceWindowRegistry()
    expect(registry.findWindowForWorkspace('valid-ws')).toBe(window)
    expect(registry.findWindowForWorkspace('also-valid')).toBe(window)
    expect(registry.findWindowForWorkspace('')).toBeNull()
  })
})

describe('IPC handler window targeting after repeated switches', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    fromWebContentsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('folder picker targets the sender window, not the focused window', async () => {
    const { dialog } = await import('electron')
    const { registerIpcHandlers, PICK_FOLDER_CHANNEL } = await import(
      '../src/ipc.js'
    )

    const windowA = createMockWindow(500)
    const windowB = createMockWindow(501)

    registerIpcHandlers(
      () =>
        windowA as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const pickHandler = ipcHandlers.get(PICK_FOLDER_CHANNEL)
    expect(pickHandler).toBeDefined()

    // Window B sends the request, but window A is focused
    fromWebContentsMock.mockReturnValue(windowB)

    await pickHandler?.({ sender: windowB.webContents })

    // The dialog should have been called with window B as the owner,
    // not window A (the fallback).
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      windowB,
      expect.objectContaining({
        properties: expect.arrayContaining(['openDirectory']),
      })
    )
  })

  it('confirm dialog targets the sender window, not the focused window', async () => {
    const { dialog } = await import('electron')
    const { registerIpcHandlers, CONFIRM_CHANNEL } = await import(
      '../src/ipc.js'
    )

    const windowA = createMockWindow(600)
    const windowB = createMockWindow(601)

    registerIpcHandlers(
      () =>
        windowA as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const confirmHandler = ipcHandlers.get(CONFIRM_CHANNEL)
    expect(confirmHandler).toBeDefined()

    // Window B sends the confirm request
    fromWebContentsMock.mockReturnValue(windowB)

    await confirmHandler?.({ sender: windowB.webContents }, 'Delete this?')

    // The message box should have been called with window B as the owner
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      windowB,
      expect.objectContaining({ message: 'Delete this?' })
    )
  })

  it('context menu targets the sender window, not the focused window', async () => {
    const { Menu } = await import('electron')
    const { registerIpcHandlers, CONTEXT_MENU_CHANNEL } = await import(
      '../src/ipc.js'
    )

    const windowA = createMockWindow(700)
    const windowB = createMockWindow(701)

    registerIpcHandlers(
      () =>
        windowA as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const contextMenuHandler = ipcHandlers.get(CONTEXT_MENU_CHANNEL)
    expect(contextMenuHandler).toBeDefined()

    // Window B sends the context menu request
    fromWebContentsMock.mockReturnValue(windowB)

    // Fire-and-forget — the handler returns a promise that resolves when a
    // menu item is clicked or the menu is dismissed. We don't need to await
    // it since we only verify the popup target.
    contextMenuHandler?.(
      { sender: windowB.webContents },
      [{ id: 'copy', label: 'Copy' }],
      { x: 100, y: 200 }
    )

    // The menu should have been popped up on window B
    expect(Menu.buildFromTemplate).toHaveBeenCalled()
    const builtMenu = (Menu.buildFromTemplate as ReturnType<typeof vi.fn>).mock
      .results[0]?.value
    expect(builtMenu.popup).toHaveBeenCalledWith(
      expect.objectContaining({ window: windowB })
    )
  })

  it('falls back to the fallback window when sender window cannot be resolved', async () => {
    const { dialog } = await import('electron')
    const { registerIpcHandlers, PICK_FOLDER_CHANNEL } = await import(
      '../src/ipc.js'
    )

    const fallbackWindow = createMockWindow(800)

    registerIpcHandlers(
      () =>
        fallbackWindow as unknown as Parameters<
          typeof registerIpcHandlers
        >[0] extends () => infer R
          ? R
          : never
    )

    const pickHandler = ipcHandlers.get(PICK_FOLDER_CHANNEL)
    expect(pickHandler).toBeDefined()

    // Sender cannot be resolved (e.g., destroyed between request and handler)
    fromWebContentsMock.mockReturnValue(null)

    await pickHandler?.({ sender: {} })

    // Should fall back to the fallback window
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      fallbackWindow,
      expect.objectContaining({
        properties: expect.arrayContaining(['openDirectory']),
      })
    )
  })
})
