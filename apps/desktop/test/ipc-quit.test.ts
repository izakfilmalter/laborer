import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockWindow {
  readonly isDestroyed: ReturnType<typeof vi.fn>
  readonly webContents: {
    readonly isDestroyed: ReturnType<typeof vi.fn>
    readonly send: ReturnType<typeof vi.fn>
  }
}

const browserWindowGetAllWindows = vi.fn<() => MockWindow[]>()
const browserWindowGetFocusedWindow = vi.fn<() => MockWindow | null>()
const ipcListeners = new Map<string, (...args: unknown[]) => void>()

function createMockWindow(): MockWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  }
}

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: () => browserWindowGetAllWindows(),
    getFocusedWindow: () => browserWindowGetFocusedWindow(),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, handler)
    }),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(
      (channel: string, handler: (...args: unknown[]) => void) => {
        if (ipcListeners.get(channel) === handler) {
          ipcListeners.delete(channel)
        }
      }
    ),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
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

describe('askRenderersBeforeQuit', () => {
  beforeEach(() => {
    ipcListeners.clear()
    browserWindowGetAllWindows.mockReset()
    browserWindowGetFocusedWindow.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks only the focused window before quitting', async () => {
    const { askRenderersBeforeQuit, BEFORE_QUIT_CHANNEL, QUIT_REPLY_CHANNEL } =
      await import('../src/ipc.js')

    const unfocusedWindow = createMockWindow()
    const focusedWindow = createMockWindow()

    browserWindowGetAllWindows.mockReturnValue([unfocusedWindow, focusedWindow])
    browserWindowGetFocusedWindow.mockReturnValue(focusedWindow)

    const quitPromise = askRenderersBeforeQuit('quit', 0)

    try {
      expect(focusedWindow.webContents.send).toHaveBeenCalledWith(
        BEFORE_QUIT_CHANNEL,
        expect.objectContaining({
          id: expect.any(String),
          reason: 'quit',
        })
      )
      expect(unfocusedWindow.webContents.send).not.toHaveBeenCalled()

      const quitReplyListener = ipcListeners.get(QUIT_REPLY_CHANNEL)
      expect(quitReplyListener).toBeDefined()

      const focusedPayload = focusedWindow.webContents.send.mock
        .calls[0]?.[1] as { id: string } | undefined

      expect(focusedPayload).toBeDefined()

      quitReplyListener?.({}, { id: focusedPayload?.id, veto: true })

      await expect(quitPromise).resolves.toBe(true)
    } finally {
      const quitReplyListener = ipcListeners.get(QUIT_REPLY_CHANNEL)
      const payloads = [unfocusedWindow, focusedWindow]
        .map((window) => window.webContents.send.mock.calls[0]?.[1])
        .filter((payload): payload is { id: string } => Boolean(payload))

      for (const payload of payloads) {
        quitReplyListener?.({}, { id: payload.id, veto: false })
      }

      await quitPromise
    }
  })
})
