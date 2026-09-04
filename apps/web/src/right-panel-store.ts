/**
 * Right-panel surface state: one panel per window, workspace-scoped tabs.
 *
 * Ported from t3code's `rightPanelStore.ts`. This is intentionally a shallow
 * workspace model: it owns an ordered set of surface descriptors and the
 * active surface, while each feature continues to own its durable resource
 * state. Browser surfaces point at preview tab ids, file surfaces point at
 * workspace paths, and diff/files/pull-request remain singleton surfaces.
 *
 * Visibility is global rather than per workspace: the window hosts a single
 * right panel, so `isOpen` says whether it is showing and
 * `selectedWorkspaceId` says whose surfaces it shows. The per-workspace map
 * still owns each workspace's tab strip, so switching the selection restores
 * the tabs that workspace last had.
 *
 * Laborer adaptations: t3 scopes the panel per thread
 * (`environmentId:threadId`); Laborer scopes it per workspace, so the map is
 * keyed by `workspaceId`. The pull-request surface is a singleton rather
 * than keyed by reference, because a Laborer workspace has at most one pull
 * request (the workspace id carries the identity). t3's terminal and agents
 * surfaces are dropped entirely — Laborer terminals live in the main panel
 * tabs/splits and Laborer skips the Agents surface — and migration silently
 * discards any persisted terminal or agents descriptors.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const RIGHT_PANEL_KINDS = [
  'diff',
  'files',
  'file',
  'preview',
  'pull-request',
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

const RIGHT_PANEL_STORAGE_KEY = 'laborer:right-panel-state:v1'
const RIGHT_PANEL_STORAGE_VERSION = 2

export interface WorkspaceRightPanelState {
  activeSurfaceId: string | null
  surfaces: RightPanelSurface[]
}

/** The kinds a caller can open without extra identity (singleton surfaces). */
type SingletonKind = Exclude<RightPanelKind, 'file' | 'preview'>

interface RightPanelStoreState {
  activateSurface: (workspaceId: string, surfaceId: string) => void
  byWorkspaceId: Record<string, WorkspaceRightPanelState>
  /** Hide the window's right panel; the tab strips survive. */
  close: () => void
  closeAllSurfaces: (workspaceId: string) => void
  closeOtherSurfaces: (workspaceId: string, surfaceId: string) => void
  closeSurface: (workspaceId: string, surfaceId: string) => void
  closeSurfacesToRight: (workspaceId: string, surfaceId: string) => void
  /** One panel per window: globally visible or hidden. */
  isOpen: boolean
  open: (workspaceId: string, kind: SingletonKind | 'preview') => void
  openBrowser: (workspaceId: string, tabId: string | null) => void
  openFile: (workspaceId: string, relativePath: string, line?: number) => void
  reconcileBrowserSurfaces: (
    workspaceId: string,
    tabIds: readonly string[]
  ) => void
  /** Drop panel state for workspaces that no longer exist. */
  removeWorkspaces: (workspaceIds: readonly string[]) => void
  /** Which open workspace's surfaces the panel shows. `null` follows the focused workspace. */
  selectedWorkspaceId: string | null
  /** Point the panel at a workspace without changing its visibility. */
  selectWorkspace: (workspaceId: string) => void
  show: (workspaceId: string) => void
  toggle: (workspaceId: string, kind: SingletonKind | 'preview') => void
  toggleVisibility: () => void
}

