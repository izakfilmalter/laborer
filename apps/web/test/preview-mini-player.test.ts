import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
} from '@/components/preview/preview-mini-player-layout'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'

describe('preview mini-player', () => {
  beforeEach(() => usePreviewMiniPlayerStore.setState({ byWorkspaceId: {} }))

  it('keeps placement isolated by workspace and across resource switches', () => {
    const store = usePreviewMiniPlayerStore.getState()
    store.open('workspace-a', 'tab-a')
    store.move('workspace-a', 'tab-a', { x: 24, y: 48 })
    store.resize('workspace-a', 'tab-a', { width: 480, height: 320 })
    store.open('workspace-b', 'tab-b')
    store.open('workspace-a', 'tab-c')

    expect(
      usePreviewMiniPlayerStore.getState().byWorkspaceId['workspace-a']
    ).toEqual({
      position: { x: 24, y: 48 },
      size: { width: 480, height: 320 },
      tabId: 'tab-c',
    })
    expect(
      usePreviewMiniPlayerStore.getState().byWorkspaceId['workspace-b']?.tabId
    ).toBe('tab-b')
  })

  it('ignores stale geometry updates after ownership moves to another tab', () => {
    const store = usePreviewMiniPlayerStore.getState()
    store.open('workspace', 'current')
    store.move('workspace', 'stale', { x: 500, y: 500 })
    store.resize('workspace', 'stale', { width: 900, height: 900 })
    expect(
      usePreviewMiniPlayerStore.getState().byWorkspaceId.workspace
    ).toEqual({ position: null, size: null, tabId: 'current' })
  })

  it('clamps position and size inside narrow workspace frames', () => {
    const size = clampPreviewMiniPlayerSize(
      { width: 520, height: 360 },
      { width: 250, height: 180 }
    )
    expect(size).toEqual({ width: 226, height: 156 })
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 900, y: -20 },
        { width: 250, height: 180 },
        size
      )
    ).toEqual({ x: 12, y: 12 })
  })
})
