import { afterEach, describe, expect, it, vi } from 'vitest'

const originalProcessTitle = process.title

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
  await vi.dynamicImportSettled()
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
      setWindowOpenHandler: vi.fn(),
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
      if (handlers) {
        for (const handler of handlers) {
          handler(...args)
        }
      }

      const onceHandlers = this.onceEventHandlers.get(event)
      if (onceHandlers) {
        for (const handler of onceHandlers) {
          handler(...args)
        }
      }
      this.onceEventHandlers.delete(event)
    }
  }

  return MockBrowserWindow
}

const loadMainWithRecords = async (savedWindowRecords: MockWindowRecord[]) => {
  vi.resetModules()

  vi.stubEnv('VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
  vi.stubEnv('LABORER_SKIP_WATCH', '1')

  const BrowserWindow = createBrowserWindowMock()
  const appOn = vi.fn()
  const setName = vi.fn()
  const track = vi.fn()
  const registerIpcHandlersMock = vi.fn()

  vi.doMock('electron', () => ({
    app: {
      getVersion: () => '1.2.3',
      setName,
      whenReady: () => Promise.resolve(),
      on: appOn,
      once: vi.fn(),
      exit: vi.fn(),
      quit: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(),
    },
    BrowserWindow,
    Notification: class {
      static isSupported = () => true
      on = vi.fn()
      show = vi.fn()
    },
    ipcMain: {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      handle: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    powerMonitor: {
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
    },
  }))

  vi.doMock('../src/auto-updater.js', () => ({
    broadcastUpdateStateToWindow: vi.fn(),
    configureAutoUpdater: vi.fn(),
    getUpdateState: vi.fn(),
    shutdownAutoUpdater: vi.fn(),
    triggerDownloadUpdate: vi.fn(),
    triggerInstallUpdate: vi.fn(),
  }))
  vi.doMock('../src/backend-process-manager.js', () => ({
    BackendProcessManager: class {
      start = vi.fn(() => ({ wsUrl: 'ws://127.0.0.1:12345/?token=test' }))
      stop = vi.fn()
    },
  }))
  vi.doMock('../src/fix-path.js', () => ({ fixPath: vi.fn() }))
  vi.doMock('../src/ipc.js', () => ({
    ACTIVATE_WORKSPACE_CHANNEL: 'desktop:activate-workspace',
    askRenderersBeforeQuit: vi.fn(async () => false),
    closeRendererPortsForService: vi.fn(),
    getWorkspaceWindowRegistry: vi.fn(() => ({
      branchNameForWorkspace: vi.fn(() => null),
      findWindowForWorkspace: vi.fn(() => null),
      hasFocusedWindow: vi.fn(() => false),
      routeToOrOpenWorkspace: vi.fn(),
    })),
    publishWorkspacePresence: vi.fn(),
    QUIT_CONFIRMED_CHANNEL: 'desktop:quit-confirmed',
    registerIpcHandlers: registerIpcHandlersMock,
    removeWindowPresence: vi.fn(),
    setDownloadUpdateHandler: vi.fn(),
    setGetBackendWsUrlHandler: vi.fn(),
    setGetSidecarStatusesHandler: vi.fn(),
    setGetUpdateStateHandler: vi.fn(),
    setInstallUpdateHandler: vi.fn(),
    setRestartSidecarHandler: vi.fn(),
    setTrayCountHandler: vi.fn(),
    setUtilityProcessManager: vi.fn(),
    setWorkspacePresenceHandler: vi.fn(),
  }))
  vi.doMock('../src/utility-process-manager.js', () => ({
    UtilityProcessManager: class {
      fork = vi.fn()
      kill = vi.fn()
      restart = vi.fn()
      killAll = vi.fn()
      killAllAndWait = vi.fn(async () => undefined)
      setMessageHandler = vi.fn()
      isRunning = vi.fn(() => false)
      getPort = vi.fn()
      getProcess = vi.fn()
      brokerInterProcessPort = vi.fn()
    },
  }))
  vi.doMock('../src/lifecycle-monitor.js', () => ({
    LifecycleMonitor: class {
      forkAllAndMonitor = vi.fn()
      getCurrentStatuses = vi.fn(() => [])
      handleReady = vi.fn()
      handleHeartbeat = vi.fn()
      handleSuspend = vi.fn()
      handleResume = vi.fn()
      manualRestart = vi.fn()
      isHealthy = vi.fn(() => false)
      areServicesHealthy = vi.fn(() => false)
      shutdown = vi.fn()
    },
  }))
  vi.doMock('../src/menu.js', () => ({
    configureApplicationMenu: vi.fn(),
  }))

  vi.doMock('../src/protocol.js', () => ({
    DESKTOP_SCHEME: 'laborer',
    registerDesktopProtocol: vi.fn(),
    registerSchemeAsPrivileged: vi.fn(),
    resolveStaticRoot: vi.fn(() => null),
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
    buildWindowBootstrapArgs: ({ windowId }: { readonly windowId: string }) => [
      `--laborer-window-id=${windowId}`,
    ],
    createWindowId: () => 'new-window-id',
  }))
  const removeWindowRecord = vi.fn()

  vi.doMock('../src/window-state.js', () => ({
    WindowStateManager: class {
      loadWindowRecords(): MockWindowRecord[] {
        return savedWindowRecords
      }
      load(): never {
        throw new Error('load() should not be used for restored windows')
      }
      track = track
      removeWindowRecord = removeWindowRecord
    },
  }))

  await import('../src/main.js')
  await waitForBootstrap()

  return {
    BrowserWindow,
    registerIpcHandlers: registerIpcHandlersMock,
    track,
    removeWindowRecord,
    appOn,
    setName,
  }
}

afterEach(() => {
  process.title = originalProcessTitle
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unmock('electron')
  vi.clearAllMocks()
})

describe('main multi-window restore', () => {
  it('sets the app name to Laborer-dev while running in dev mode', async () => {
    const { setName } = await loadMainWithRecords([])

    expect(setName).toHaveBeenCalledWith('Laborer-dev')
    expect(process.title).toBe('Laborer-dev')
  })

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
      acceptFirstMouse: true,
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

  it('removes the closed window record when a non-last window is closed', async () => {
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

    const { BrowserWindow, removeWindowRecord } =
      await loadMainWithRecords(savedWindowRecords)

    // Close the first window (non-last, so it won't be hidden to tray).
    BrowserWindow.instances[0]?.emit('close', { preventDefault: vi.fn() })
    BrowserWindow.instances[0]?.isDestroyed.mockReturnValue(true)
    BrowserWindow.instances[0]?.isVisible.mockReturnValue(false)
    BrowserWindow.instances[0]?.emit('closed')

    expect(removeWindowRecord).toHaveBeenCalledWith('window-alpha')
  })

  it('does not remove window record when the last window is hidden to tray', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-only',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
    ]

    const { BrowserWindow, removeWindowRecord } =
      await loadMainWithRecords(savedWindowRecords)

    // The last window's close is hidden to tray (preventDefault is called).
    const closeEvent = { preventDefault: vi.fn() }
    BrowserWindow.instances[0]?.emit('close', closeEvent)

    // The window was hidden, not destroyed — no 'closed' event fires.
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(removeWindowRecord).not.toHaveBeenCalled()
  })

  it('removes the window record when the last window was hidden to tray and then the app quits', async () => {
    const savedWindowRecords = [
      {
        windowId: 'window-only',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
    ]

    const { BrowserWindow, removeWindowRecord, appOn } =
      await loadMainWithRecords(savedWindowRecords)

    // Step 1: Close the last window — it gets hidden to tray.
    const firstCloseEvent = { preventDefault: vi.fn() }
    BrowserWindow.instances[0]?.emit('close', firstCloseEvent)
    expect(firstCloseEvent.preventDefault).toHaveBeenCalledTimes(1)

    // Step 2: Trigger app quit via 'before-quit'.
    const beforeQuitHandler = appOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'before-quit'
    )?.[1] as ((event: { preventDefault: () => void }) => void) | undefined
    expect(beforeQuitHandler).toBeDefined()
    beforeQuitHandler?.({ preventDefault: vi.fn() })
    // Allow the async askRenderersBeforeQuit to resolve and set isQuitting = true.
    await Promise.resolve()
    await Promise.resolve()

    // Step 3: The hidden window's close fires again during quit (not prevented).
    const secondCloseEvent = { preventDefault: vi.fn() }
    BrowserWindow.instances[0]?.emit('close', secondCloseEvent)
    expect(secondCloseEvent.preventDefault).not.toHaveBeenCalled()

    // Step 4: Window is actually destroyed.
    BrowserWindow.instances[0]?.isDestroyed.mockReturnValue(true)
    BrowserWindow.instances[0]?.isVisible.mockReturnValue(false)
    BrowserWindow.instances[0]?.emit('closed')

    expect(removeWindowRecord).toHaveBeenCalledWith('window-only')
  })

  it('does not remove window records when the app quits with windows still open', async () => {
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

    const { BrowserWindow, removeWindowRecord, appOn } =
      await loadMainWithRecords(savedWindowRecords)

    // Trigger app quit via 'before-quit'.
    const beforeQuitHandler = appOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'before-quit'
    )?.[1] as ((event: { preventDefault: () => void }) => void) | undefined
    expect(beforeQuitHandler).toBeDefined()
    beforeQuitHandler?.({ preventDefault: vi.fn() })
    // Allow the async askRenderersBeforeQuit to resolve and set isQuitting = true.
    await Promise.resolve()
    await Promise.resolve()

    // Both windows close during quit (not hidden, not prevented).
    for (const instance of BrowserWindow.instances) {
      instance.emit('close', { preventDefault: vi.fn() })
      instance.isDestroyed.mockReturnValue(true)
      instance.isVisible.mockReturnValue(false)
      instance.emit('closed')
    }

    expect(removeWindowRecord).not.toHaveBeenCalled()
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
