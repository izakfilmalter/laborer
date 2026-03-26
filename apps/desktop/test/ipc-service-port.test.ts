/**
 * Tests for the MessagePort acquisition IPC handler.
 *
 * Verifies that the renderer can acquire direct MessagePort connections
 * to utility processes via the `laborer:acquire-service-port` IPC channel.
 *
 * The flow under test:
 * 1. Renderer sends `{ name, requestId }` via ipcRenderer.send()
 * 2. Main process creates a MessageChannelMain pair
 * 3. One port goes to the utility process, one goes to the renderer
 * 4. Renderer receives the port via webContents.postMessage()
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock types
// ---------------------------------------------------------------------------

interface MockWindow {
  readonly id: number
  isDestroyed: () => boolean
  readonly webContents: {
    postMessage: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
}

function createMockWindow(id: number): MockWindow {
  return {
    id,
    webContents: {
      send: vi.fn(),
      postMessage: vi.fn(),
    },
    isDestroyed: () => false,
  }
}

// ---------------------------------------------------------------------------
// Mock Electron APIs
// ---------------------------------------------------------------------------

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>()
const fromWebContentsMock = vi.fn()

const mockPort = () => ({
  close: vi.fn(),
  start: vi.fn(),
  postMessage: vi.fn(),
})

const mockMessageChannelInstances: Array<{
  port1: ReturnType<typeof mockPort>
  port2: ReturnType<typeof mockPort>
}> = []

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
    removeAllListeners: vi.fn(),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, handler)
    }),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  },
  MessageChannelMain: class {
    port1 = mockPort()
    port2 = mockPort()
    constructor() {
      mockMessageChannelInstances.push(this as never)
    }
  },
  Notification: class {
    on(): void {
      // no-op
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

// ---------------------------------------------------------------------------
// Mock UtilityProcessManager
// ---------------------------------------------------------------------------

const mockUtilityProcess = {
  postMessage: vi.fn(),
  pid: 1234,
}

const mockManager = {
  isRunning: vi.fn(),
  getProcess: vi.fn(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('acquire service port IPC', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    ipcListeners.clear()
    fromWebContentsMock.mockReset()
    mockMessageChannelInstances.length = 0
    mockManager.isRunning.mockReset()
    mockManager.getProcess.mockReset()
    mockUtilityProcess.postMessage.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function setup(): Promise<void> {
    const { registerIpcHandlers, setUtilityProcessManager } = await import(
      '../src/ipc.js'
    )

    setUtilityProcessManager(mockManager as never)
    registerIpcHandlers(() => null as never)
  }

  function getPortHandler(): (...args: unknown[]) => unknown {
    const handler = ipcListeners.get('laborer:acquire-service-port')
    if (!handler) {
      throw new Error('Port acquisition handler not registered')
    }
    return handler
  }

  it('registers the acquire-service-port listener', async () => {
    await setup()
    expect(ipcListeners.has('laborer:acquire-service-port')).toBe(true)
  })

  it('transfers a MessagePort to the renderer when the service is running', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(1)
    fromWebContentsMock.mockReturnValue(window)
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(mockUtilityProcess)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-1' }
    )

    // Verify a MessageChannelMain was created.
    expect(mockMessageChannelInstances).toHaveLength(1)
    const channel = mockMessageChannelInstances[0]
    expect(channel).toBeDefined()

    // Verify the utility-side port was sent to the utility process.
    expect(mockUtilityProcess.postMessage).toHaveBeenCalledWith(
      { type: 'port' },
      [channel?.port2]
    )

    // Verify the renderer-side port was sent to the renderer window.
    expect(window.webContents.postMessage).toHaveBeenCalledWith(
      'laborer:service-port-response',
      { requestId: 'req-1', success: true },
      [channel?.port1]
    )
  })

  it('responds with success: false when the service is not running', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(2)
    fromWebContentsMock.mockReturnValue(window)
    mockManager.isRunning.mockReturnValue(false)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-2' }
    )

    // No MessageChannelMain should be created.
    expect(mockMessageChannelInstances).toHaveLength(0)

    // Renderer receives a failure response.
    expect(window.webContents.postMessage).toHaveBeenCalledWith(
      'laborer:service-port-response',
      { requestId: 'req-2', success: false }
    )
  })

  it('responds with success: false when the process disappears between checks', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(3)
    fromWebContentsMock.mockReturnValue(window)
    mockManager.isRunning.mockReturnValue(true)
    // Process exists but getProcess() returns undefined (race condition).
    mockManager.getProcess.mockReturnValue(undefined)

    handler(
      { sender: window.webContents },
      { name: 'server', requestId: 'req-3' }
    )

    // Ports should be cleaned up.
    expect(mockMessageChannelInstances).toHaveLength(1)
    const channel = mockMessageChannelInstances[0]
    expect(channel).toBeDefined()
    expect(channel?.port1.close).toHaveBeenCalled()
    expect(channel?.port2.close).toHaveBeenCalled()

    // Renderer receives a failure response.
    expect(window.webContents.postMessage).toHaveBeenCalledWith(
      'laborer:service-port-response',
      { requestId: 'req-3', success: false }
    )
  })

  it('supports acquiring ports for different services', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(4)
    fromWebContentsMock.mockReturnValue(window)
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(mockUtilityProcess)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-a' }
    )
    handler(
      { sender: window.webContents },
      { name: 'server', requestId: 'req-b' }
    )
    handler(
      { sender: window.webContents },
      { name: 'file-watcher', requestId: 'req-c' }
    )
    handler({ sender: window.webContents }, { name: 'mcp', requestId: 'req-d' })

    // Each request creates a separate MessageChannelMain.
    expect(mockMessageChannelInstances).toHaveLength(4)

    // Each response has a unique requestId.
    const calls = window.webContents.postMessage.mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[0]?.[1]).toEqual({ requestId: 'req-a', success: true })
    expect(calls[1]?.[1]).toEqual({ requestId: 'req-b', success: true })
    expect(calls[2]?.[1]).toEqual({ requestId: 'req-c', success: true })
    expect(calls[3]?.[1]).toEqual({ requestId: 'req-d', success: true })
  })

  it('ignores invalid service names', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(5)
    fromWebContentsMock.mockReturnValue(window)

    handler(
      { sender: window.webContents },
      { name: 'invalid-service', requestId: 'req-x' }
    )

    // No channel created, no response sent.
    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(window.webContents.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests with missing requestId', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(6)
    fromWebContentsMock.mockReturnValue(window)

    handler({ sender: window.webContents }, { name: 'terminal' })

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(window.webContents.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests with non-string payload', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(7)
    fromWebContentsMock.mockReturnValue(window)

    handler({ sender: window.webContents }, 42)
    handler({ sender: window.webContents }, null)

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(window.webContents.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests when the sender window is destroyed', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(8)
    window.isDestroyed = () => true
    fromWebContentsMock.mockReturnValue(window)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-destroyed' }
    )

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(window.webContents.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests when the sender window is null', async () => {
    await setup()
    const handler = getPortHandler()

    fromWebContentsMock.mockReturnValue(null)

    handler({ sender: {} }, { name: 'terminal', requestId: 'req-null-window' })

    expect(mockMessageChannelInstances).toHaveLength(0)
  })

  it('works after utility process restart (new port to new process)', async () => {
    await setup()
    const handler = getPortHandler()

    const window = createMockWindow(9)
    fromWebContentsMock.mockReturnValue(window)

    // First request — old process.
    const oldProcess = { postMessage: vi.fn(), pid: 1000 }
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(oldProcess)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-old' }
    )

    expect(oldProcess.postMessage).toHaveBeenCalledOnce()

    // Simulate restart — new process instance.
    const newProcess = { postMessage: vi.fn(), pid: 2000 }
    mockManager.getProcess.mockReturnValue(newProcess)

    handler(
      { sender: window.webContents },
      { name: 'terminal', requestId: 'req-new' }
    )

    expect(newProcess.postMessage).toHaveBeenCalledOnce()

    // Both requests should have created separate channels.
    expect(mockMessageChannelInstances).toHaveLength(2)

    // Both responses have unique requestIds.
    const calls = window.webContents.postMessage.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual({ requestId: 'req-old', success: true })
    expect(calls[1]?.[1]).toEqual({ requestId: 'req-new', success: true })
  })
})
