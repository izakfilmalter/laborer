/**
 * Regression coverage for the workspace right-panel store, ported from
 * t3code's `rightPanelStore`: surface upsert/activate/close behavior,
 * fallback selection, visibility toggling, workspace pruning, and the
 * persisted-state migration scaffolding.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  migratePersistedRightPanelState,
  selectActiveRightPanel,
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
  useRightPanelStore.setState({ byWorkspaceId: {} })
})

describe('open', () => {
  it('opens the panel with a singleton surface active', () => {
    store().open(WS, 'diff')

    expect(wsState()).toEqual({
      isOpen: true,
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

  it('keeps workspaces independent', () => {
    store().open(WS, 'diff')
    store().open(OTHER_WS, 'pull-request')

    expect(wsState(WS).activeSurfaceId).toBe('diff')
    expect(wsState(OTHER_WS).activeSurfaceId).toBe('pull-request')
  })
})

describe('activateSurface', () => {
  it('activates an existing surface and reopens the panel', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().close(WS)

    store().activateSurface(WS, 'diff')

    expect(wsState().isOpen).toBe(true)
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('ignores unknown surface ids', () => {
    store().open(WS, 'diff')
    store().activateSurface(WS, 'agents')

    expect(wsState().activeSurfaceId).toBe('diff')
  })
})

describe('closeSurface', () => {
  it('falls back to the neighbor when the active surface closes', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'agents')
    store().activateSurface(WS, 'pull-request')

    store().closeSurface(WS, 'pull-request')

    // Fallback picks the surface now sitting at the closed index.
    expect(wsState().surfaces.map((surface) => surface.id)).toEqual([
      'diff',
      'agents',
    ])
    expect(wsState().activeSurfaceId).toBe('agents')
  })

  it('keeps the active surface when a background surface closes', () => {
    store().open(WS, 'diff')
    store().open(WS, 'agents')

    store().closeSurface(WS, 'diff')

    expect(wsState().activeSurfaceId).toBe('agents')
  })

  it('removes the workspace entry entirely when the last surface closes', () => {
    store().open(WS, 'diff')
    store().closeSurface(WS, 'diff')

    expect(WS in store().byWorkspaceId).toBe(false)
    expect(wsState()).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })
})

describe('closeOtherSurfaces', () => {
  it('keeps only the named surface and activates it', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'agents')

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
    store().open(WS, 'agents')

    store().closeSurfacesToRight(WS, 'diff')

    expect(wsState().surfaces.map((surface) => surface.id)).toEqual(['diff'])
    expect(wsState().activeSurfaceId).toBe('diff')
  })

  it('keeps the active surface when it survives the cut', () => {
    store().open(WS, 'diff')
    store().open(WS, 'pull-request')
    store().open(WS, 'agents')
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
  it('clears surfaces and hides the panel (entry pruned)', () => {
    store().open(WS, 'diff')
    store().open(WS, 'agents')

    store().closeAllSurfaces(WS)

    expect(WS in store().byWorkspaceId).toBe(false)
  })
})

describe('visibility', () => {
  it('toggleVisibility hides the panel but keeps its tabs', () => {
    store().open(WS, 'diff')
    store().toggleVisibility(WS)

    expect(wsState().isOpen).toBe(false)
    expect(wsState().surfaces).toHaveLength(1)
    expect(selectActiveRightPanel(store().byWorkspaceId, WS)).toBeNull()
    expect(selectSelectedRightPanelSurface(store().byWorkspaceId, WS)?.id).toBe(
      'diff'
    )
  })

  it('toggleVisibility opens an empty panel (the launcher state)', () => {
    store().toggleVisibility(WS)

    expect(wsState()).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('toggle(kind) hides the panel when that kind is already active', () => {
    store().open(WS, 'diff')
    store().toggle(WS, 'diff')

    expect(wsState().isOpen).toBe(false)

    store().toggle(WS, 'diff')
    expect(wsState().isOpen).toBe(true)
    expect(wsState().activeSurfaceId).toBe('diff')
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

  it('is a no-op when nothing matches', () => {
    store().open(WS, 'diff')
    const before = store().byWorkspaceId

    store().removeWorkspaces(['never-existed'])

    expect(store().byWorkspaceId).toBe(before)
  })
})

describe('persistence', () => {
  it('writes state under the versioned localStorage key', () => {
    store().open(WS, 'diff')

    const raw = window.localStorage.getItem('laborer:right-panel-state:v1')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? '{}') as {
      state: { byWorkspaceId: Record<string, unknown> }
      version: number
    }
    expect(parsed.version).toBe(1)
    expect(WS in parsed.state.byWorkspaceId).toBe(true)
  })
})

describe('migratePersistedRightPanelState', () => {
  it('returns an empty map for garbage input', () => {
    expect(migratePersistedRightPanelState(null)).toEqual({ byWorkspaceId: {} })
    expect(migratePersistedRightPanelState('nope')).toEqual({
      byWorkspaceId: {},
    })
    expect(migratePersistedRightPanelState({ byWorkspaceId: 42 })).toEqual({
      byWorkspaceId: {},
    })
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

    expect(migrated.byWorkspaceId[WS]).toEqual({
      isOpen: true,
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

    expect(migrated.byWorkspaceId[WS]).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('normalizes file surfaces and validates terminal surfaces', () => {
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
            { id: 'terminal:mismatch', kind: 'terminal', resourceId: 'other' },
            {
              id: 'terminal:t1',
              kind: 'terminal',
              resourceId: 't1',
              terminalIds: ['t1', 't2', 't2'],
              activeTerminalId: 'gone',
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
      {
        id: 'terminal:t1',
        kind: 'terminal',
        resourceId: 't1',
        terminalIds: ['t1', 't2'],
        activeTerminalId: 't1',
      },
    ])
  })
})
