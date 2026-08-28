import { create } from 'zustand'

export interface PreviewMiniPlayerPosition {
  readonly x: number
  readonly y: number
}

export interface PreviewMiniPlayerSize {
  readonly height: number
  readonly width: number
}

export interface PreviewMiniPlayerState {
  readonly position: PreviewMiniPlayerPosition | null
  readonly size: PreviewMiniPlayerSize | null
  readonly tabId: string
}

interface PreviewMiniPlayerStore {
  readonly byWorkspaceId: Record<string, PreviewMiniPlayerState>
  readonly close: (workspaceId: string) => void
  readonly move: (
    workspaceId: string,
    tabId: string,
    position: PreviewMiniPlayerPosition
  ) => void
  readonly open: (workspaceId: string, tabId: string) => void
  readonly removeWorkspace: (workspaceId: string) => void
  readonly resize: (
    workspaceId: string,
    tabId: string,
    size: PreviewMiniPlayerSize
  ) => void
}

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStore>()(
  (set) => ({
    byWorkspaceId: {},
    close: (workspaceId) =>
      set((state) => {
        if (!(workspaceId in state.byWorkspaceId)) {
          return state
        }
        const { [workspaceId]: _closed, ...byWorkspaceId } = state.byWorkspaceId
        return { byWorkspaceId }
      }),
    move: (workspaceId, tabId, position) =>
      set((state) => {
        const current = state.byWorkspaceId[workspaceId]
        if (!current || current.tabId !== tabId) {
          return state
        }
        if (
          current.position?.x === position.x &&
          current.position.y === position.y
        ) {
          return state
        }
        return {
          byWorkspaceId: {
            ...state.byWorkspaceId,
            [workspaceId]: { ...current, position },
          },
        }
      }),
    open: (workspaceId, tabId) =>
      set((state) => {
        const current = state.byWorkspaceId[workspaceId]
        if (current?.tabId === tabId) {
          return state
        }
        return {
          byWorkspaceId: {
            ...state.byWorkspaceId,
            [workspaceId]: {
              position: current?.position ?? null,
              size: current?.size ?? null,
              tabId,
            },
          },
        }
      }),
    removeWorkspace: (workspaceId) =>
      set((state) => {
        if (!(workspaceId in state.byWorkspaceId)) {
          return state
        }
        const { [workspaceId]: _removed, ...byWorkspaceId } =
          state.byWorkspaceId
        return { byWorkspaceId }
      }),
    resize: (workspaceId, tabId, size) =>
      set((state) => {
        const current = state.byWorkspaceId[workspaceId]
        if (!current || current.tabId !== tabId) {
          return state
        }
        if (
          current.size?.width === size.width &&
          current.size.height === size.height
        ) {
          return state
        }
        return {
          byWorkspaceId: {
            ...state.byWorkspaceId,
            [workspaceId]: { ...current, size },
          },
        }
      }),
  })
)
