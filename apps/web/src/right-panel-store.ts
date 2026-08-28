/**
 * Workspace-scoped right-panel surface state.
 *
 * Ported from t3code's `rightPanelStore.ts`. This is intentionally a shallow
 * workspace model: it owns an ordered set of surface descriptors and the
 * active surface, while each feature continues to own its durable resource
 * state. Browser surfaces point at preview tab ids, file surfaces point at
 * workspace paths, and diff/files/pull-request/agents remain singleton
 * surfaces.
 *
 * Laborer adaptations: t3 scopes the panel per thread
 * (`environmentId:threadId`); Laborer scopes it per workspace, so the map is
 * keyed by `workspaceId`. The pull-request surface is a singleton rather
 * than keyed by reference, because a Laborer workspace has at most one pull
 * request (the workspace id carries the identity). t3's terminal surface is
 * dropped entirely — Laborer terminals live in the main panel tabs/splits,
 * not the right panel — and migration silently discards any persisted
 * terminal descriptors.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const RIGHT_PANEL_KINDS = [
  'diff',
  'files',
  'file',
  'preview',
  'pull-request',
  'agents',
] as const
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number]

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: 'preview'; resourceId: string }
  | { id: 'browser:new'; kind: 'preview'; resourceId: null }
  | { id: 'diff'; kind: 'diff' }
  | { id: 'files'; kind: 'files' }
  | {
      id: `file:${string}`
      kind: 'file'
      relativePath: string
      revealLine: number | null
      revealRequestId: number
    }
  | { id: 'pull-request'; kind: 'pull-request' }
  | { id: 'agents'; kind: 'agents' }

const RIGHT_PANEL_STORAGE_KEY = 'laborer:right-panel-state:v1'
const RIGHT_PANEL_STORAGE_VERSION = 1

export interface WorkspaceRightPanelState {
  activeSurfaceId: string | null
  isOpen: boolean
  surfaces: RightPanelSurface[]
}

/** The kinds a caller can open without extra identity (singleton surfaces). */
type SingletonKind = Exclude<RightPanelKind, 'file' | 'preview'>

interface RightPanelStoreState {
  activateSurface: (workspaceId: string, surfaceId: string) => void
  byWorkspaceId: Record<string, WorkspaceRightPanelState>
  close: (workspaceId: string) => void
  closeAllSurfaces: (workspaceId: string) => void
  closeOtherSurfaces: (workspaceId: string, surfaceId: string) => void
  closeSurface: (workspaceId: string, surfaceId: string) => void
  closeSurfacesToRight: (workspaceId: string, surfaceId: string) => void
  open: (workspaceId: string, kind: SingletonKind | 'preview') => void
  openBrowser: (workspaceId: string, tabId: string | null) => void
  openFile: (workspaceId: string, relativePath: string, line?: number) => void
  /** Drop panel state for workspaces that no longer exist. */
  removeWorkspaces: (workspaceIds: readonly string[]) => void
  show: (workspaceId: string) => void
  toggle: (workspaceId: string, kind: SingletonKind | 'preview') => void
  toggleVisibility: (workspaceId: string) => void
}

const EMPTY_WORKSPACE_STATE: WorkspaceRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
}

const singletonSurface = (kind: SingletonKind): RightPanelSurface => {
  switch (kind) {
    case 'diff':
      return { id: 'diff', kind }
    case 'files':
      return { id: 'files', kind }
    case 'pull-request':
      return { id: 'pull-request', kind }
    case 'agents':
      return { id: 'agents', kind }
    default:
      return kind satisfies never
  }
}

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: 'preview', resourceId: tabId }
    : { id: 'browser:new', kind: 'preview', resourceId: null }

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: 'file',
  relativePath,
  revealLine,
  revealRequestId,
})

const upsertSurface = (
  current: WorkspaceRightPanelState,
  surface: RightPanelSurface,
  activate = true
): WorkspaceRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
})

const updateWorkspace = (
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string,
  updater: (current: WorkspaceRightPanelState) => WorkspaceRightPanelState
): Record<string, WorkspaceRightPanelState> => {
  const current = byWorkspaceId[workspaceId] ?? EMPTY_WORKSPACE_STATE
  const next = updater(current)
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0
  ) {
    if (!(workspaceId in byWorkspaceId)) {
      return byWorkspaceId
    }
    const { [workspaceId]: _removed, ...rest } = byWorkspaceId
    return rest
  }
  if (next === current) {
    return byWorkspaceId
  }
  return { ...byWorkspaceId, [workspaceId]: next }
}

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) {
    return null
  }
  return Math.max(1, Math.trunc(line))
}

