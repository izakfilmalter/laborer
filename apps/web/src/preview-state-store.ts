// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: this is a near-verbatim state-machine port; keeping event and reconciliation transitions together makes ordering auditable.
import type { DesktopPreviewTabState } from '@laborer/shared/desktop-bridge'
import type {
  PreviewEvent,
  PreviewListResult,
  PreviewSessionSnapshot,
} from '@laborer/shared/rpc'
import { create } from 'zustand'

export interface PreviewDesktopOverlay {
  readonly audible: boolean
  readonly audioMuted: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly colorScheme: DesktopPreviewTabState['colorScheme']
  readonly controller: DesktopPreviewTabState['controller']
  readonly favicon: DesktopPreviewTabState['favicon'] | null
  readonly hasWebContents: boolean
  readonly loading: boolean
  readonly pictureInPicture: boolean
  readonly zoomFactor: number
}

export interface WorkspacePreviewState {
  readonly activeTabId: string | null
  readonly desktopByTabId: Record<string, PreviewDesktopOverlay>
  readonly recentlySeenUrls: readonly string[]
  readonly serverEpoch: string | null
  readonly serverRevision: number
  readonly sessions: Record<string, PreviewSessionSnapshot>
  readonly suppressedTabIds: ReadonlySet<string>
}

const EMPTY: WorkspacePreviewState = {
  activeTabId: null,
  desktopByTabId: {},
  recentlySeenUrls: [],
  serverEpoch: null,
  serverRevision: 0,
  sessions: {},
  suppressedTabIds: new Set(),
}

const rememberUrl = (
  urls: readonly string[],
  snapshot: PreviewSessionSnapshot
) => {
  const status = snapshot.navStatus
  return status._tag === 'Idle'
    ? urls
    : [status.url, ...urls.filter((url) => url !== status.url)].slice(0, 8)
}

const latest = (sessions: Record<string, PreviewSessionSnapshot>) =>
  Object.values(sessions)
    .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1) ?? null

const removeSession = (
  state: WorkspacePreviewState,
  tabId: string
): WorkspacePreviewState => {
  if (!state.sessions[tabId]) {
    return state
  }
  const { [tabId]: _session, ...sessions } = state.sessions
  const { [tabId]: _desktop, ...desktopByTabId } = state.desktopByTabId
  const fallback = latest(sessions)
  return {
    ...state,
    sessions,
    desktopByTabId,
    activeTabId:
      state.activeTabId === tabId
        ? (fallback?.tabId ?? null)
        : state.activeTabId,
  }
}

interface PreviewStore {
  readonly applyDesktopState: (
    workspaceId: string,
    tabId: string,
    state: DesktopPreviewTabState | null
  ) => void
  readonly applyEvent: (event: PreviewEvent) => void
  readonly beginClose: (workspaceId: string, tabId: string) => void
  readonly byWorkspaceId: Record<string, WorkspacePreviewState>
  readonly cancelClose: (
    workspaceId: string,
    tabId: string,
    snapshot?: PreviewSessionSnapshot
  ) => void
  readonly reconcile: (workspaceId: string, result: PreviewListResult) => void
  readonly removeWorkspace: (workspaceId: string) => void
  readonly setActive: (workspaceId: string, tabId: string) => void
  readonly setController: (
    workspaceId: string,
    tabId: string,
    controller: DesktopPreviewTabState['controller']
  ) => void
  readonly upsert: (
    workspaceId: string,
    snapshot: PreviewSessionSnapshot
  ) => void
}

const updateWorkspace = (
  byWorkspaceId: Record<string, WorkspacePreviewState>,
  workspaceId: string,
  update: (state: WorkspacePreviewState) => WorkspacePreviewState
) => ({
  ...byWorkspaceId,
  [workspaceId]: update(byWorkspaceId[workspaceId] ?? EMPTY),
})

