/**
 * File tree pane component — renders a lazy per-directory file tree
 * using @pierre/trees.
 *
 * Uses the `file.list` request/response RPC for lazy per-directory
 * fetching and the `file.watcher.subscribe` streaming RPC for reactive
 * invalidation. Directories are loaded on expand, not eagerly on mount.
 *
 * Git status decorations are fetched via `file.status` and passed to
 * @pierre/trees. The watcher stream also triggers status re-fetches
 * when files are added, changed, or removed.
 *
 * Displayed as a left-side panel alongside workspace frames, mirroring
 * how the diff pane is rendered on the right side.
 *
 * Error handling: when the RPC fails (workspace not found, workspace
 * in invalid state, worktree not ready, git errors), the component
 * renders a user-friendly error message instead of a blank screen.
 *
 * Right-click context menu: each tree item can be right-clicked to
 * show a context menu with "Open in Editor", "Copy Path", and
 * "Copy Relative Path" actions. Uses the Base UI ContextMenu component
 * which natively handles right-click positioning at the cursor and
 * proper dismiss behavior (outside click or Escape only). The
 * `onOpenChange` callback validates the target by walking the composed
 * path (crossing shadow DOM boundaries) to ensure the right-click
 * landed on a tree item before allowing the menu to open.
 *
 * @see packages/server/src/services/file-service.ts — server-side FileService
 * @see docs/lazy-file-service/PRD.md — Lazy File Service PRD
 * @see Issue 6: Client tree pane — Lazy per-directory fetching
 */

import {
  useAtomMount,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type { FileNode, FileWatcherEvent } from '@laborer/shared/rpc'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@laborer/ui/components/context-menu'
import { useLiveQuery } from '@tanstack/react-db'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { AlertCircle, ExternalLink, Files, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileWatcherEventsAtom } from '@/atoms/file-watcher'
import { LaborerClient } from '@/atoms/laborer-client'
import { rendererConnectionGenerationAtom } from '@/atoms/renderer-connection'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { extractErrorMessage } from '@/lib/errors'
import { localApi } from '@/lib/local-api'
import { toast } from '@/lib/toast'
import { invalidateFromWatcher } from '@/panes/file-tree/invalidate-from-watcher'
import {
  FileTreeView,
  type TreeViewSelectionItem,
} from '@/panes/file-tree/tree-view'
import { useFileTreeStore } from '@/panes/file-tree/use-file-tree-store'

interface TreePaneProps {
  /** Callback to close the tree pane. */
  readonly onClose?: (() => void) | undefined
  /** The workspace whose file tree to display. */
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// Module-level atoms — shared across all TreePaneContent instances.
// ---------------------------------------------------------------------------

/** Mutation atom for opening files in the user's configured editor. */
const editorOpenMutation = LaborerClient.mutation('editor.open')

/** Mutation atom for listing a single directory level. */
const fileListMutation = LaborerClient.mutation('file.list')

/** Mutation atom for fetching workspace-level changed file summary. */
const fileStatusMutation = LaborerClient.mutation('file.status')

// ---------------------------------------------------------------------------
// Context menu items component
// ---------------------------------------------------------------------------

/**
 * Context menu items shown when a tree item is right-clicked.
 *
 * Uses the Base UI ContextMenu component which natively handles:
 * - Positioning at the cursor on right-click
 * - Proper dismiss behavior (outside click or Escape only)
 * - Touch long-press support
 *
 * Actions:
 * - Open in Editor: calls the `editor.open` RPC with the file's relative path
 * - Copy Path: copies the absolute path (worktreePath + filePath) to clipboard
 * - Copy Relative Path: copies the path relative to the worktree root
 */
type FileTreeMenuAction = 'open-editor' | 'copy-path' | 'copy-relative-path'

const FILE_TREE_MENU_ITEMS = [
  { id: 'open-editor', label: 'Open in Editor' },
  { id: 'copy-path', label: 'Copy Path' },
  { id: 'copy-relative-path', label: 'Copy Relative Path' },
] as const

function useFileTreeContextActions(workspaceId: string, worktreePath: string) {
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })

  return useCallback(
    async (action: FileTreeMenuAction, item: TreeViewSelectionItem) => {
      if (action === 'open-editor') {
        try {
          await openEditor({
            payload: { workspaceId, filePath: item.path },
          })
        } catch (error: unknown) {
          toast.error(`Failed to open file: ${extractErrorMessage(error)}`)
        }
        return
      }
      const path =
        action === 'copy-path' ? `${worktreePath}/${item.path}` : item.path
      try {
        await navigator.clipboard.writeText(path)
        toast.success(
          action === 'copy-path'
            ? 'Path copied to clipboard'
            : 'Relative path copied to clipboard'
        )
      } catch (error: unknown) {
        toast.error(`Failed to copy path: ${extractErrorMessage(error)}`)
      }
    },
    [openEditor, workspaceId, worktreePath]
  )
}

