import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewManager } from '../src/preview/Manager.js'

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

import {
  PREVIEW_AUTOMATION_CLICK_CHANNEL,
  PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  PREVIEW_AUTOMATION_TYPE_CHANNEL,
  PREVIEW_CREATE_TAB_CHANNEL,
  PREVIEW_NAVIGATE_CHANNEL,
  PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  PREVIEW_REVEAL_ARTIFACT_CHANNEL,
} from '../src/preview/channels.js'
import { registerPreviewIpcHandlers } from '../src/preview/Ipc.js'

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
    navigate: vi.fn(),
    registerWebview: vi.fn(),
    revealArtifact: vi.fn(),
  }

  beforeEach(() => {
    handlers.clear()
    fromWebContents.mockReset()
    fromWebContents.mockReturnValue({ webContents: owner })
    manager.createTab.mockReset()
    manager.automationClick.mockReset()
    manager.automationEvaluate.mockReset()
    manager.automationType.mockReset()
    manager.navigate.mockReset()
    manager.registerWebview.mockReset()
    manager.revealArtifact.mockReset()
    registerPreviewIpcHandlers(manager as unknown as PreviewManager)
  })

  it('rejects invalid webContents ids before calling the manager', () => {
    const invoke = handlers.get(PREVIEW_REGISTER_WEBVIEW_CHANNEL)
    expect(() =>
      invoke?.({ sender }, { tabId: 'tab-1', webContentsId: 0 })
    ).toThrow('Invalid payload for desktop:preview-register-webview')
    expect(manager.registerWebview).not.toHaveBeenCalled()
  })

  it('rejects malformed tab defaults before creating a tab', () => {
    const invoke = handlers.get(PREVIEW_CREATE_TAB_CHANNEL)
    expect(() =>
      invoke?.({ sender }, { tabId: 'tab-1', zoomFactor: Number.NaN })
    ).toThrow('Invalid payload for desktop:preview-create-tab')
    expect(() =>
      invoke?.({ sender }, { colorScheme: 'sepia', tabId: 'tab-1' })
    ).toThrow('Invalid payload for desktop:preview-create-tab')
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

  it('rejects malformed nested automation payloads before manager access', () => {
    const click = handlers.get(PREVIEW_AUTOMATION_CLICK_CHANNEL)
    const type = handlers.get(PREVIEW_AUTOMATION_TYPE_CHANNEL)
    expect(() => click?.({ sender }, { input: null, tabId: 'tab-1' })).toThrow(
      'Invalid payload for desktop:preview-automation-click'
    )
    expect(() =>
      click?.({ sender }, { input: { x: { value: 1 }, y: 2 }, tabId: 'tab-1' })
    ).toThrow('Invalid payload for desktop:preview-automation-click')
    expect(() =>
      type?.({ sender }, { input: { text: 42 }, tabId: 'tab-1' })
    ).toThrow('Invalid payload for desktop:preview-automation-type')
    expect(manager.automationClick).not.toHaveBeenCalled()
    expect(manager.automationType).not.toHaveBeenCalled()
  })

  it('bounds expressions, text, ids, URLs, and artifact paths', () => {
    const evaluate = handlers.get(PREVIEW_AUTOMATION_EVALUATE_CHANNEL)
    const type = handlers.get(PREVIEW_AUTOMATION_TYPE_CHANNEL)
    const navigate = handlers.get(PREVIEW_NAVIGATE_CHANNEL)
    const reveal = handlers.get(PREVIEW_REVEAL_ARTIFACT_CHANNEL)
    const oversized = 'x'.repeat(64_001)

    expect(() =>
      evaluate?.(
        { sender },
        { input: { expression: oversized }, tabId: 'tab-1' }
      )
    ).toThrow('Invalid payload for desktop:preview-automation-evaluate')
    expect(() =>
      type?.({ sender }, { input: { text: oversized }, tabId: 'tab-1' })
    ).toThrow('Invalid payload for desktop:preview-automation-type')
    expect(() =>
      navigate?.({ sender }, { tabId: ' invalid ', url: 'https://example.com' })
    ).toThrow('Invalid payload for desktop:preview-navigate')
    expect(() =>
      navigate?.({ sender }, { tabId: 'tab-1', url: 'file:///etc/passwd' })
    ).toThrow('Invalid payload for desktop:preview-navigate')
    expect(() =>
      reveal?.({ sender }, { path: `/tmp/${'x'.repeat(4096)}` })
    ).toThrow('Invalid payload for desktop:preview-reveal-artifact')
    expect(manager.automationEvaluate).not.toHaveBeenCalled()
    expect(manager.navigate).not.toHaveBeenCalled()
    expect(manager.revealArtifact).not.toHaveBeenCalled()
  })

  it('passes valid automation payloads through unchanged', () => {
    const click = handlers.get(PREVIEW_AUTOMATION_CLICK_CHANNEL)
    click?.(
      { sender },
      {
        input: { selector: '[data-testid="submit"]', timeoutMs: 1000 },
        tabId: 'tab-1',
      }
    )
    expect(manager.automationClick).toHaveBeenCalledWith(sender, 'tab-1', {
      selector: '[data-testid="submit"]',
      timeoutMs: 1000,
    })
  })
})
