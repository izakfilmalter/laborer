import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>()
)
const fromWebContents = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getVersion: vi.fn() },
  BrowserWindow: { fromWebContents },
  dialog: {},
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    ),
    removeHandler: vi.fn(),
  },
  Menu: {},
  shell: {},
}))

import { registerPreviewIpcHandlers } from '../src/ipc.js'
import {
  PREVIEW_CREATE_TAB_CHANNEL,
  PREVIEW_REGISTER_WEBVIEW_CHANNEL,
} from '../src/preview/channels.js'

describe('preview IPC validation', () => {
  const owner = { isDestroyed: () => false }
  const sender = { id: 1 }
  const manager = {
    automationClick: vi.fn(),
    automationEvaluate: vi.fn(),
    automationPress: vi.fn(),
    automationScroll: vi.fn(),
    automationType: vi.fn(),
    automationWaitFor: vi.fn(),
    createTab: vi.fn(),
    registerWebview: vi.fn(),
  }

  beforeEach(() => {
    handlers.clear()
    fromWebContents.mockReset()
    fromWebContents.mockReturnValue({ webContents: owner })
    manager.createTab.mockReset()
    manager.registerWebview.mockReset()
    registerPreviewIpcHandlers(manager as never)
  })

  it('rejects invalid webContents ids before calling the manager', () => {
    const invoke = handlers.get(PREVIEW_REGISTER_WEBVIEW_CHANNEL)
    expect(() =>
      invoke?.({ sender }, { tabId: 'tab-1', webContentsId: 0 })
    ).toThrow('Invalid preview webContents id')
    expect(manager.registerWebview).not.toHaveBeenCalled()
  })

  it('rejects malformed tab defaults before creating a tab', () => {
    const invoke = handlers.get(PREVIEW_CREATE_TAB_CHANNEL)
    expect(() =>
      invoke?.({ sender }, { tabId: 'tab-1', zoomFactor: Number.NaN })
    ).toThrow('Invalid preview zoom factor')
    expect(() =>
      invoke?.({ sender }, { colorScheme: 'sepia', tabId: 'tab-1' })
    ).toThrow('Invalid preview color scheme')
    expect(manager.createTab).not.toHaveBeenCalled()
  })

  it('accepts requests only from a BrowserWindow renderer', () => {
    fromWebContents.mockReturnValue(null)
    const invoke = handlers.get(PREVIEW_CREATE_TAB_CHANNEL)
    expect(() => invoke?.({ sender }, { tabId: 'tab-1' })).toThrow(
      'Preview IPC must come from a Laborer renderer window'
    )
    expect(manager.createTab).not.toHaveBeenCalled()
  })
})
