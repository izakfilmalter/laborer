import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler)
      }
    ),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, listener)
    }),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  },
  MessageChannelMain: class {},
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

describe('backend URL IPC', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    ipcListeners.clear()
  })

  it('returns the current backend WebSocket URL through a synchronous IPC listener', async () => {
    const {
      GET_BACKEND_WS_URL_CHANNEL,
      registerIpcHandlers,
      setGetBackendWsUrlHandler,
    } = await import('../src/ipc.js')

    setGetBackendWsUrlHandler(() => 'ws://127.0.0.1:17321/?token=secret')
    registerIpcHandlers(() => null as never)

    const listener = ipcListeners.get(GET_BACKEND_WS_URL_CHANNEL)
    expect(listener).toBeDefined()
    const event = { returnValue: null }
    listener?.(event)
    expect(event.returnValue).toBe('ws://127.0.0.1:17321/?token=secret')
  })
})
