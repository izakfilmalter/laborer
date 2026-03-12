import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockWindowRecord {
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly isMaximized: boolean
  readonly windowId: string
}

const waitForBootstrap = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const noop = (): void => undefined

const createBrowserWindowMock = () => {
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []

    static getFocusedWindow(): MockBrowserWindow | null {
      return MockBrowserWindow.instances[0] ?? null
    }

    static getAllWindows(): MockBrowserWindow[] {
      return [...MockBrowserWindow.instances]
    }

    readonly webContents = {
      on: vi.fn(),
      send: vi.fn(),
    }

    readonly eventHandlers = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >()
    readonly onceEventHandlers = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => undefined)
    readonly isVisible = vi.fn(() => true)
    readonly isDestroyed = vi.fn(() => false)
    readonly getNormalBounds = vi.fn(() => this.options)
    readonly isMaximized = vi.fn(() => this.maximize.mock.calls.length > 0)
    readonly maximize = vi.fn(noop)

    readonly options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      MockBrowserWindow.instances.push(this)
    }

    readonly once = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        const handlers = this.onceEventHandlers.get(event) ?? new Set()
        handlers.add(handler)
        this.onceEventHandlers.set(event, handlers)
      }
    )

    readonly on = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        const handlers = this.eventHandlers.get(event) ?? new Set()
        handlers.add(handler)
        this.eventHandlers.set(event, handlers)
      }
    )

    emit(event: string, ...args: unknown[]): void {
      const handlers = this.eventHandlers.get(event)
      handlers?.forEach((handler) => handler(...args))

      const onceHandlers = this.onceEventHandlers.get(event)
      onceHandlers?.forEach((handler) => handler(...args))
      this.onceEventHandlers.delete(event)
    }
  }

  return MockBrowserWindow
}

const loadMainWithRecords = async (savedWindowRecords: MockWindowRecord[]) => {
  vi.resetModules()

  vi.stubEnv('VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')

  const BrowserWindow = createBrowserWindowMock()
  const appOn = vi.fn()
  const track = vi.fn()
  const registerIpcHandlersMock = vi.fn()

  vi.doMock('electron', () => ({
    app: {
      whenReady: () => Promise.resolve(),
      on: appOn,
      quit: vi.fn(),
    },
    BrowserWindow,
  }))

  vi.doMock('../src/auto-updater.js', () => ({
    broadcastUpdateStateToWindow: vi.fn(),
    configureAutoUpdater: vi.fn(),
    getUpdateState: vi.fn(),
    shutdownAutoUpdater: vi.fn(),
    triggerDownloadUpdate: vi.fn(),
    triggerInstallUpdate: vi.fn(),
  }))
  vi.doMock('../src/fix-path.js', () => ({ fixPath: vi.fn() }))
  vi.doMock('../src/health.js', () => ({
    HealthMonitor: class {
      setStatusListener = noop
      spawnServices(): Promise<boolean> {
        return Promise.resolve(true)
      }
      manualRestart(): Promise<void> {
        return Promise.resolve()
      }
      shutdown = noop
    },
  }))
  vi.doMock('../src/ipc.js', () => ({
    getWorkspaceWindowRegistry: () => ({ remove: vi.fn() }),
    registerIpcHandlers: registerIpcHandlersMock,
    setDownloadUpdateHandler: vi.fn(),
    setGetUpdateStateHandler: vi.fn(),
    setInstallUpdateHandler: vi.fn(),
    setRestartSidecarHandler: vi.fn(),
    setTrayCountHandler: vi.fn(),
  }))
  vi.doMock('../src/menu.js', () => ({
    configureApplicationMenu: vi.fn(),
  }))
  vi.doMock('../src/ports.js', () => ({
    reserveServicePorts: async () => ({
      serverPort: 3100,
      terminalPort: 3200,
    }),
  }))
  vi.doMock('../src/protocol.js', () => ({
    DESKTOP_SCHEME: 'laborer',
    registerDesktopProtocol: vi.fn(),
    registerSchemeAsPrivileged: vi.fn(),
    resolveStaticRoot: vi.fn(() => null),
  }))
  vi.doMock('../src/sidecar.js', () => ({
    SidecarManager: class {
      restart(): Promise<void> {
        return Promise.resolve()
      }
      killAll = noop
    },
  }))
  vi.doMock('../src/tray.js', () => ({
    TrayManager: class {
      create = noop
      destroy = noop
      updateWorkspaceCount = noop
    },
    registerGlobalShortcut: () => () => undefined,
  }))
  vi.doMock('../src/window-identity.js', () => ({
    buildWindowBootstrapArgs: ({
      serverUrl,
      terminalUrl,
      windowId,
    }: {
      readonly serverUrl: string
      readonly terminalUrl: string
      readonly windowId: string
    }) => [
      `--laborer-server-url=${serverUrl}`,
      `--laborer-terminal-url=${terminalUrl}`,
      `--laborer-window-id=${windowId}`,
    ],
    createWindowId: () => 'new-window-id',
  }))
  vi.doMock('../src/window-state.js', () => ({
    WindowStateManager: class {
      loadWindowRecords(): MockWindowRecord[] {
        return savedWindowRecords
      }
      load(): never {
        throw new Error('load() should not be used for restored windows')
      }
      track = track
    },
  }))

  await import('../src/main.js')
  await waitForBootstrap()

  return { BrowserWindow, registerIpcHandlers: registerIpcHandlersMock, track }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unmock('electron')
  vi.clearAllMocks()
})

