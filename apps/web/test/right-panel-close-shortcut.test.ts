/**
 * Regression coverage for Cmd+W aimed at a right-panel tab.
 *
 * The right panel is not a pane, so before this the progressive close chain
 * resolved the keystroke against the last focused pane and closed a terminal
 * beside the tab the user was pointing at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeActiveRightPanelSurface } from '@/components/right-panel/close-right-panel-surfaces'
import { usePreviewStateStore } from '@/preview-state-store'
import {
  rightPanelWorkspaceIdForTarget,
  useRightPanelFocusStore,
} from '@/right-panel-focus-store'
import {
  selectWorkspaceRightPanelState,
  useRightPanelStore,
} from '@/right-panel-store'

const WS = 'workspace-1'

const store = () => useRightPanelStore.getState()
const wsState = () => selectWorkspaceRightPanelState(store().byWorkspaceId, WS)

beforeEach(() => {
  window.localStorage.clear()
  useRightPanelStore.setState({ byWorkspaceId: {} })
  useRightPanelFocusStore.setState({ focusedWorkspaceId: null })
  document.body.innerHTML = ''
})

describe('closeActiveRightPanelSurface', () => {
  it('closes the active surface and reports the keystroke consumed', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')

    const closed = closeActiveRightPanelSurface({
      closePreview: vi.fn(() => Promise.resolve()),
      workspaceId: WS,
    })

    expect(closed).toBe(true)
    expect(wsState().surfaces).toEqual([{ id: 'diff', kind: 'diff' }])
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('leaves the chain to the panes when the workspace has no surfaces', () => {
    expect(
      closeActiveRightPanelSurface({
        closePreview: vi.fn(() => Promise.resolve()),
        workspaceId: WS,
      })
    ).toBe(false)
  })

  it('leaves the chain to the panes while the panel is hidden', () => {
    store().open(WS, 'diff')
    store().close(WS)

    expect(
      closeActiveRightPanelSurface({
        closePreview: vi.fn(() => Promise.resolve()),
        workspaceId: WS,
      })
    ).toBe(false)
    expect(wsState().surfaces).toHaveLength(1)
  })

  it('ends the browser session behind a closed browser tab', () => {
    store().openBrowser(WS, 'tab-1')
    const closePreview = vi.fn(() => Promise.resolve())

    closeActiveRightPanelSurface({ closePreview, workspaceId: WS })

    expect(closePreview).toHaveBeenCalledWith({
      payload: { tabId: 'tab-1', workspaceId: WS },
    })
    expect(
      usePreviewStateStore.getState().byWorkspaceId[WS]?.suppressedTabIds
    ).toContain('tab-1')
  })
})

describe('rightPanelWorkspaceIdForTarget', () => {
  it('names the workspace whose right panel contains the target', () => {
    document.body.innerHTML = `
      <div data-right-panel data-workspace-id="${WS}">
        <button id="tab" type="button">Diff</button>
      </div>
    `

    expect(rightPanelWorkspaceIdForTarget(document.getElementById('tab'))).toBe(
      WS
    )
  })

  it('is null outside any right panel', () => {
    document.body.innerHTML = '<div id="pane"></div>'

    expect(
      rightPanelWorkspaceIdForTarget(document.getElementById('pane'))
    ).toBe(null)
    expect(rightPanelWorkspaceIdForTarget(null)).toBe(null)
  })
})
