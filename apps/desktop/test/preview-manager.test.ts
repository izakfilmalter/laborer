import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  class BrowserWindow {
    static instances: BrowserWindow[] = []
    static loadURL = () => Promise.resolve()

    readonly close = vi.fn(() => {
      this.destroyed = true
      this.closed?.()
    })
    readonly loadURL = vi.fn(() => BrowserWindow.loadURL())
    readonly setVisibleOnAllWorkspaces = vi.fn()
    readonly showInactive = vi.fn()
    readonly webContents = { send: vi.fn() }
    destroyed = false
    closed: (() => void) | undefined

    constructor() {
      BrowserWindow.instances.push(this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    once(event: string, handler: () => void): void {
      if (event === 'closed') {
        this.closed = handler
      }
    }
  }

  return { BrowserWindow, fromId: vi.fn() }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  webContents: { fromId: electron.fromId },
}))

import {
  isSafePreviewNavigation,
  normalizePreviewUrl,
  PreviewManager,
} from '../src/preview/Manager.js'

const owner = () => {
  const value = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }
  return value as unknown as WebContents & { send: typeof value.send }
}

const guest = (tabOwner: WebContents) => {
  const value = {
    capturePage: vi.fn(async () => ({
      getSize: () => ({ height: 0, width: 0 }),
    })),
    getTitle: vi.fn(() => 'Preview'),
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => 'http://localhost:3000/'),
    hostWebContents: tabOwner,
    id: 42,
    ipc: { on: vi.fn(), removeListener: vi.fn() },
    isCurrentlyAudible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    navigationHistory: {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
    },
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn(),
  }
  return value as unknown as WebContents & {
    capturePage: typeof value.capturePage
  }
}

const deferred = () => {
  let reject!: (reason: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('preview URL policy', () => {
  it('normalizes local addresses to HTTP and public hosts to HTTPS', () => {
    expect(normalizePreviewUrl('localhost:3000/path')).toBe(
      'http://localhost:3000/path'
    )
    expect(normalizePreviewUrl('example.com')).toBe('https://example.com/')
  })

  it('allows only HTTP(S) and the initial blank document', () => {
    expect(isSafePreviewNavigation('about:blank')).toBe(true)
    expect(isSafePreviewNavigation('https://example.com')).toBe(true)
    expect(isSafePreviewNavigation('http://localhost:3000')).toBe(true)
    expect(isSafePreviewNavigation('file:///etc/passwd')).toBe(false)
    expect(isSafePreviewNavigation('javascript:alert(1)')).toBe(false)
    expect(isSafePreviewNavigation('not a URL')).toBe(false)
    expect(() => normalizePreviewUrl('file:///etc/passwd')).toThrow(
      'Unsupported preview URL protocol'
    )
  })
})

describe('PreviewManager lifecycle', () => {
  beforeEach(() => {
    electron.fromId.mockReset()
    electron.BrowserWindow.instances = []
    electron.BrowserWindow.loadURL = () => Promise.resolve()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isolates tab ownership and emits a disposed state on close', async () => {
    const manager = new PreviewManager({
      artifactDirectory: '/tmp/laborer-preview-test',
      pickPreloadUrl: null,
      pictureInPicturePreloadPath: '/tmp/preview-pip-preload.cjs',
    })
    const firstOwner = owner()
    const secondOwner = owner()
    manager.createTab(firstOwner, 'tab-1')

    expect(() => manager.createTab(secondOwner, 'tab-1')).toThrow(
      'does not belong to this renderer'
    )
    await manager.closeTab(firstOwner, 'tab-1')
    expect(firstOwner.send).toHaveBeenLastCalledWith(
      'desktop:preview-state-change',
      'tab-1',
      expect.objectContaining({
        webContentsId: null,
        navStatus: { kind: 'Idle' },
      })
    )
    await expect(
      manager.navigate(firstOwner, 'tab-1', 'example.com')
    ).rejects.toThrow('Preview tab not found')
  })

  it('rejects non-webview and cross-window webContents registration', async () => {
    const manager = new PreviewManager({
      artifactDirectory: '/tmp/laborer-preview-test',
      pickPreloadUrl: null,
      pictureInPicturePreloadPath: '/tmp/preview-pip-preload.cjs',
    })
    const tabOwner = owner()
    manager.createTab(tabOwner, 'tab-1')
    electron.fromId.mockReturnValue({
      getType: () => 'window',
      hostWebContents: tabOwner,
      isDestroyed: () => false,
    })
    await expect(
      manager.registerWebview(tabOwner, 'tab-1', 42)
    ).rejects.toThrow('Invalid preview webContents')
  })

  it('rolls back PiP when the tab closes while its window is loading', async () => {
    vi.useFakeTimers()
    const load = deferred()
    electron.BrowserWindow.loadURL = () => load.promise
    const manager = new PreviewManager({
      artifactDirectory: '/tmp/laborer-preview-test',
      pickPreloadUrl: null,
      pictureInPicturePreloadPath: '/tmp/preview-pip-preload.cjs',
    })
    const tabOwner = owner()
    const tabGuest = guest(tabOwner)
    electron.fromId.mockReturnValue(tabGuest)
    manager.createTab(tabOwner, 'tab-1')
    await manager.registerWebview(tabOwner, 'tab-1', 42)

    const opening = manager.openPictureInPicture(tabOwner, 'tab-1')
    await manager.closeTab(tabOwner, 'tab-1')
    const window = electron.BrowserWindow.instances[0]
    load.resolve()

    await expect(opening).rejects.toThrow('closed while opening')
    expect(tabGuest.capturePage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(window?.close).toHaveBeenCalledOnce()
    expect(window?.isDestroyed()).toBe(true)
  })

  it('rolls back the PiP window when loading fails', async () => {
    vi.useFakeTimers()
    const loadError = new Error('PiP load failed')
    electron.BrowserWindow.loadURL = () => Promise.reject(loadError)
    const manager = new PreviewManager({
      artifactDirectory: '/tmp/laborer-preview-test',
      pickPreloadUrl: null,
      pictureInPicturePreloadPath: '/tmp/preview-pip-preload.cjs',
    })
    const tabOwner = owner()
    const tabGuest = guest(tabOwner)
    electron.fromId.mockReturnValue(tabGuest)
    manager.createTab(tabOwner, 'tab-1')
    await manager.registerWebview(tabOwner, 'tab-1', 42)

    await expect(
      manager.openPictureInPicture(tabOwner, 'tab-1')
    ).rejects.toThrow(loadError)
    const window = electron.BrowserWindow.instances[0]

    expect(tabGuest.capturePage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(window?.close).toHaveBeenCalledOnce()
    expect(window?.isDestroyed()).toBe(true)
    expect(tabOwner.send).toHaveBeenLastCalledWith(
      'desktop:preview-state-change',
      'tab-1',
      expect.objectContaining({ pictureInPicture: false })
    )
  })

  it('rejects artifact paths outside the owned artifact directory', () => {
    const manager = new PreviewManager({
      artifactDirectory: '/tmp/laborer-preview-test',
      pickPreloadUrl: null,
      pictureInPicturePreloadPath: '/tmp/preview-pip-preload.cjs',
    })

    expect(() => manager.revealArtifact('/etc/passwd')).toThrow(
      'outside the artifact directory'
    )
  })
})
