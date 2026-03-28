/**
 * File tree pane component — renders a live file tree using @pierre/trees.
 *
 * Subscribes to the `fileTree.subscribe` streaming RPC which provides
 * the full list of tracked + untracked files and git status entries for
 * a workspace's worktree. Data is fed directly into @pierre/trees'
 * React `<FileTree>` component as controlled `files` and `gitStatus`
 * props.
 *
 * Displayed as a left-side panel alongside workspace frames, mirroring
 * how the diff pane is rendered on the right side.
 *
 * Error handling: when the streaming RPC fails (workspace not found,
 * workspace in invalid state, worktree not ready, git errors), the
 * component renders a user-friendly error message instead of a blank
 * screen or crash.
 *
 * @see packages/server/src/services/file-tree-service.ts — server-side service
 * @see docs/file-tree-git-status/PRD.md — feature PRD
 */

import { Result } from '@effect-atom/atom'
import { useAtomMount, useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { FileTreeSnapshot } from '@laborer/shared/rpc'
import { FileTree } from '@pierre/trees/react'
import { Cause, pipe } from 'effect'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState, useTransition } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'

/**
 * Options for the @pierre/trees FileTree component.
 * Configured once and reused across renders.
 *
 * - `flattenEmptyDirectories`: Collapses single-child directories
 *   (e.g., `src/components/` shown as one row when `components/`
 *   has no siblings), matching VS Code's compact folder display.
 * - `sort`: Alphabetical ordering, folders first.
 * - `virtualize`: Enables virtualized rendering for large repos,
 *   only rendering visible rows when the file count exceeds the threshold.
 */
const fileTreeOptions = {
  flattenEmptyDirectories: true,
  sort: true,
  virtualize: { threshold: 200 },
} as const

