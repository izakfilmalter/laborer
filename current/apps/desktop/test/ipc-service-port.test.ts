/**
 * Tests for the MessagePort acquisition IPC handler.
 *
 * Verifies that the renderer can acquire direct MessagePort connections
 * to utility processes via the `laborer:acquire-service-port` IPC channel.
 *
 * The flow under test (VS Code acquirePort pattern):
 * 1. Renderer sends `{ name, nonce }` via ipcRenderer.send()
 * 2. Main process creates a MessageChannelMain pair
 * 3. One port goes to the utility process, one goes to the renderer
 * 4. Renderer receives the port via event.sender.postMessage(responseChannel, nonce, [port])
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock types
// ---------------------------------------------------------------------------

interface MockSender {
  isDestroyed: () => boolean
  postMessage: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function createMockSender(destroyed = false): MockSender {
  return {
    send: vi.fn(),
    postMessage: vi.fn(),
    isDestroyed: () => destroyed,
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
  on: vi.fn(),
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

    const sender = createMockSender()
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(mockUtilityProcess)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-1' })

    // Verify a MessageChannelMain was created.
    expect(mockMessageChannelInstances).toHaveLength(1)
    const channel = mockMessageChannelInstances[0]
    expect(channel).toBeDefined()

    // Verify the utility-side port was sent to the utility process.
    expect(mockUtilityProcess.postMessage).toHaveBeenCalledWith(
      { type: 'port' },
      [channel?.port2]
    )

    // Verify the renderer-side port was sent to the renderer via event.sender.
    expect(sender.postMessage).toHaveBeenCalledWith(
      'laborer:service-port-response',
      'nonce-1',
      [channel?.port1]
    )
  })

  it('silently ignores when the service is not running', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()
    mockManager.isRunning.mockReturnValue(false)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-2' })

    // No MessageChannelMain should be created.
    expect(mockMessageChannelInstances).toHaveLength(0)

    // Implementation returns early — no response sent.
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('silently ignores when the process disappears between checks', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()
    mockManager.isRunning.mockReturnValue(true)
    // Process exists but getProcess() returns undefined (race condition).
    mockManager.getProcess.mockReturnValue(undefined)

    handler({ sender }, { name: 'server', nonce: 'nonce-3' })

    // No channel created — implementation returns early before creating one.
    expect(mockMessageChannelInstances).toHaveLength(0)

    // No response sent.
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('supports acquiring ports for different services', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(mockUtilityProcess)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-a' })
    handler({ sender }, { name: 'server', nonce: 'nonce-b' })
    handler({ sender }, { name: 'file-watcher', nonce: 'nonce-c' })
    handler({ sender }, { name: 'mcp', nonce: 'nonce-d' })

    // Each request creates a separate MessageChannelMain.
    expect(mockMessageChannelInstances).toHaveLength(4)

    // Each response has a unique nonce.
    const calls = sender.postMessage.mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[0]?.[1]).toBe('nonce-a')
    expect(calls[1]?.[1]).toBe('nonce-b')
    expect(calls[2]?.[1]).toBe('nonce-c')
    expect(calls[3]?.[1]).toBe('nonce-d')
  })

  it('ignores invalid service names', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()

    handler({ sender }, { name: 'invalid-service', nonce: 'nonce-x' })

    // No channel created, no response sent.
    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests with missing nonce', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()

    handler({ sender }, { name: 'terminal' })

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests with non-string payload', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()

    handler({ sender }, 42)
    handler({ sender }, null)

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests when the sender is destroyed', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender(true)
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(mockUtilityProcess)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-destroyed' })

    expect(mockMessageChannelInstances).toHaveLength(0)
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('ignores requests when the sender window is null', async () => {
    await setup()
    const handler = getPortHandler()

    // Sender without isDestroyed — should fail typeof check or early guard.
    const sender = createMockSender()
    mockManager.isRunning.mockReturnValue(false)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-null-window' })

    expect(mockMessageChannelInstances).toHaveLength(0)
  })

  it('works after utility process restart (new port to new process)', async () => {
    await setup()
    const handler = getPortHandler()

    const sender = createMockSender()

    // First request — old process.
    const oldProcess = { postMessage: vi.fn(), pid: 1000 }
    mockManager.isRunning.mockReturnValue(true)
    mockManager.getProcess.mockReturnValue(oldProcess)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-old' })

    expect(oldProcess.postMessage).toHaveBeenCalledOnce()

    // Simulate restart — new process instance.
    const newProcess = { postMessage: vi.fn(), pid: 2000 }
    mockManager.getProcess.mockReturnValue(newProcess)

    handler({ sender }, { name: 'terminal', nonce: 'nonce-new' })

    expect(newProcess.postMessage).toHaveBeenCalledOnce()

    // Both requests should have created separate channels.
    expect(mockMessageChannelInstances).toHaveLength(2)

    // Both responses have unique nonces.
    const calls = sender.postMessage.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toBe('nonce-old')
    expect(calls[1]?.[1]).toBe('nonce-new')
  })
})