describe('main multi-window restore', () => {
  it('restores every saved window on relaunch with its own window bootstrap context', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 120, y: 240, width: 1024, height: 768 },
        isMaximized: true,
      },
    ]

    const { BrowserWindow, track } =
      await loadMainWithRecords(savedWindowRecords)

    expect(BrowserWindow.instances).toHaveLength(2)
    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenNthCalledWith(
      1,
      BrowserWindow.instances[0],
      'window-alpha'
    )
    expect(track).toHaveBeenNthCalledWith(
      2,
      BrowserWindow.instances[1],
      'window-beta'
    )

    expect(BrowserWindow.instances[0]?.options).toMatchObject({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      webPreferences: {
        additionalArguments: expect.arrayContaining([
          '--laborer-window-id=window-alpha',
        ]),
      },
    })
    expect(BrowserWindow.instances[1]?.options).toMatchObject({
      x: 120,
      y: 240,
      width: 1024,
      height: 768,
      webPreferences: {
        additionalArguments: expect.arrayContaining([
          '--laborer-window-id=window-beta',
        ]),
      },
    })
    expect(BrowserWindow.instances[1]?.maximize).toHaveBeenCalledTimes(1)
  })

  it('closes a non-last visible window instead of hiding it to the tray', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 120, y: 240, width: 1024, height: 768 },
        isMaximized: false,
      },
    ]

    const { BrowserWindow } = await loadMainWithRecords(savedWindowRecords)
    const closeEvent = { preventDefault: vi.fn() }

    BrowserWindow.instances[0]?.emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(BrowserWindow.instances[0]?.hide).not.toHaveBeenCalled()
  })

  it('keeps the last visible window on the existing close-to-tray path', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 120, y: 240, width: 1024, height: 768 },
        isMaximized: false,
      },
    ]

    const { BrowserWindow } = await loadMainWithRecords(savedWindowRecords)

    BrowserWindow.instances[1]?.isVisible.mockReturnValue(false)

    const closeEvent = { preventDefault: vi.fn() }
    BrowserWindow.instances[0]?.emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(BrowserWindow.instances[0]?.hide).toHaveBeenCalledTimes(1)
  })

  it('registers IPC handlers exactly once even when multiple windows are created', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 120, y: 240, width: 1024, height: 768 },
        isMaximized: false,
      },
    ]

    const { BrowserWindow, registerIpcHandlers } =
      await loadMainWithRecords(savedWindowRecords)

    expect(BrowserWindow.instances).toHaveLength(2)
    expect(registerIpcHandlers).toHaveBeenCalledTimes(1)
  })
})