/** A persisted file surface with its reveal fields coerced into range. */
function sanitizeFileSurface(
  surface: Extract<RightPanelSurface, { kind: 'file' }>
): RightPanelSurface[] {
  if (typeof surface.relativePath !== 'string') {
    return []
  }
  const revealLine =
    typeof surface.revealLine === 'number' &&
    Number.isFinite(surface.revealLine)
      ? Math.max(1, Math.trunc(surface.revealLine))
      : null
  const revealRequestId =
    typeof surface.revealRequestId === 'number' &&
    Number.isSafeInteger(surface.revealRequestId) &&
    surface.revealRequestId >= 0
      ? surface.revealRequestId
      : 0
  return [{ ...surface, revealLine, revealRequestId }]
}

/**
 * A persisted surface in the current shape, or nothing when malformed.
 * Unknown kinds — including t3's terminal surfaces, which Laborer never
 * hosts in the right panel — are silently dropped.
 */
function sanitizePersistedSurface(surface: unknown): RightPanelSurface[] {
  if (!surface || typeof surface !== 'object') {
    return []
  }
  const candidate = surface as RightPanelSurface
  if (!RIGHT_PANEL_KINDS.includes(candidate.kind)) {
    return []
  }
  if (candidate.kind === 'file') {
    return sanitizeFileSurface(candidate)
  }
  return [candidate]
}

/** One workspace's persisted panel state in the current shape. */
function sanitizePersistedWorkspaceState(
  workspaceState: unknown
): WorkspaceRightPanelState {
  const validState =
    workspaceState && typeof workspaceState === 'object'
      ? (workspaceState as WorkspaceRightPanelState)
      : null
  const surfaces = Array.isArray(validState?.surfaces)
    ? validState.surfaces.flatMap(sanitizePersistedSurface)
    : []
  const rawActiveSurfaceId = validState?.activeSurfaceId
  const persistedActiveSurfaceId = surfaces.some(
    (surface) => surface.id === rawActiveSurfaceId
  )
    ? (rawActiveSurfaceId ?? null)
    : null
  // A migration that dropped every surface must not reopen an empty panel.
  const isOpen =
    surfaces.length > 0 &&
    (typeof validState?.isOpen === 'boolean'
      ? validState.isOpen
      : persistedActiveSurfaceId !== null)
  // An open panel needs an active surface: if migration dropped the
  // persisted one, fall back to the first survivor instead of rendering an
  // open empty panel.
  const activeSurfaceId =
    persistedActiveSurfaceId ?? (isOpen ? (surfaces[0]?.id ?? null) : null)
  return { isOpen, surfaces, activeSurfaceId }
}

/**
 * Sanitize a persisted store payload into the current shape, dropping
 * anything malformed. Version 1 has no historical migrations; this is the
 * scaffolding future versions extend (t3's migrate pattern without its
 * accumulated history).
 */
