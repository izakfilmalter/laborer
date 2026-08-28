import type { DesktopPreviewPointerEvent } from '@laborer/shared/desktop-bridge'
import { create } from 'zustand'

interface PointerStore {
  readonly apply: (event: DesktopPreviewPointerEvent) => void
  readonly byTabId: Record<string, DesktopPreviewPointerEvent>
}

export const useBrowserPointerStore = create<PointerStore>()((set) => ({
  byTabId: {},
  apply: (event) =>
    set((state) => {
      const previous = state.byTabId[event.tabId]
      if (previous && event.sequence <= previous.sequence) {
        return state
      }
      return { byTabId: { ...state.byTabId, [event.tabId]: event } }
    }),
}))