function FileTreeContextMenuContent({
  execute,
}: {
  readonly execute: (action: FileTreeMenuAction) => void
}) {
  return (
    <ContextMenuContent className="min-w-[200px]">
      <ContextMenuItem onSelect={() => execute('open-editor')}>
        <ExternalLink />
        Open in Editor
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => execute('copy-path')}>
        <Files />
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => execute('copy-relative-path')}>
        <Files />
        Copy Relative Path
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/**
 * Loading skeleton shown before the first file tree listing arrives.
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
 * Error state shown when the RPC fails.
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

// ---------------------------------------------------------------------------
// Git status helper
// ---------------------------------------------------------------------------

/** Fetch git status and return entries in `@pierre/trees` format. */
const fetchGitStatus = async (
  fetchFn: (args: { payload: { workspaceId: string } }) => Promise<unknown>,
  workspaceId: string
): Promise<
  readonly { path: string; status: 'added' | 'deleted' | 'modified' }[]
> => {
  const result = await fetchFn({ payload: { workspaceId } })
  return (
    result as readonly {
      path: string
      status: 'added' | 'deleted' | 'modified'
    }[]
  ).map((entry) => ({
    path: entry.path,
    status: entry.status,
  }))
}

// ---------------------------------------------------------------------------
// Watcher subscription hook
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tree pane content — lazy per-directory fetching
// ---------------------------------------------------------------------------

/**
 * Inner content of the tree pane, mounted only after Phase 4 (Eventually)
 * when the FileService's deferred proxy has been swapped for the real
 * service.
 *
 * Uses the lazy per-directory store (`useFileTreeStore`) which:
 * - Fetches the root directory on mount via `file.list`
 * - Fetches subdirectories on expand via `file.list(workspaceId, dir)`
 * - Maintains a flat `files` list compatible with `@pierre/trees`
 *
 * Subscribes to `file.watcher.subscribe` for reactive invalidation:
 * - When a file is added or removed, the parent directory is re-fetched
 * - When a directory changes, that directory is re-fetched
 * - `.git/` changes are ignored (handled by branch detection)
 *
 * Context menu: uses the Base UI ContextMenu component which natively
 * handles right-click positioning and proper dismiss behavior (outside
 * click or Escape only — no close on mouse leave). The `onOpenChange`
 * callback validates the right-click target by walking the composed
 * path (crossing shadow DOM boundaries) to ensure it landed on a tree
 * item before allowing the menu to open.
 */
