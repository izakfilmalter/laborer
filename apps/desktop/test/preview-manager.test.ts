import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fromId = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: class {},
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  webContents: { fromId },
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
  beforeEach(() => fromId.mockReset())

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
    fromId.mockReturnValue({
      getType: () => 'window',
      hostWebContents: tabOwner,
      isDestroyed: () => false,
    })
    await expect(
      manager.registerWebview(tabOwner, 'tab-1', 42)
    ).rejects.toThrow('Invalid preview webContents')
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
