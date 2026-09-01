/**
 * Which workspace's right panel the user last interacted with.
 *
 * The right panel is a sibling of the pane tree, not a pane, so
 * `activePaneId` never points at it. Without this, a keystroke aimed at a
 * right-panel tab (Cmd+W) was resolved against the last focused *pane* and
 * closed a terminal instead of the tab under the cursor.
 *
 * The focus is transient (never persisted) and follows the last pointer or
 * focus interaction: inside a right panel it names that panel's workspace,
 * anywhere else it clears.
 */

import { useEffect } from 'react'
import { create } from 'zustand'

interface RightPanelFocusState {
  /** Workspace whose right panel owns keyboard intent, or null. */
  focusedWorkspaceId: string | null
  setFocusedWorkspaceId: (workspaceId: string | null) => void
}

export const useRightPanelFocusStore = create<RightPanelFocusState>()(
  (set) => ({
    focusedWorkspaceId: null,
    setFocusedWorkspaceId: (workspaceId) =>
      set((state) =>
        state.focusedWorkspaceId === workspaceId
          ? state
          : { focusedWorkspaceId: workspaceId }
      ),
  })
)

/** The right panel workspace an event inside `target` belongs to, if any. */
export function rightPanelWorkspaceIdForTarget(
  target: EventTarget | null
): string | null {
  if (!(target instanceof Element)) {
    return null
  }
  const panel = target.closest<HTMLElement>('[data-right-panel]')
  return panel?.dataset.workspaceId ?? null
}

/**
 * Track right-panel focus for the whole app. Mount once — capture-phase
 * listeners see interactions before any component can stop propagation.
 */
export function useTrackRightPanelFocus(): void {
  useEffect(() => {
    const track = (event: Event) => {
      useRightPanelFocusStore
        .getState()
        .setFocusedWorkspaceId(rightPanelWorkspaceIdForTarget(event.target))
    }
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('focusin', track, true)
    return () => {
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('focusin', track, true)
    }
  }, [])
}