const EMPTY_WORKSPACE_STATE: WorkspaceRightPanelState = {
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
  if (next.activeSurfaceId === null && next.surfaces.length === 0) {
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
 * hosts in the right panel, and agents descriptors from builds that still
 * offered that surface — are silently dropped.
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

/**
 * One workspace's persisted panel state in the current shape, plus whether
 * that workspace claimed the panel was open. Version 1 stored visibility per
 * workspace; version 2 keeps a single window-wide flag, so the per-workspace
 * value survives only long enough to derive it.
 */
function sanitizePersistedWorkspaceState(workspaceState: unknown): {
  state: WorkspaceRightPanelState
  wasOpen: boolean
} {
  const validState =
    workspaceState && typeof workspaceState === 'object'
      ? (workspaceState as WorkspaceRightPanelState & { isOpen?: unknown })
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
  const wasOpen =
    surfaces.length > 0 &&
    (typeof validState?.isOpen === 'boolean'
      ? validState.isOpen
      : persistedActiveSurfaceId !== null)
  // An open panel needs an active surface: if migration dropped the
  // persisted one, fall back to the first survivor instead of rendering an
  // open empty panel.
  const activeSurfaceId =
    persistedActiveSurfaceId ?? (wasOpen ? (surfaces[0]?.id ?? null) : null)
  return { state: { surfaces, activeSurfaceId }, wasOpen }
}

/**
 * Sanitize a persisted store payload into the current shape, dropping
 * anything malformed.
 *
 * Version 1 → 2 collapses per-workspace visibility into one window-wide
 * flag: the panel reopens if any workspace persisted an open panel with
 * surfaces left after sanitization. The selection starts as `null` so the
 * panel follows the focused workspace on the first render after upgrade.
 */
export function migratePersistedRightPanelState(persistedState: unknown): {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>
  isOpen: boolean
  selectedWorkspaceId: string | null
} {
  const empty = { byWorkspaceId: {}, isOpen: false, selectedWorkspaceId: null }
  if (!persistedState || typeof persistedState !== 'object') {
    return empty
  }
  if (
    !(
      'byWorkspaceId' in persistedState &&
      persistedState.byWorkspaceId &&
      typeof persistedState.byWorkspaceId === 'object'
    )
  ) {
    return empty
  }
  const entries = Object.entries(
    persistedState.byWorkspaceId as Record<string, unknown>
  ).map(
    ([workspaceId, workspaceState]) =>
      [workspaceId, sanitizePersistedWorkspaceState(workspaceState)] as const
  )
  return {
    byWorkspaceId: Object.fromEntries(
      entries.map(([workspaceId, entry]) => [workspaceId, entry.state])
    ),
    isOpen: entries.some(([, entry]) => entry.wasOpen),
    selectedWorkspaceId: null,
  }
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byWorkspaceId: {},
      isOpen: false,
      selectedWorkspaceId: null,
      open: (workspaceId, kind) =>
        set((state) => ({
          isOpen: true,
          selectedWorkspaceId: workspaceId,
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
          isOpen: true,
          selectedWorkspaceId: workspaceId,
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
          isOpen: true,
          selectedWorkspaceId: workspaceId,
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
      reconcileBrowserSurfaces: (workspaceId, tabIds) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(
            state.byWorkspaceId,
            workspaceId,
            (current) => {
              const validIds = new Set(
                tabIds.map((tabId) => `browser:${tabId}`)
              )
              const nonBrowser = current.surfaces.filter(
                (surface) => surface.kind !== 'preview'
              )
              const existingBrowser = current.surfaces.filter(
                (
                  surface
                ): surface is Extract<RightPanelSurface, { kind: 'preview' }> =>
                  surface.kind === 'preview' &&
                  surface.id !== 'browser:new' &&
                  validIds.has(surface.id)
              )
              const knownIds = new Set(
                existingBrowser.map((surface) => surface.id)
              )
              const added = tabIds
                .filter((tabId) => !knownIds.has(`browser:${tabId}`))
                .map((tabId) => browserSurface(tabId))
              const surfaces = [...nonBrowser, ...existingBrowser, ...added]
              const activeStillExists = surfaces.some(
                (surface) => surface.id === current.activeSurfaceId
              )
              const fallbackBrowser = surfaces.find(
                (surface) => surface.kind === 'preview'
              )
              return {
                ...current,
                surfaces,
                activeSurfaceId: activeStillExists
                  ? current.activeSurfaceId
                  : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
              }
            }
          ),
        })),
      activateSurface: (workspaceId, surfaceId) =>
        set((state) => {
          const known =
            state.byWorkspaceId[workspaceId]?.surfaces.some(
              (surface) => surface.id === surfaceId
            ) ?? false
          if (!known) {
            return state
          }
          return {
            isOpen: true,
            selectedWorkspaceId: workspaceId,
            byWorkspaceId: updateWorkspace(
              state.byWorkspaceId,
              workspaceId,
              (current) => ({ ...current, activeSurfaceId: surfaceId })
            ),
          }
        }),
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
                return { ...current, surfaces }
              }
              const fallback =
                surfaces[Math.min(index, surfaces.length - 1)] ?? null
              return {
                ...current,
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
                : { ...current, surfaces: [], activeSurfaceId: null }
          ),
        })),
      show: (workspaceId) =>
        set(() => ({ isOpen: true, selectedWorkspaceId: workspaceId })),
      close: () => set(() => ({ isOpen: false })),
      selectWorkspace: (workspaceId) =>
        set(() => ({ selectedWorkspaceId: workspaceId })),
      toggleVisibility: () => set((state) => ({ isOpen: !state.isOpen })),
      toggle: (workspaceId, kind) =>
        set((state) => {
          const current = state.byWorkspaceId[workspaceId]
          const active = current?.surfaces.find(
            (surface) => surface.id === current.activeSurfaceId
          )
          if (
            state.isOpen &&
            state.selectedWorkspaceId === workspaceId &&
            active?.kind === kind
          ) {
            return { isOpen: false }
          }
          return {
            isOpen: true,
            selectedWorkspaceId: workspaceId,
            byWorkspaceId: updateWorkspace(
              state.byWorkspaceId,
              workspaceId,
              (entry) => {
                if (kind === 'preview') {
                  const existing = entry.surfaces.find(
                    (surface) => surface.kind === 'preview'
                  )
                  return upsertSurface(entry, existing ?? browserSurface(null))
                }
                return upsertSurface(entry, singletonSurface(kind))
              }
            ),
          }
        }),
      removeWorkspaces: (workspaceIds) =>
        set((state) => {
          const removable = workspaceIds.filter(
            (workspaceId) => workspaceId in state.byWorkspaceId
          )
          const selectionRemoved =
            state.selectedWorkspaceId !== null &&
            workspaceIds.includes(state.selectedWorkspaceId)
          if (removable.length === 0 && !selectionRemoved) {
            return state
          }
          const rest = { ...state.byWorkspaceId }
          for (const workspaceId of removable) {
            delete rest[workspaceId]
          }
          return {
            byWorkspaceId: rest,
            selectedWorkspaceId: selectionRemoved
              ? null
              : state.selectedWorkspaceId,
          }
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      partialize: (state) => ({
        byWorkspaceId: state.byWorkspaceId,
        isOpen: state.isOpen,
        selectedWorkspaceId: state.selectedWorkspaceId,
      }),
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

/** Whether the window's one panel is currently showing this workspace. */
function isShowingWorkspace(
  store: RightPanelVisibilityState,
  workspaceId: string | null | undefined
): boolean {
  return Boolean(
    workspaceId && store.isOpen && store.selectedWorkspaceId === workspaceId
  )
}

/** The slice of the store the visibility-aware selectors read. */
interface RightPanelVisibilityState {
  readonly byWorkspaceId: Record<string, WorkspaceRightPanelState>
  readonly isOpen: boolean
  readonly selectedWorkspaceId: string | null
}

export function selectActiveRightPanel(
  store: RightPanelVisibilityState,
  workspaceId: string | null | undefined
): RightPanelKind | null {
  if (!isShowingWorkspace(store, workspaceId)) {
    return null
  }
  return (
    selectSelectedRightPanelSurface(store.byWorkspaceId, workspaceId)?.kind ??
    null
  )
}

export function selectActiveRightPanelSurface(
  store: RightPanelVisibilityState,
  workspaceId: string | null | undefined
): RightPanelSurface | null {
  if (!isShowingWorkspace(store, workspaceId)) {
    return null
  }
  return selectSelectedRightPanelSurface(store.byWorkspaceId, workspaceId)
}

/** How many tabs a workspace's strip holds, open or hidden. */
export function selectRightPanelSurfaceCount(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined
): number {
  return selectWorkspaceRightPanelState(byWorkspaceId, workspaceId).surfaces
    .length
}

/**
 * Which workspace the single panel should show.
 *
 * An explicit selection wins while that workspace is still open; otherwise
 * the panel follows the focused workspace, and falls back to the first open
 * one so closing the selected workspace never leaves the panel blank.
 */
export function resolveRightPanelWorkspaceId(
  store: Pick<RightPanelVisibilityState, 'selectedWorkspaceId'>,
  activeWorkspaceId: string | null,
  openWorkspaceIds: readonly string[]
): string | null {
  const selected = store.selectedWorkspaceId
  if (selected !== null && openWorkspaceIds.includes(selected)) {
    return selected
  }
  if (
    activeWorkspaceId !== null &&
    openWorkspaceIds.includes(activeWorkspaceId)
  ) {
    return activeWorkspaceId
  }
  return openWorkspaceIds[0] ?? null
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
