import { create } from 'zustand'

export interface BrowserSurfaceRect {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

interface Presentation {
  readonly cornerRadius: number
  readonly fitSourceContent: boolean
  readonly owner: symbol | null
  readonly rect: BrowserSurfaceRect | null
  readonly sourceRect: BrowserSurfaceRect | null
  readonly visible: boolean
}

interface Store {
  readonly byTabId: Record<string, Presentation>
  readonly claim: (
    tabId: string,
    owner: symbol,
    fitSourceContent: boolean
  ) => void
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius: number
  ) => boolean
  readonly release: (tabId: string, owner: symbol) => void
}

export const useBrowserSurfaceStore = create<Store>()((set, get) => ({
  byTabId: {},
  claim: (tabId, owner, fitSourceContent) =>
    set((state) => ({
      byTabId: {
        ...state.byTabId,
        [tabId]: {
          ...(state.byTabId[tabId] ?? {
            rect: null,
            sourceRect: null,
            cornerRadius: 0,
          }),
          fitSourceContent,
          owner,
          sourceRect: fitSourceContent
            ? (state.byTabId[tabId]?.rect ?? null)
            : null,
          visible: false,
        },
      },
    })),
  present: (tabId, owner, rect, visible, cornerRadius) => {
    if (get().byTabId[tabId]?.owner !== owner) {
      return false
    }
    set((state) => ({
      byTabId: {
        ...state.byTabId,
        [tabId]: {
          ...(state.byTabId[tabId] ?? {
            fitSourceContent: false,
            sourceRect: null,
          }),
          owner,
          rect,
          visible,
          cornerRadius,
        },
      },
    }))
    return true
  },
  release: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId]
      if (current?.owner !== owner) {
        return state
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            fitSourceContent: false,
            owner: null,
            sourceRect: null,
            visible: false,
          },
        },
      }
    }),
}))

export function acquireBrowserSurface(tabId: string, fitSourceContent = false) {
  const owner = Symbol(tabId)
  useBrowserSurfaceStore.getState().claim(tabId, owner, fitSourceContent)
  return {
    present: (rect: BrowserSurfaceRect, visible: boolean, cornerRadius = 0) =>
      useBrowserSurfaceStore
        .getState()
        .present(tabId, owner, rect, visible, cornerRadius),
    release: () => useBrowserSurfaceStore.getState().release(tabId, owner),
  }
}