function TreePaneContent({ workspaceId }: { readonly workspaceId: string }) {
  const connectionGeneration = useAtomValue(rendererConnectionGenerationAtom)
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const workspaceRows = useMemo(
    () => workspaceViewsFromRows(tasks, projects),
    [projects, tasks]
  )
  const listFiles = useAtomSet(fileListMutation, { mode: 'promise' })

  // Look up the workspace's worktreePath for building absolute file paths.
  const worktreePath = useMemo(() => {
    const workspace = workspaceRows.find(
      (w: { id: string }) => w.id === workspaceId
    )
    return (
      (workspace as { worktreePath?: string } | undefined)?.worktreePath ?? ''
    )
  }, [workspaceRows, workspaceId])

  // --- Lazy file tree store ---
  const listDir = useCallback(
    async (dir: string): Promise<readonly FileNode[]> => {
      const result = await listFiles({
        payload: { workspaceId, dir: dir || undefined },
      })
      return result as readonly FileNode[]
    },
    [workspaceId, listFiles]
  )

  const treeStore = useFileTreeStore({ list: listDir })

  // Load root directory on mount.
  useEffect(() => {
    treeStore.listDir('')
  }, [treeStore.listDir])

  // --- Watcher subscription for invalidation ---
  const watcherAtom = fileWatcherEventsAtom(workspaceId)
  useAtomMount(watcherAtom)
  const watcherResult = useAtomValue(watcherAtom)

  // --- Git status ---
  const fetchFileStatus = useAtomSet(fileStatusMutation, { mode: 'promise' })
  const [gitStatus, setGitStatus] = useState<
    readonly { path: string; status: 'added' | 'deleted' | 'modified' }[]
  >([])

  /** Refresh git status from the server. */
  const refreshGitStatus = useCallback(() => {
    fetchGitStatus(fetchFileStatus, workspaceId)
      .then(setGitStatus)
      .catch(() => setGitStatus([]))
  }, [fetchFileStatus, workspaceId])

  // Fetch git status on mount.
  useEffect(() => {
    if (connectionGeneration === 0) {
      return
    }
    refreshGitStatus()
    treeStore.refreshLoadedDirs()
  }, [connectionGeneration, refreshGitStatus, treeStore.refreshLoadedDirs])

  // Process watcher events for tree invalidation and status refresh.
  const lastProcessedIndexRef = useRef(0)

  useEffect(() => {
    if (!Result.isSuccess(watcherResult)) {
      return
    }
    const { items } = watcherResult.value as {
      readonly items: readonly (FileWatcherEvent | undefined)[]
    }
    const startIndex = lastProcessedIndexRef.current

    if (items.length <= startIndex) {
      return
    }

    // Process new events since last check.
    let statusChanged = false
    for (let i = startIndex; i < items.length; i++) {
      const event = items[i]
      if (!event) {
        continue
      }

      invalidateFromWatcher(event, {
        hasNode: treeStore.hasNode,
        isDirLoaded: treeStore.isDirLoaded,
        nodeType: treeStore.nodeType,
        refreshDir: (dir: string) => treeStore.listDir(dir, { force: true }),
      })

      // Any add/change/unlink event could affect git status.
      const { file: path } = event
      if (!path.startsWith('.git/') && path !== '.git') {
        statusChanged = true
      }
    }

    lastProcessedIndexRef.current = items.length

    if (statusChanged) {
      refreshGitStatus()
    }
  }, [
    watcherResult,
    treeStore.hasNode,
    treeStore.isDirLoaded,
    treeStore.nodeType,
    treeStore.listDir,
    refreshGitStatus,
  ])

  // --- Selection + context menu state ---
  const contextMenuItemRef = useRef<TreeViewSelectionItem | null>(null)
  const [contextMenuItem, setContextMenuItem] =
    useState<TreeViewSelectionItem | null>(null)
  const [selectedItem, setSelectedItem] =
    useState<TreeViewSelectionItem | null>(null)
  const executeContextAction = useFileTreeContextActions(
    workspaceId,
    worktreePath
  )

  const handleSelect = useCallback((item: TreeViewSelectionItem) => {
    setSelectedItem(item)
  }, [])

  const handleContextMenuItem = useCallback((item: TreeViewSelectionItem) => {
    contextMenuItemRef.current = item
    setContextMenuItem(item)
  }, [])

  // Validate that a right-click landed on a tree item before allowing
  // the context menu to open.
  const handleOpenChange = useCallback(
    (
      open: boolean,
      details: { cancel: () => void; event: Event; reason: string }
    ) => {
      if (!open) {
        contextMenuItemRef.current = null
        setContextMenuItem(null)
        return
      }

      const target = details.event.target
      if (!(target instanceof Element)) {
        details.cancel()
        return
      }

      if (target.closest('[data-tree-item="true"]') === null) {
        details.cancel()
        return
      }

      if (contextMenuItemRef.current === null) {
        details.cancel()
        return
      }
    },
    []
  )

  if (treeStore.error !== null) {
    return <TreePaneError message={treeStore.error} />
  }

  if (treeStore.isLoading) {
    return <TreePaneLoading />
  }

  if (treeStore.files.length === 0) {
    return (
      <div className="flex items-center justify-center p-4">
        <span className="text-muted-foreground text-xs">
          No files in worktree
        </span>
      </div>
    )
  }

  const treeView = (
    <FileTreeView
      gitStatus={gitStatus}
      onContextMenuItem={handleContextMenuItem}
      onSelect={handleSelect}
      selectedPath={selectedItem?.path ?? null}
      store={treeStore}
    />
  )

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        className="h-full"
        onContextMenu={(event) => {
          if (
            localApi.contextMenuKind !== 'native' ||
            contextMenuItemRef.current === null
          ) {
            return
          }
          event.preventDefault()
          const item = contextMenuItemRef.current
          localApi
            .showContextMenu(
              FILE_TREE_MENU_ITEMS,
              { x: event.clientX, y: event.clientY },
              async () => null
            )
            .then((action) =>
              action ? executeContextAction(action, item) : undefined
            )
            .catch((error: unknown) => toast.error(extractErrorMessage(error)))
        }}
      >
        {treeView}
      </ContextMenuTrigger>
      {localApi.contextMenuKind === 'dom' && contextMenuItem !== null && (
        <FileTreeContextMenuContent
          execute={(action) => {
            executeContextAction(action, contextMenuItem).catch(
              (error: unknown) => toast.error(extractErrorMessage(error))
            )
          }}
        />
      )}
    </ContextMenu>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
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