interface TreePaneProps {
  /** Callback to close the tree pane. */
  readonly onClose?: (() => void) | undefined
  /** The workspace whose file tree to display. */
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// Shared atom cache — ensures the preloader and TreePaneContent use the
// same atom instance so the RPC subscription isn't duplicated.
// ---------------------------------------------------------------------------

const fileTreeAtomCache = new Map<
  string,
  ReturnType<typeof LaborerClient.query>
>()

/**
 * Get or create the `fileTree.subscribe` pull atom for a workspace.
 * Cached by workspaceId so all consumers share one RPC subscription.
 */
function getFileTreeAtom(workspaceId: string) {
  let atom = fileTreeAtomCache.get(workspaceId)
  if (!atom) {
    atom = LaborerClient.query('fileTree.subscribe', { workspaceId })
    fileTreeAtomCache.set(workspaceId, atom)
  }
  return atom
}

/**
 * Preload the file tree data for a workspace.
 *
 * Renders as a hidden component inside WorkspaceFrame. Starts the
 * `fileTree.subscribe` streaming RPC in the background once Phase 4
 * (Eventually) is reached. When the user later opens the Files panel,
 * the first snapshot is already available and renders instantly.
 *
 * Uses `useAtomMount` which mounts the atom in the registry (starting
 * the RPC subscription) without subscribing to value changes, so this
 * component causes zero re-renders after mount.
 */
function FileTreePreloader({
  workspaceId,
}: {
  readonly workspaceId: string
}): null {
  const atom = useMemo(() => getFileTreeAtom(workspaceId), [workspaceId])
  useAtomMount(atom)
  return null
}

/**
 * Extract the latest snapshot from the streaming RPC pull result.
 *
 * The pull-based atom accumulates stream items in `result.value.items`.
 * Since each FileTreeSnapshot is a complete replacement (not a delta),
 * we only care about the most recent item in the array.
 *
 * Returns error information when the stream fails so the UI can render
 * a user-friendly message instead of a blank screen.
 */
function useFileTreeSnapshot(workspaceId: string): {
  error: string | null
  isLoading: boolean
  snapshot: FileTreeSnapshot | null
} {
  const fileTreeAtom = useMemo(
    () => getFileTreeAtom(workspaceId),
    [workspaceId]
  )
  const result = useAtomValue(fileTreeAtom)

  if (Result.isInitial(result) || result.waiting) {
    return { snapshot: null, isLoading: true, error: null }
  }

  if (Result.isFailure(result)) {
    // Extract a user-friendly error message from the Cause.
    // The cause wraps RpcError which has `{ message: string, code?: string }`.
    const errorMessage = pipe(Cause.failures(result.cause), (chunk) => {
      const first = chunk[Symbol.iterator]().next()
      if (first.done !== true && first.value !== undefined) {
        const err = first.value as { message?: string }
        return err.message ?? 'Failed to load file tree'
      }
      return 'Failed to load file tree'
    })
    return { snapshot: null, isLoading: false, error: errorMessage }
  }

  // Pull result success value has shape { done, items: NonEmptyArray<T> }
  const { items } = result.value
  const latestSnapshot = items.at(-1) ?? null
  return { snapshot: latestSnapshot, isLoading: false, error: null }
}

/**
 * Loading skeleton shown before the first file tree snapshot arrives.
 * Renders animated placeholder lines that mimic a file tree structure.
 */
function TreePaneLoading() {
  return (
    <div className="flex flex-col gap-1.5 p-2" data-testid="tree-pane-loading">
      <div className="flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-xs">Loading files...</span>
      </div>
      {/* Skeleton lines to hint at tree structure */}
      <div className="flex flex-col gap-1 pt-1 pl-1">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted pl-4" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted pl-4" />
        <div className="h-4 w-5/8 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted pl-4" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

/**
 * Error state shown when the streaming RPC fails.
 * Displays a user-friendly message with an icon, without crashing the panel.
 */
function TreePaneError({ message }: { readonly message: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2 p-4"
      data-testid="tree-pane-error"
    >
      <AlertCircle className="size-5 text-muted-foreground" />
      <span className="text-center text-muted-foreground text-xs">
        {message}
      </span>
    </div>
  )
}

/**
 * Inner content of the tree pane, mounted only after Phase 4 (Eventually)
 * when the FileTreeService's deferred proxy has been swapped for the real
 * service. Subscribes to the streaming RPC and renders @pierre/trees.
 *
 * Uses `useTransition` to defer re-renders when snapshot data changes.
 * For large repos (10k+ files), re-rendering the `<FileTree>` component
 * can be expensive (virtualization recalculation, git status badge
 * computation). By wrapping the state update in a transition, the update
 * is marked as non-urgent so it doesn't block user interactions like
 * scrolling, expanding/collapsing folders, or typing in terminals.
 *
 * The pattern mirrors DiffPane's approach: the streaming RPC pushes new
 * snapshots, which are stored in `deferredSnapshot` via `startTransition`.
 * While the transition is pending, the previous tree content remains
 * visible and interactive.
 */
function TreePaneContent({ workspaceId }: { readonly workspaceId: string }) {
  const { snapshot, isLoading, error } = useFileTreeSnapshot(workspaceId)

  // --- Deferred rendering via useTransition ---
  // FileTree can be expensive to re-render for large repos (virtualization
  // recalc, git status badge computation, folder propagation). useTransition
  // marks the re-render as non-urgent so it doesn't block user interactions
  // (scrolling, expanding/collapsing folders, typing in terminals).
  const [, startTransition] = useTransition()
  const [deferredSnapshot, setDeferredSnapshot] =
    useState<FileTreeSnapshot | null>(snapshot)

  useEffect(() => {
    startTransition(() => {
      setDeferredSnapshot(snapshot)
    })
  }, [snapshot])

  if (error !== null) {
    return <TreePaneError message={error} />
  }

  if (isLoading || deferredSnapshot === null) {
    return <TreePaneLoading />
  }

  if (deferredSnapshot.files.length === 0) {
    return (
      <div className="flex items-center justify-center p-4">
        <span className="text-muted-foreground text-xs">
          No files in worktree
        </span>
      </div>
    )
  }

  return (
    <FileTree
      className="h-full"
      files={deferredSnapshot.files as string[]}
      gitStatus={
        deferredSnapshot.gitStatus as {
          path: string
          status: 'added' | 'deleted' | 'modified'
        }[]
      }
      options={fileTreeOptions}
    />
  )
}

function TreePane({ workspaceId, onClose }: TreePaneProps) {
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="tree-pane"
      data-workspace-id={workspaceId}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
        <span className="font-medium text-xs">Files</span>
        {onClose && (
          <button
            aria-label="Close file tree"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            &times;
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {isEventually ? (
          <TreePaneContent workspaceId={workspaceId} />
        ) : (
          <TreePaneLoading />
        )}
      </div>
    </div>
  )
}

export { FileTreePreloader, TreePane }
export type { TreePaneProps }
