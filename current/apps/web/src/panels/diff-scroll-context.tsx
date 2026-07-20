/**
 * DiffScrollContext — cross-pane communication channel for scrolling
 * the diff pane to a specific file and line.
 *
 * When the user clicks a file:line reference in the review pane, this
 * context propagates a "scroll to file:line" event to any open diff pane
 * for the same workspace. If no diff pane is open, the event is silently
 * ignored.
 *
 * ## Architecture
 *
 * - Provider wraps the panel tree (alongside PanelActionsProvider).
 * - `scrollDiffToFile(workspaceId, file, line)` dispatches an event.
 * - `useOnDiffScrollRequest(workspaceId, callback)` subscribes to events
 *   filtered by workspace ID. Only diff panes for the matching workspace
 *   respond.
 * - Uses a ref-based listener registry to avoid re-renders when events
 *   are dispatched.
 *
 * @see Issue #11: Cross-pane diff scroll
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react'

interface DiffScrollTarget {
  /** The file path to scroll to. */
  readonly file: string
  /** The line number within the file. */
  readonly line: number
  /** The workspace ID that the scroll applies to. */
  readonly workspaceId: string
}

type DiffScrollListener = (target: DiffScrollTarget) => void

interface DiffScrollContextValue {
  /**
   * Dispatch a "scroll to file:line" event. All subscribed diff panes
   * for the matching workspace will attempt to scroll.
   */
  readonly scrollDiffToFile: (
    workspaceId: string,
    file: string,
    line: number
  ) => void
  /**
   * Subscribe to scroll events. Returns an unsubscribe function.
   * Used internally by the `useOnDiffScrollRequest` hook.
   */
  readonly subscribe: (listener: DiffScrollListener) => () => void
}

const DiffScrollContextImpl = createContext<DiffScrollContextValue | null>(null)

/**
 * Provider that maintains a set of diff scroll listeners.
 * Rendered once at the panel tree root.
 */
function DiffScrollProvider({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const listenersRef = useRef<Set<DiffScrollListener>>(new Set())

  const subscribe = useCallback((listener: DiffScrollListener) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const scrollDiffToFile = useCallback(
    (workspaceId: string, file: string, line: number) => {
      const target: DiffScrollTarget = { workspaceId, file, line }
      for (const listener of listenersRef.current) {
        listener(target)
      }
    },
    []
  )

  return (
    <DiffScrollContextImpl.Provider value={{ scrollDiffToFile, subscribe }}>
      {children}
    </DiffScrollContextImpl.Provider>
  )
}

/**
 * Hook to dispatch a "scroll to file:line" event to diff panes.
 * Returns a stable callback that can be called from event handlers.
 */
function useDiffScrollDispatch(): (
  workspaceId: string,
  file: string,
  line: number
) => void {
  const ctx = useContext(DiffScrollContextImpl)
  return useCallback(
    (workspaceId: string, file: string, line: number) => {
      ctx?.scrollDiffToFile(workspaceId, file, line)
    },
    [ctx]
  )
}

/**
 * Hook to subscribe to diff scroll requests for a specific workspace.
 * The callback fires only when the event's workspaceId matches.
 *
 * @param workspaceId - The workspace to listen for scroll events on.
 * @param onScroll - Callback invoked with `{ file, line }` when a scroll
 *   event is dispatched for this workspace.
 */
function useOnDiffScrollRequest(
  workspaceId: string,
  onScroll: (target: { file: string; line: number }) => void
): void {
  const ctx = useContext(DiffScrollContextImpl)
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll

  useEffect(() => {
    if (!ctx) {
      return
    }
    return ctx.subscribe((target) => {
      if (target.workspaceId === workspaceId) {
        onScrollRef.current({ file: target.file, line: target.line })
      }
    })
  }, [ctx, workspaceId])
}

export { DiffScrollProvider, useDiffScrollDispatch, useOnDiffScrollRequest }
export type { DiffScrollTarget }
