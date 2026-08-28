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

const loadMainWithRecords = async (
  savedWindowRecords: MockWindowRecord[],
  options: { readonly onBattery?: boolean; readonly production?: boolean } = {}
) => {
  vi.resetModules()

  if (options.production) {
    vi.stubEnv('VITE_DEV_SERVER_URL', '')
  } else {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
  }
  vi.stubEnv('LABORER_SKIP_WATCH', '1')

  const BrowserWindow = createBrowserWindowMock()
  const appOn = vi.fn()
  const setName = vi.fn()
  const track = vi.fn()
  const registerIpcHandlersMock = vi.fn()
  const launchDaemon = vi.fn(async () => 'http://127.0.0.1:2117')
  const ipcMainHandle = vi.fn()
  const powerMonitor = {
    isOnBatteryPower: vi.fn(() => options.onBattery ?? false),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const fetchMock = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)

  vi.doMock('electron', () => ({
    app: {
      getPath: () => '/tmp/laborer-test',
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
      handle: ipcMainHandle,
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    powerMonitor,
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
  vi.doMock('../src/fix-path.js', () => ({ fixPath: vi.fn() }))
  vi.doMock('../src/daemon-supervisor.js', () => ({
    DesktopDaemonSupervisor: class {
      launch = launchDaemon
      reconnect = vi.fn(async () => undefined)
      shutdown = vi.fn(async () => undefined)
      currentRegistration = vi.fn(() => ({
        id: 'daemon-1',
        pid: 4321,
        startedAt: new Date(0).toISOString(),
        url: 'http://127.0.0.1:2117',
        version: '1.2.3',
      }))
    },
  }))
  vi.doMock('../src/ipc.js', () => ({
    ACTIVATE_WORKSPACE_CHANNEL: 'desktop:activate-workspace',
    askRenderersBeforeQuit: vi.fn(async () => false),
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
    setGetUpdateStateHandler: vi.fn(),
    setInstallUpdateHandler: vi.fn(),
    setTrayCountHandler: vi.fn(),
    setWorkspacePresenceHandler: vi.fn(),
  }))
  vi.doMock('../src/menu.js', () => ({
    configureApplicationMenu: vi.fn(),
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
    launchDaemon,
    fetchMock,
    ipcMainHandle,
    powerMonitor,
  }
}

afterEach(() => {
  process.title = originalProcessTitle
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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
    expect(BrowserWindow.instances[0]?.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:5173'
    )
  })

  it('loads the production web client from the ensured daemon origin', async () => {
    const { BrowserWindow, launchDaemon } = await loadMainWithRecords(
      [
        {
          windowId: 'window-alpha',
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          isMaximized: false,
        },
      ],
      { production: true }
    )

    expect(launchDaemon).toHaveBeenCalledTimes(1)
    expect(BrowserWindow.instances[0]?.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:2117'
    )
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

describe('automatic battery-saver mode', () => {
  const savedWindowRecords = [
    {
      windowId: 'window-alpha',
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      isMaximized: false,
    },
  ]

  /** Drain the pusher's serialized send queue (microtasks only). */
  const flushSends = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
  }

  const powerStateCalls = (
    fetchMock: ReturnType<typeof vi.fn>
  ): Array<{ readonly body: unknown; readonly url: string }> =>
    fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith('/daemon/power-state'))
      .map((call) => ({
        body: JSON.parse(
          (call[1] as { readonly body: string } | undefined)?.body ?? 'null'
        ),
        url: String(call[0]),
      }))

  it('pushes the initial power state to the ensured daemon on startup', async () => {
    const { fetchMock } = await loadMainWithRecords(savedWindowRecords, {
      onBattery: true,
      production: true,
    })
    await flushSends()

    expect(powerStateCalls(fetchMock)).toEqual([
      {
        body: { powerState: 'battery' },
        url: 'http://127.0.0.1:2117/daemon/power-state',
      },
    ])
  })

  it('pushes transitions reported by powerMonitor and dedupes repeats', async () => {
    const { fetchMock, powerMonitor } = await loadMainWithRecords(
      savedWindowRecords,
      { onBattery: false, production: true }
    )
    await flushSends()

    const handlers = new Map(
      powerMonitor.on.mock.calls.map((call) => [call[0], call[1]])
    )
    const onBattery = handlers.get('on-battery') as () => void
    onBattery()
    await flushSends()
    // macOS can deliver duplicate events — only one push per transition.
    onBattery()
    await flushSends()

    expect(powerStateCalls(fetchMock).map((call) => call.body)).toEqual([
      { powerState: 'ac' },
      { powerState: 'battery' },
    ])
  })

  it('re-pushes the current power state after every daemon ensure', async () => {
    const { fetchMock, ipcMainHandle } = await loadMainWithRecords(
      savedWindowRecords,
      { onBattery: false, production: true }
    )
    await flushSends()
    expect(powerStateCalls(fetchMock)).toHaveLength(1)

    const ensureDaemon = ipcMainHandle.mock.calls.find(
      (call) => call[0] === 'desktop:ensure-daemon'
    )?.[1] as () => Promise<void>
    await ensureDaemon()
    await flushSends()

    // A restarted daemon holds the default battery-saver profile, so the
    // unchanged 'ac' state is re-delivered rather than deduped away.
    expect(powerStateCalls(fetchMock).map((call) => call.body)).toEqual([
      { powerState: 'ac' },
      { powerState: 'ac' },
    ])
  })

  it('does not push power state in dev mode where no supervisor exists', async () => {
    const { fetchMock } = await loadMainWithRecords(savedWindowRecords)
    await flushSends()

    expect(powerStateCalls(fetchMock)).toHaveLength(0)
  })
})
