import type { BrowserControlRequest } from '@laborer/shared/browser-control'
import type { DesktopPreviewBridge } from '@laborer/shared/desktop-bridge'
import { describe, expect, it, vi } from 'vitest'
import {
  enqueueBrowserRequest,
  runBrowserAutomation,
} from '@/components/preview/browser-automation-host'
import { cleanupWorkspacePreview } from '@/components/preview/preview-session-hosts'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import { usePreviewStateStore } from '@/preview-state-store'

const recording = vi.hoisted(() => ({
  start: vi.fn(async () => '2026-08-28T12:00:00.000Z'),
  stop: vi.fn(async () => ({
    id: 'artifact-1',
    tabId: 'runtime-tab',
    path: '/artifacts/recording.webm',
    mimeType: 'video/webm',
    sizeBytes: 42,
    createdAt: '2026-08-28T12:01:00.000Z',
  })),
  cancel: vi.fn(async () => undefined),
}))

vi.mock('@/browser/browser-recording', () => ({
  startBrowserRecording: recording.start,
  stopBrowserRecording: recording.stop,
  cancelBrowserRecording: recording.cancel,
}))

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

const snapshot = (tabId = 'server-tab') => ({
  canGoBack: false,
  canGoForward: false,
  navStatus: {
    _tag: 'Success' as const,
    title: 'Laborer',
    url: 'https://laborer.dev/',
  },
  tabId,
  updatedAt: '2026-08-28T12:00:00.000Z',
  viewport: { _tag: 'fill' as const },
  workspaceId: 'workspace-1',
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

  it('cold-opens a daemon session, waits for its desktop tab, and reveals it', async () => {
    const bridge = automation()
    let current = {
      runtimeTabId: null as string | null,
      serverTabId: null as string | null,
    }
    const open = vi.fn(async () => snapshot())
    const reveal = vi.fn()

    await expect(
      runBrowserAutomation(request('open', { url: 'https://laborer.dev' }), {
        preview: { automation: bridge } as unknown as DesktopPreviewBridge,
        ...current,
        workspaceId: 'workspace-1',
        resolveTarget: () => current,
        open,
        upsert: (value) => {
          current = { runtimeTabId: 'runtime-tab', serverTabId: value.tabId }
        },
        reveal,
      })
    ).resolves.toMatchObject({ tabId: 'server-tab', available: true })
    expect(open).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      url: 'https://laborer.dev',
    })
    expect(reveal).toHaveBeenCalledWith('server-tab')
  })

  it('serializes duplicate opens so the second request reuses the created tab', async () => {
    const bridge = automation()
    let current = {
      runtimeTabId: null as string | null,
      serverTabId: null as string | null,
    }
    const open = vi.fn(async () => snapshot())
    const target = {
      preview: { automation: bridge } as unknown as DesktopPreviewBridge,
      ...current,
      workspaceId: 'workspace-1',
      resolveTarget: () => current,
      open,
      upsert: (value: ReturnType<typeof snapshot>) => {
        current = { runtimeTabId: 'runtime-tab', serverTabId: value.tabId }
      },
    }
    let queue: Promise<unknown> = Promise.resolve()
    queue = enqueueBrowserRequest(queue, () =>
      runBrowserAutomation(request('open'), target)
    )
    queue = enqueueBrowserRequest(queue, () =>
      runBrowserAutomation(request('open'), target)
    )
    await queue
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('navigates both daemon and desktop and honors DOM readiness', async () => {
    const bridge = automation()
    bridge.evaluate.mockResolvedValue('interactive')
    const navigate = vi.fn(async () => snapshot())
    const desktopNavigate = vi.fn(async () => undefined)
    await expect(
      runBrowserAutomation(
        request('navigate', {
          url: 'https://laborer.dev',
          readiness: 'domContentLoaded',
        }),
        {
          preview: {
            automation: bridge,
            navigate: desktopNavigate,
          } as unknown as DesktopPreviewBridge,
          runtimeTabId: 'runtime-tab',
          serverTabId: 'server-tab',
          workspaceId: 'workspace-1',
          navigate,
          upsert: vi.fn(),
        }
      )
    ).resolves.toMatchObject({ tabId: 'server-tab' })
    expect(navigate).toHaveBeenCalledOnce()
    expect(desktopNavigate).toHaveBeenCalledWith(
      'runtime-tab',
      'https://laborer.dev'
    )
  })

  it('resizes daemon state and returns the measured desktop viewport', async () => {
    const bridge = automation()
    bridge.status.mockResolvedValue({
      available: true,
      loading: false,
      tabId: 'runtime-tab',
      title: 'Laborer',
      url: 'https://laborer.dev',
      viewport: { width: 844, height: 390 },
      visible: false,
    })
    const resize = vi.fn(async () => snapshot())
    await expect(
      runBrowserAutomation(
        request('resize', {
          mode: 'preset',
          preset: 'iphone-12-pro',
          orientation: 'landscape',
        }),
        {
          preview: { automation: bridge } as unknown as DesktopPreviewBridge,
          runtimeTabId: 'runtime-tab',
          serverTabId: 'server-tab',
          workspaceId: 'workspace-1',
          resize,
          upsert: vi.fn(),
        }
      )
    ).resolves.toEqual({
      tabId: 'server-tab',
      setting: {
        _tag: 'preset',
        presetId: 'iphone-12-pro',
        width: 844,
        height: 390,
      },
      viewport: { width: 844, height: 390 },
    })
  })

  it('maps recording lifecycle results to the server tab identity', async () => {
    const target = {
      preview: { automation: automation() } as unknown as DesktopPreviewBridge,
      runtimeTabId: 'runtime-tab',
      serverTabId: 'server-tab',
    }
    await expect(
      runBrowserAutomation(request('recordingStart'), target)
    ).resolves.toEqual({
      tabId: 'server-tab',
      recording: true,
      startedAt: '2026-08-28T12:00:00.000Z',
    })
    await expect(
      runBrowserAutomation(request('recordingStop'), target)
    ).resolves.toMatchObject({
      id: 'artifact-1',
      tabId: 'server-tab',
      path: '/artifacts/recording.webm',
    })
    expect(recording.stop).toHaveBeenCalledWith('runtime-tab')
  })

  it('times out when a cold desktop tab never becomes automation-ready', async () => {
    const bridge = automation()
    bridge.status.mockRejectedValue(new Error('not registered'))
    let current = {
      runtimeTabId: null as string | null,
      serverTabId: null as string | null,
    }
    await expect(
      runBrowserAutomation(
        { ...request('open'), timeoutMs: 1 },
        {
          preview: { automation: bridge } as unknown as DesktopPreviewBridge,
          ...current,
          workspaceId: 'workspace-1',
          resolveTarget: () => current,
          open: async () => snapshot(),
          upsert: (value) => {
            current = { runtimeTabId: 'runtime-tab', serverTabId: value.tabId }
          },
        }
      )
    ).rejects.toThrow('Browser tab did not become ready')
  })

  it('cleans preview ownership when a live workspace is destroyed', () => {
    usePreviewStateStore.getState().upsert('workspace-1', snapshot())
    usePreviewMiniPlayerStore.getState().open('workspace-1', 'server-tab')
    cleanupWorkspacePreview('workspace-1')
    expect(
      usePreviewStateStore.getState().byWorkspaceId['workspace-1']
    ).toBeUndefined()
    expect(
      usePreviewMiniPlayerStore.getState().byWorkspaceId['workspace-1']
    ).toBeUndefined()
    expect(recording.cancel).toHaveBeenCalledWith(
      'workspace-1:pending:server-tab'
    )
  })
})
