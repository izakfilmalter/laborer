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
import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { FileTreeSnapshot } from '@laborer/shared/rpc'
import { FileTree } from '@pierre/trees/react'
import { Cause, pipe } from 'effect'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useMemo } from 'react'
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
    () => LaborerClient.query('fileTree.subscribe', { workspaceId }),
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
 */
function TreePaneContent({ workspaceId }: { readonly workspaceId: string }) {
  const { snapshot, isLoading, error } = useFileTreeSnapshot(workspaceId)

  if (error !== null) {
    return <TreePaneError message={error} />
  }

  if (isLoading || snapshot === null) {
    return <TreePaneLoading />
  }

  if (snapshot.files.length === 0) {
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
      files={snapshot.files as string[]}
      gitStatus={
        snapshot.gitStatus as {
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

export { TreePane }
export type { TreePaneProps }