export function migratePersistedRightPanelState(persistedState: unknown): {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>
} {
  if (!persistedState || typeof persistedState !== 'object') {
    return { byWorkspaceId: {} }
  }
  const byWorkspaceId =
    'byWorkspaceId' in persistedState &&
    persistedState.byWorkspaceId &&
    typeof persistedState.byWorkspaceId === 'object'
      ? Object.fromEntries(
          Object.entries(
            persistedState.byWorkspaceId as Record<string, unknown>
          ).map(([workspaceId, workspaceState]) => [
            workspaceId,
            sanitizePersistedWorkspaceState(workspaceState),
          ])
        )
      : {}
  return { byWorkspaceId }
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byWorkspaceId: {},
      open: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              if (kind === 'preview') {
                const existing = current.surfaces.find(
                  (surface) => surface.kind === 'preview'
                )
                return upsertSurface(current, existing ?? browserSurface(null))
              }
              return upsertSurface(current, singletonSurface(kind))
            }
          ),
        })),
      openBrowser: (workspaceId, tabId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const surface = browserSurface(tabId)
              const withoutPlaceholder = tabId
                ? current.surfaces.filter((entry) => entry.id !== 'browser:new')
                : current.surfaces
              return upsertSurface(
                { ...current, surfaces: withoutPlaceholder },
                surface
              )
            }
          ),
        })),
      openFile: (workspaceId, relativePath, line) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const withoutStandaloneExplorer = current.surfaces.filter(
                (surface) => surface.kind !== 'files'
              )
              const surfaceId = `file:${relativePath}` as const
              const existing = withoutStandaloneExplorer.find(
                (
                  surface
                ): surface is Extract<RightPanelSurface, { kind: 'file' }> =>
                  surface.id === surfaceId && surface.kind === 'file'
              )
              const surface = fileSurface(
                relativePath,
                normalizeRevealLine(line),
                (existing?.revealRequestId ?? 0) + 1
              )
              return {
                isOpen: true,
                activeSurfaceId: surface.id,
                surfaces: existing
                  ? withoutStandaloneExplorer.map((entry) =>
                      entry.id === surface.id ? surface : entry
                    )
                  : [...withoutStandaloneExplorer, surface],
              }
            }
          ),
        })),
      activateSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) =>
              current.surfaces.some((surface) => surface.id === surfaceId)
                ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
                : current
          ),
        })),
      closeSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const index = current.surfaces.findIndex(
                (surface) => surface.id === surfaceId
              )
              if (index < 0) {
                return current
              }
              const surfaces = current.surfaces.filter(
                (surface) => surface.id !== surfaceId
              )
              if (current.activeSurfaceId !== surfaceId) {
                return {
                  ...current,
                  isOpen: surfaces.length > 0 && current.isOpen,
                  surfaces,
                }
              }
              const fallback =
                surfaces[Math.min(index, surfaces.length - 1)] ?? null
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId: fallback?.id ?? null,
              }
            }
          ),
        })),
      closeOtherSurfaces: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const surface = current.surfaces.find(
                (entry) => entry.id === surfaceId
              )
              if (!surface || current.surfaces.length === 1) {
                return current
              }
              return {
                ...current,
                isOpen: true,
                surfaces: [surface],
                activeSurfaceId: surface.id,
              }
            }
          ),
        })),
      closeSurfacesToRight: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const index = current.surfaces.findIndex(
                (surface) => surface.id === surfaceId
              )
              if (index < 0 || index === current.surfaces.length - 1) {
                return current
              }
              const surfaces = current.surfaces.slice(0, index + 1)
              const activeStillExists = surfaces.some(
                (surface) => surface.id === current.activeSurfaceId
              )
              return {
                ...current,
                surfaces,
                activeSurfaceId: activeStillExists
                  ? current.activeSurfaceId
                  : surfaceId,
              }
            }
          ),
        })),
      closeAllSurfaces: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) =>
              current.surfaces.length === 0
                ? current
                : {
                    ...current,
                    isOpen: false,
                    surfaces: [],
                    activeSurfaceId: null,
                  }
          ),
        })),
      show: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) =>
              current.isOpen ? current : { ...current, isOpen: true }
          ),
        })),
      close: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) =>
              current.isOpen ? { ...current, isOpen: false } : current
          ),
        })),
      toggleVisibility: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => ({
              ...current,
              isOpen: !current.isOpen,
            })
          ),
        })),
      toggle: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const active = current.surfaces.find(
                (surface) => surface.id === current.activeSurfaceId
              )
              if (current.isOpen && active?.kind === kind) {
                return { ...current, isOpen: false }
              }
              if (kind === 'preview') {
                const existing = current.surfaces.find(
                  (surface) => surface.kind === 'preview'
                )
                return upsertSurface(current, existing ?? browserSurface(null))
              }
              return upsertSurface(current, singletonSurface(kind))
            }
          ),
        })),
      removeWorkspaces: (workspaceIds) =>
        set((state) => {
          const removable = workspaceIds.filter(
            (workspaceId) => workspaceId in state.byWorkspaceId
          )
          if (removable.length === 0) {
            return state
          }
          const rest = { ...state.byWorkspaceId }
          for (const workspaceId of removable) {
            delete rest[workspaceId]
          }
          return { byWorkspaceId: rest }
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : {
              getItem: () => null,
              removeItem: () => undefined,
              setItem: () => undefined,
            }
      ),
      migrate: migratePersistedRightPanelState,
    }
  )
)

export function selectWorkspaceRightPanelState(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined
): WorkspaceRightPanelState {
  if (!workspaceId) {
    return EMPTY_WORKSPACE_STATE
  }
  return byWorkspaceId[workspaceId] ?? EMPTY_WORKSPACE_STATE
}

export function selectActiveRightPanel(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined
): RightPanelKind | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId)
  if (!state.isOpen) {
    return null
  }
  return (
    state.surfaces.find((surface) => surface.id === state.activeSurfaceId)
      ?.kind ?? null
  )
}

export function selectActiveRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId)
  if (!state.isOpen) {
    return null
  }
  return selectSelectedRightPanelSurface(byWorkspaceId, workspaceId)
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId)
  return (
    state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ??
    null
  )
}
