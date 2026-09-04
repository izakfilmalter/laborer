/**
 * Regression coverage for the right-panel store, ported from t3code's
 * `rightPanelStore`: surface upsert/activate/close behavior, fallback
 * selection, the window-wide visibility and selection, workspace pruning,
 * and the persisted-state migration.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  migratePersistedRightPanelState,
  resolveRightPanelWorkspaceId,
  selectActiveRightPanel,
  selectRightPanelSurfaceCount,
  selectSelectedRightPanelSurface,
  selectWorkspaceRightPanelState,
  useRightPanelStore,
} from '@/right-panel-store'

const WS = 'workspace-1'
const OTHER_WS = 'workspace-2'

const store = () => useRightPanelStore.getState()
const wsState = (workspaceId = WS) =>
  selectWorkspaceRightPanelState(store().byWorkspaceId, workspaceId)

beforeEach(() => {
  window.localStorage.clear()
  useRightPanelStore.setState({
    byWorkspaceId: {},
    isOpen: false,
    selectedWorkspaceId: null,
  })
})

describe('open', () => {
  it('shows the panel on that workspace with a singleton surface active', () => {
    store().open(WS, 'diff')

    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBe(WS)
    expect(wsState()).toEqual({
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
  })

  it('does not duplicate an already-open singleton surface', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'diff')

    expect(wsState().surfaces).toHaveLength(2)
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('keeps each workspace its own tab strip while the panel follows the opener', () => {
    store().open(WS, 'diff')
    store().open(OTHER_WS, 'pull-request')

    expect(wsState(WS).activeSurfaceId).toBe('diff')
    expect(wsState(OTHER_WS).activeSurfaceId).toBe('pull-request')
    expect(store().selectedWorkspaceId).toBe(OTHER_WS)
    expect(selectActiveRightPanel(store(), WS)).toBeNull()
    expect(selectActiveRightPanel(store(), OTHER_WS)).toBe('pull-request')
  })
})

describe('browser surface reconciliation', () => {
  it('replaces the placeholder and preserves existing browser order', () => {
    store().open(WS, 'preview')
    store().open(WS, 'diff')
    store().reconcileBrowserSurfaces(WS, ['tab-b', 'tab-c'])

    expect(wsState().surfaces).toEqual([
      { id: 'diff', kind: 'diff' },
      { id: 'browser:tab-b', kind: 'preview', resourceId: 'tab-b' },
      { id: 'browser:tab-c', kind: 'preview', resourceId: 'tab-c' },
    ])
    expect(wsState().activeSurfaceId).toBe('diff')

    store().activateSurface(WS, 'browser:tab-c')
    store().reconcileBrowserSurfaces(WS, ['tab-a', 'tab-c'])
    expect(wsState().surfaces.map((surface) => surface.id)).toEqual([
      'diff',
      'browser:tab-c',
      'browser:tab-a',
    ])
    expect(wsState().activeSurfaceId).toBe('browser:tab-c')
  })

  it('does not touch another workspace', () => {
    store().openBrowser(OTHER_WS, 'other-tab')
    store().reconcileBrowserSurfaces(WS, ['tab'])
    expect(wsState(OTHER_WS).surfaces).toEqual([
      { id: 'browser:other-tab', kind: 'preview', resourceId: 'other-tab' },
    ])
  })
})

describe('activateSurface', () => {
  it('activates an existing surface and reopens the panel on that workspace', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().close()

    store().activateSurface(WS, 'diff')

    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBe(WS)
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('ignores unknown surface ids', () => {
    store().open(WS, 'diff')
    store().close()
    store().activateSurface(WS, 'files')

    expect(wsState().activeSurfaceId).toBe('diff')
    expect(store().isOpen).toBe(false)
  })
})

describe('closeSurface', () => {
  it('falls back to the neighbor when the active surface closes', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'files')
    store().activateSurface(WS, 'pull-request')

    store().closeSurface(WS, 'pull-request')

    // Fallback picks the surface now sitting at the closed index.
    expect(wsState().surfaces.map((surface) => surface.id)).toEqual([
      'diff',
      'files',
    ])
    expect(wsState().activeSurfaceId).toBe('files')
  })

  it('keeps the active surface when a background surface closes', () => {
    store().open(WS, 'diff')
    store().open(WS, 'files')

    store().closeSurface(WS, 'diff')

    expect(wsState().activeSurfaceId).toBe('files')
  })

  it('removes the workspace entry entirely when the last surface closes', () => {
    store().open(WS, 'diff')
    store().closeSurface(WS, 'diff')

    expect(WS in store().byWorkspaceId).toBe(false)
    expect(wsState()).toEqual({ activeSurfaceId: null, surfaces: [] })
  })

  it('leaves the panel showing the empty-state launcher', () => {
    store().open(WS, 'diff')
    store().closeSurface(WS, 'diff')

    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBe(WS)
  })
})

describe('closeOtherSurfaces', () => {
  it('keeps only the named surface and activates it', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'files')

    store().closeOtherSurfaces(WS, 'pull-request')

    expect(wsState().surfaces.map((surface) => surface.id)).toEqual([
      'pull-request',
    ])
    expect(wsState().activeSurfaceId).toBe('pull-request')
  })
})

describe('closeSurfacesToRight', () => {
  it('drops surfaces after the named one', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'files')

    store().closeSurfacesToRight(WS, 'diff')

    expect(wsState().surfaces.map((surface) => surface.id)).toEqual(['diff'])
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('keeps the active surface when it survives the cut', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'files')
    store().activateSurface(WS, 'diff')

    store().closeSurfacesToRight(WS, 'pull-request')

    expect(wsState().surfaces.map((surface) => surface.id)).toEqual([
      'diff',
      'pull-request',
    ])
    expect(wsState().activeSurfaceId).toBe('diff')
  })
})

describe('closeAllSurfaces', () => {
  it('clears the workspace entry but leaves the panel showing', () => {
    store().open(WS, 'diff')
    store().open(WS, 'files')

    store().closeAllSurfaces(WS)

    expect(WS in store().byWorkspaceId).toBe(false)
    expect(store().isOpen).toBe(true)
  })
})

describe('visibility', () => {
  it('toggleVisibility hides the panel but keeps its tabs and selection', () => {
    store().open(WS, 'diff')
    store().toggleVisibility()

    expect(store().isOpen).toBe(false)
    expect(store().selectedWorkspaceId).toBe(WS)
    expect(wsState().surfaces).toHaveLength(1)
    expect(selectActiveRightPanel(store(), WS)).toBeNull()
    expect(selectSelectedRightPanelSurface(store().byWorkspaceId, WS)?.id).toBe(
      'diff'
    )
  })

  it('toggleVisibility shows an empty panel (the launcher state)', () => {
    store().toggleVisibility()

    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBeNull()
    expect(store().byWorkspaceId).toEqual({})
  })

  it('show points the panel at a workspace and close hides it', () => {
    store().show(WS)
    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBe(WS)

    store().close()
    expect(store().isOpen).toBe(false)
    expect(store().selectedWorkspaceId).toBe(WS)
  })

  it('selectWorkspace retargets the panel without showing it', () => {
    store().selectWorkspace(WS)

    expect(store().selectedWorkspaceId).toBe(WS)
    expect(store().isOpen).toBe(false)
  })

  it('toggle(kind) hides the panel when that kind is already active', () => {
    store().open(WS, 'diff')
    store().toggle(WS, 'diff')

    expect(store().isOpen).toBe(false)

    store().toggle(WS, 'diff')
    expect(store().isOpen).toBe(true)
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('toggle(kind) retargets rather than hides when another workspace is shown', () => {
    store().open(WS, 'diff')
    store().open(OTHER_WS, 'files')

    store().toggle(WS, 'diff')

    expect(store().isOpen).toBe(true)
    expect(store().selectedWorkspaceId).toBe(WS)
    expect(selectActiveRightPanel(store(), WS)).toBe('diff')
  })
})

describe('removeWorkspaces', () => {
  it('prunes only the named workspaces', () => {
    store().open(WS, 'diff')
    store().open(OTHER_WS, 'pull-request')

    store().removeWorkspaces([WS, 'never-existed'])

    expect(WS in store().byWorkspaceId).toBe(false)
    expect(OTHER_WS in store().byWorkspaceId).toBe(true)
  })

  it('drops a selection that named a removed workspace', () => {
    store().open(WS, 'diff')

    store().removeWorkspaces([WS])

    expect(store().selectedWorkspaceId).toBeNull()
  })

  it('is a no-op when nothing matches', () => {
    store().open(WS, 'diff')
    const before = store().byWorkspaceId

    store().removeWorkspaces(['never-existed'])

    expect(store().byWorkspaceId).toBe(before)
    expect(store().selectedWorkspaceId).toBe(WS)
  })
})

describe('selectRightPanelSurfaceCount', () => {
  it('counts a workspace tab strip whether or not the panel shows it', () => {
    store().open(WS, 'diff')
    store().open(WS, 'files')
    store().open(OTHER_WS, 'pull-request')

    expect(selectRightPanelSurfaceCount(store().byWorkspaceId, WS)).toBe(2)
    expect(selectRightPanelSurfaceCount(store().byWorkspaceId, OTHER_WS)).toBe(
      1
    )
    expect(selectRightPanelSurfaceCount(store().byWorkspaceId, 'gone')).toBe(0)
    expect(selectRightPanelSurfaceCount(store().byWorkspaceId, null)).toBe(0)
  })
})

describe('resolveRightPanelWorkspaceId', () => {
  it('honors an explicit selection that is still open', () => {
    expect(
      resolveRightPanelWorkspaceId({ selectedWorkspaceId: OTHER_WS }, WS, [
        WS,
        OTHER_WS,
      ])
    ).toBe(OTHER_WS)
  })

  it('follows the focused workspace when nothing is selected', () => {
    expect(
      resolveRightPanelWorkspaceId({ selectedWorkspaceId: null }, WS, [
        WS,
        OTHER_WS,
      ])
    ).toBe(WS)
  })

  it('falls back to the first open workspace when the selection closed', () => {
    expect(
      resolveRightPanelWorkspaceId(
        { selectedWorkspaceId: 'gone' },
        'also-gone',
        [OTHER_WS, WS]
      )
    ).toBe(OTHER_WS)
  })

  it('is null when no workspace is open', () => {
    expect(
      resolveRightPanelWorkspaceId({ selectedWorkspaceId: WS }, WS, [])
    ).toBeNull()
  })
})

describe('persistence', () => {
  it('writes state under the versioned localStorage key', () => {
    store().open(WS, 'diff')

    const raw = window.localStorage.getItem('laborer:right-panel-state:v1')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? '{}') as {
      state: {
        byWorkspaceId: Record<string, unknown>
        isOpen: boolean
        selectedWorkspaceId: string | null
      }
      version: number
    }
    expect(parsed.version).toBe(2)
    expect(WS in parsed.state.byWorkspaceId).toBe(true)
    expect(parsed.state.isOpen).toBe(true)
    expect(parsed.state.selectedWorkspaceId).toBe(WS)
  })
})

describe('migratePersistedRightPanelState', () => {
  const EMPTY = { byWorkspaceId: {}, isOpen: false, selectedWorkspaceId: null }

  it('returns an empty map for garbage input', () => {
    expect(migratePersistedRightPanelState(null)).toEqual(EMPTY)
    expect(migratePersistedRightPanelState('nope')).toEqual(EMPTY)
    expect(migratePersistedRightPanelState({ byWorkspaceId: 42 })).toEqual(
      EMPTY
    )
  })

  it('collapses per-workspace visibility into one window-wide flag', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: false,
          activeSurfaceId: 'diff',
          surfaces: [{ id: 'diff', kind: 'diff' }],
        },
        [OTHER_WS]: {
          isOpen: true,
          activeSurfaceId: 'files',
          surfaces: [{ id: 'files', kind: 'files' }],
        },
      },
    })

    expect(migrated.isOpen).toBe(true)
    expect(migrated.selectedWorkspaceId).toBeNull()
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
    expect(migrated.byWorkspaceId[OTHER_WS]).toEqual({
      activeSurfaceId: 'files',
      surfaces: [{ id: 'files', kind: 'files' }],
    })
  })

  it('leaves the panel hidden when no workspace persisted an open one', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: false,
          activeSurfaceId: 'diff',
          surfaces: [{ id: 'diff', kind: 'diff' }],
        },
      },
    })

    expect(migrated.isOpen).toBe(false)
    expect(migrated.byWorkspaceId[WS]?.surfaces).toHaveLength(1)
  })

  it('drops surfaces with unknown kinds and falls back the active id', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'plan',
          surfaces: [
            { id: 'plan', kind: 'plan' },
            { id: 'diff', kind: 'diff' },
          ],
        },
      },
    })

    expect(migrated.isOpen).toBe(true)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
  })

  it('does not reopen a panel whose surfaces were all dropped', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'plan',
          surfaces: [{ id: 'plan', kind: 'plan' }],
        },
      },
    })

    expect(migrated.isOpen).toBe(false)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('normalizes file surfaces', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'file:src/a.ts',
          surfaces: [
            {
              id: 'file:src/a.ts',
              kind: 'file',
              relativePath: 'src/a.ts',
              revealLine: Number.NaN,
              revealRequestId: 'bogus',
            },
          ],
        },
      },
    })

    expect(migrated.byWorkspaceId[WS]?.surfaces).toEqual([
      {
        id: 'file:src/a.ts',
        kind: 'file',
        relativePath: 'src/a.ts',
        revealLine: null,
        revealRequestId: 0,
      },
    ])
  })

  it('drops persisted terminal surfaces and falls back the active tab', () => {
    // Laborer has no Terminal surface: terminals live in the main panel
    // tabs/splits, so a persisted terminal descriptor (e.g. from a build
    // that still wrote one) must vanish without reopening an empty panel
    // or leaving the active id dangling.
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'terminal:t1',
          surfaces: [
            {
              id: 'terminal:t1',
              kind: 'terminal',
              resourceId: 't1',
              terminalIds: ['t1'],
              activeTerminalId: 't1',
            },
            { id: 'diff', kind: 'diff' },
          ],
        },
      },
    })

    expect(migrated.isOpen).toBe(true)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
  })

  it('drops persisted agents surfaces and falls back the active tab', () => {
    // Laborer skips the Agents surface, so a persisted agents descriptor
    // (from a build that still offered one) must vanish without reopening
    // an empty panel or leaving the active id dangling.
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'agents',
          surfaces: [
            { id: 'agents', kind: 'agents' },
            { id: 'diff', kind: 'diff' },
          ],
        },
      },
    })

    expect(migrated.isOpen).toBe(true)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
  })

  it('closes the panel when agents surfaces were all it had', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'agents',
          surfaces: [{ id: 'agents', kind: 'agents' }],
        },
      },
    })

    expect(migrated.isOpen).toBe(false)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('closes the panel when terminal surfaces were all it had', () => {
    const migrated = migratePersistedRightPanelState({
      byWorkspaceId: {
        [WS]: {
          isOpen: true,
          activeSurfaceId: 'terminal:t1',
          surfaces: [
            {
              id: 'terminal:t1',
              kind: 'terminal',
              resourceId: 't1',
              terminalIds: ['t1'],
              activeTerminalId: 't1',
            },
          ],
        },
      },
    })

    expect(migrated.isOpen).toBe(false)
    expect(migrated.byWorkspaceId[WS]).toEqual({
      activeSurfaceId: null,
      surfaces: [],
    })
  })
})
