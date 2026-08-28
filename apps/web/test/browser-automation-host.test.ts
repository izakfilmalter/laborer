import type { BrowserControlRequest } from '@laborer/shared/browser-control'
import type { DesktopPreviewBridge } from '@laborer/shared/desktop-bridge'
import { describe, expect, it, vi } from 'vitest'
import { runBrowserAutomation } from '@/components/preview/browser-automation-host'

const request = (
  operation: BrowserControlRequest['operation'],
  input: unknown = {}
): BrowserControlRequest => ({
  controllerId: 'agent-1',
  input,
  operation,
  requestId: `request-${operation}`,
  timeoutMs: 1000,
  workspaceId: 'workspace-1',
})

const automation = () => ({
  click: vi.fn(async () => undefined),
  evaluate: vi.fn(async () => 'evaluated'),
  press: vi.fn(async () => undefined),
  scroll: vi.fn(async () => undefined),
  snapshot: vi.fn(async () => ({ title: 'snapshot' })),
  status: vi.fn(async () => ({
    available: true,
    loading: false,
    tabId: 'runtime-tab',
    title: 'Laborer',
    url: 'http://localhost:3000',
    visible: true,
  })),
  type: vi.fn(async () => undefined),
  waitFor: vi.fn(async () => undefined),
})

describe('browser automation host', () => {
  it.each([
    ['click', { selector: '#save' }],
    ['type', { selector: '#name', text: 'Laborer' }],
    ['press', { key: 'Enter' }],
    ['scroll', { deltaY: 400 }],
    ['waitFor', { text: 'Ready' }],
  ] as const)('dispatches %s with the selected runtime tab', async (operation, input) => {
    const bridge = automation()
    await expect(
      runBrowserAutomation(request(operation, input), {
        preview: { automation: bridge } as unknown as DesktopPreviewBridge,
        runtimeTabId: 'runtime-tab',
        serverTabId: 'server-tab',
      })
    ).resolves.toEqual({})
    expect(bridge[operation]).toHaveBeenCalledWith('runtime-tab', input)
  })

  it('returns snapshot, evaluation, and server-scoped status results', async () => {
    const bridge = automation()
    const preview = { automation: bridge } as unknown as DesktopPreviewBridge
    const target = {
      preview,
      runtimeTabId: 'runtime-tab',
      serverTabId: 'server-tab',
    }
    await expect(
      runBrowserAutomation(request('snapshot'), target)
    ).resolves.toEqual({ title: 'snapshot' })
    await expect(
      runBrowserAutomation(
        request('evaluate', { expression: 'document.title' }),
        target
      )
    ).resolves.toBe('evaluated')
    await expect(
      runBrowserAutomation(request('status'), target)
    ).resolves.toMatchObject({ tabId: 'server-tab', title: 'Laborer' })
  })

  it('reports an available but hidden host when no tab exists', async () => {
    const bridge = automation()
    await expect(
      runBrowserAutomation(request('status'), {
        preview: { automation: bridge } as unknown as DesktopPreviewBridge,
        runtimeTabId: null,
        serverTabId: null,
      })
    ).resolves.toMatchObject({ available: true, tabId: null, visible: false })
    await expect(
      runBrowserAutomation(request('click'), {
        preview: { automation: bridge } as unknown as DesktopPreviewBridge,
        runtimeTabId: null,
        serverTabId: null,
      })
    ).rejects.toThrow('No active browser tab was found')
  })
})