export const usePreviewStateStore = create<PreviewStore>()((set) => ({
  byWorkspaceId: {},
  applyDesktopState: (workspaceId, tabId, desktopState) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => {
          const desktopByTabId = { ...state.desktopByTabId }
          if (desktopState) {
            desktopByTabId[tabId] = {
              audible: desktopState.audible,
              audioMuted: desktopState.audioMuted,
              canGoBack: desktopState.canGoBack,
              canGoForward: desktopState.canGoForward,
              colorScheme: desktopState.colorScheme,
              controller: desktopState.controller,
              favicon: desktopState.favicon ?? null,
              hasWebContents: desktopState.webContentsId !== null,
              loading: desktopState.navStatus.kind === 'Loading',
              pictureInPicture: desktopState.pictureInPicture,
              zoomFactor: desktopState.zoomFactor,
            }
          } else {
            delete desktopByTabId[tabId]
          }
          return { ...state, desktopByTabId }
        }
      ),
    })),
  setController: (workspaceId, tabId, controller) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => {
          const current = state.desktopByTabId[tabId]
          return current === undefined
            ? state
            : {
                ...state,
                desktopByTabId: {
                  ...state.desktopByTabId,
                  [tabId]: { ...current, controller },
                },
              }
        }
      ),
    })),
  applyEvent: (event) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        event.workspaceId,
        (state) => {
          if (
            state.serverEpoch !== null &&
            event.serverEpoch !== state.serverEpoch
          ) {
            return state
          }
          if (event.revision <= state.serverRevision) {
            return state
          }
          let next = state
          if (event.type === 'closed') {
            next = removeSession(state, event.tabId)
            if (next.suppressedTabIds.has(event.tabId)) {
              const suppressedTabIds = new Set(next.suppressedTabIds)
              suppressedTabIds.delete(event.tabId)
              next = { ...next, suppressedTabIds }
            }
          } else if (event.type === 'failed') {
            const previous = state.sessions[event.tabId]
            if (previous) {
              const snapshot: PreviewSessionSnapshot = {
                ...previous,
                updatedAt: event.createdAt,
                navStatus: {
                  _tag: 'LoadFailed',
                  code: event.code,
                  description: event.description,
                  title: event.title,
                  url: event.url,
                },
              }
              next = {
                ...state,
                sessions: { ...state.sessions, [event.tabId]: snapshot },
              }
            }
          } else if (!state.suppressedTabIds.has(event.tabId)) {
            const sessions = {
              ...state.sessions,
              [event.tabId]: event.snapshot,
            }
            next = {
              ...state,
              sessions,
              activeTabId:
                event.type === 'opened'
                  ? event.tabId
                  : (state.activeTabId ?? event.tabId),
              recentlySeenUrls: rememberUrl(
                state.recentlySeenUrls,
                event.snapshot
              ),
            }
          }
          return {
            ...next,
            serverEpoch: event.serverEpoch,
            serverRevision: event.revision,
          }
        }
      ),
    })),
  beginClose: (workspaceId, tabId) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => ({
          ...removeSession(state, tabId),
          suppressedTabIds: new Set(state.suppressedTabIds).add(tabId),
        })
      ),
    })),
  cancelClose: (workspaceId, tabId, snapshot) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => {
          const suppressedTabIds = new Set(state.suppressedTabIds)
          suppressedTabIds.delete(tabId)
          return snapshot
            ? {
                ...state,
                suppressedTabIds,
                sessions: { ...state.sessions, [tabId]: snapshot },
                activeTabId: tabId,
              }
            : { ...state, suppressedTabIds }
        }
      ),
    })),
  reconcile: (workspaceId, result) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => {
          const sameServer = state.serverEpoch === result.serverEpoch
          if (sameServer && result.revision < state.serverRevision) {
            return state
          }
          const suppressedTabIds = sameServer
            ? state.suppressedTabIds
            : new Set<string>()
          const sessions: Record<string, PreviewSessionSnapshot> = {}
          let recentlySeenUrls = state.recentlySeenUrls
          for (const incoming of result.sessions) {
            if (suppressedTabIds.has(incoming.tabId)) {
              continue
            }
            const existing = sameServer
              ? state.sessions[incoming.tabId]
              : undefined
            const snapshot =
              existing && existing.updatedAt > incoming.updatedAt
                ? existing
                : incoming
            sessions[snapshot.tabId] = snapshot
            recentlySeenUrls = rememberUrl(recentlySeenUrls, snapshot)
          }
          const fallback = latest(sessions)
          const activeTabId =
            state.activeTabId && sessions[state.activeTabId]
              ? state.activeTabId
              : (fallback?.tabId ?? null)
          return {
            ...state,
            sessions,
            activeTabId,
            recentlySeenUrls,
            serverEpoch: result.serverEpoch,
            serverRevision: result.revision,
            suppressedTabIds: new Set(
              [...suppressedTabIds].filter((tabId) =>
                result.sessions.some((snapshot) => snapshot.tabId === tabId)
              )
            ),
            desktopByTabId: sameServer
              ? Object.fromEntries(
                  Object.entries(state.desktopByTabId).filter(
                    ([tabId]) => sessions[tabId]
                  )
                )
              : {},
          }
        }
      ),
    })),
  removeWorkspace: (workspaceId) =>
    set((store) => {
      const { [workspaceId]: _removed, ...byWorkspaceId } = store.byWorkspaceId
      return { byWorkspaceId }
    }),
  setActive: (workspaceId, tabId) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) =>
          state.sessions[tabId] ? { ...state, activeTabId: tabId } : state
      ),
    })),
  upsert: (workspaceId, snapshot) =>
    set((store) => ({
      byWorkspaceId: updateWorkspace(
        store.byWorkspaceId,
        workspaceId,
        (state) => ({
          ...state,
          sessions: { ...state.sessions, [snapshot.tabId]: snapshot },
          activeTabId: snapshot.tabId,
          recentlySeenUrls: rememberUrl(state.recentlySeenUrls, snapshot),
        })
      ),
    })),
}))

export const emptyWorkspacePreviewState = EMPTY

export function previewRuntimeTabId(
  workspaceId: string,
  serverEpoch: string | null,
  tabId: string
): string {
  return [workspaceId, serverEpoch ?? 'pending', tabId]
    .map(encodeURIComponent)
    .join(':')
}

export function isPreviewSupportedInRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.desktopBridge?.preview)
}
