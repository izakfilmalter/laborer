import type { DesktopBridge } from '@laborer/shared/desktop-bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localApi } from '@/lib/local-api'

const installDesktopBridge = (bridge: Partial<DesktopBridge>) => {
  Object.defineProperty(window, 'desktopBridge', {
    configurable: true,
    value: bridge,
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopBridge')
  vi.restoreAllMocks()
})

describe('LocalApi', () => {
  it('uses browser fallbacks without exposing Electron checks to callers', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    const folderFallback = vi.fn(async () => '/daemon/project')
    const menuFallback = vi.fn(async () => 'copy' as const)

    expect(await localApi.openExternal('https://example.com')).toBe(true)
    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer'
    )
    expect(await localApi.pickFolder(folderFallback)).toBe('/daemon/project')
    expect(
      await localApi.showContextMenu(
        [{ id: 'copy', label: 'Copy' }],
        { x: 4, y: 8 },
        menuFallback
      )
    ).toBe('copy')
  })

  it('preserves native desktop implementations', async () => {
    const pickFolder = vi.fn(async () => '/native/project')
    const openExternal = vi.fn(async () => true)
    const showContextMenu = vi.fn(async () => 'open')
    installDesktopBridge({ openExternal, pickFolder, showContextMenu })
    const folderFallback = vi.fn(async () => '/browser/project')
    const menuFallback = vi.fn(async () => null)

    expect(await localApi.pickFolder(folderFallback)).toBe('/native/project')
    expect(await localApi.openExternal('https://example.com')).toBe(true)
    expect(
      await localApi.showContextMenu(
        [{ id: 'open', label: 'Open' }],
        undefined,
        menuFallback
      )
    ).toBe('open')
    expect(folderFallback).not.toHaveBeenCalled()
    expect(menuFallback).not.toHaveBeenCalled()
  })
})
