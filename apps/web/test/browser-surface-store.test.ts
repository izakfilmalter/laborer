import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireBrowserSurface,
  useBrowserSurfaceStore,
} from '@/browser/browser-surface-store'

describe('browser surface leases', () => {
  beforeEach(() => useBrowserSurfaceStore.setState({ byTabId: {} }))

  it('rejects stale slots after a newer slot claims the same tab', () => {
    const stale = acquireBrowserSurface('tab')
    const current = acquireBrowserSurface('tab')
    expect(stale.present({ x: 0, y: 0, width: 10, height: 10 }, true)).toBe(
      false
    )
    expect(current.present({ x: 2, y: 3, width: 20, height: 30 }, true)).toBe(
      true
    )
    stale.release()
    expect(useBrowserSurfaceStore.getState().byTabId.tab?.visible).toBe(true)
    current.release()
    expect(useBrowserSurfaceStore.getState().byTabId.tab?.visible).toBe(false)
  })

  it('transfers geometry ownership to a fitted floating surface', () => {
    const panel = acquireBrowserSurface('tab')
    panel.present({ x: 400, y: 20, width: 600, height: 500 }, true)
    const floating = acquireBrowserSurface('tab', true)
    expect(useBrowserSurfaceStore.getState().byTabId.tab?.sourceRect).toEqual({
      x: 400,
      y: 20,
      width: 600,
      height: 500,
    })
    expect(
      floating.present({ x: 12, y: 12, width: 320, height: 200 }, true, 12)
    ).toBe(true)
    panel.release()
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      fitSourceContent: true,
      visible: true,
      cornerRadius: 12,
    })
    floating.release()
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      fitSourceContent: false,
      owner: null,
      visible: false,
    })
  })
})
