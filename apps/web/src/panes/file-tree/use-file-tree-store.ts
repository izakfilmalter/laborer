/**
 * React hook for lazy per-directory file tree state management.
 *
 * Manages a store of per-directory listings fetched on-demand via the
 * `file.list` RPC. Directories are loaded lazily when expanded and
 * invalidated by watcher events. The store produces a flat `files`
 * array compatible with `@pierre/trees`.
 *
 * Adapted from OpenCode's `createFileTreeStore` pattern:
 * @see .reference/opencode/packages/app/src/context/file/tree-store.ts
 *
 * @see docs/lazy-file-service/PRD.md — Client-Side Invalidation (Layer 3)
 * @see Issue 6: Client tree pane — Lazy per-directory fetching
 */

import type { FileNode } from '@laborer/shared/rpc'
import { useCallback, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirectoryState {
  readonly children: readonly string[]
  readonly error: string | null
  readonly expanded: boolean
  readonly loaded: boolean
  readonly loading: boolean
}

interface TreeState {
  /** Per-directory state keyed by relative path ("" = root). */
  readonly dirs: Record<string, DirectoryState>
  /** Per-node data keyed by relative path. */
  readonly nodes: Record<string, FileNode>
}

const DEFAULT_DIR: DirectoryState = {
  children: [],
  error: null,
  expanded: false,
  loaded: false,
  loading: false,
}

const ROOT_DIR: DirectoryState = { ...DEFAULT_DIR, expanded: true }

// ---------------------------------------------------------------------------
// Pure reconciliation helpers (extracted to reduce cognitive complexity)
// ---------------------------------------------------------------------------

/** Find children that were removed between old and new listings. */
const findRemovedDirs = (
  prevChildren: readonly string[],
  nextSet: Set<string>,
  nodes: Record<string, FileNode>
): string[] => {
  const removed: string[] = []
  for (const child of prevChildren) {
    if (nextSet.has(child)) {
      continue
    }
    if (nodes[child]?.type === 'directory') {
      removed.push(child)
    }
  }
  return removed
}

/** Remove stale nodes and descendants of removed directories. */
const reconcileNodes = (
  prev: Record<string, FileNode>,
  prevChildren: readonly string[],
  nextSet: Set<string>,
  nodes: readonly FileNode[]
): Record<string, FileNode> => {
  const result = { ...prev }
  const removedDirs = findRemovedDirs(prevChildren, nextSet, prev)

  // Delete nodes that no longer exist
  for (const child of prevChildren) {
    if (!nextSet.has(child)) {
      delete result[child]
    }
  }

  // Delete all descendants of removed directories
  if (removedDirs.length > 0) {
    for (const key of Object.keys(result)) {
      for (const removed of removedDirs) {
        if (key.startsWith(`${removed}/`)) {
          delete result[key]
          break
        }
      }
    }
  }

  // Add/update new nodes
  for (const node of nodes) {
    result[node.path] = node
  }
  return result
}

/** Remove directory states for removed directories and their children. */
const reconcileDirs = (
  prev: Record<string, DirectoryState>,
  dir: string,
  removedDirs: string[],
  nextChildren: readonly string[]
): Record<string, DirectoryState> => {
  const result = { ...prev }

  for (const removed of removedDirs) {
    delete result[removed]
    for (const key of Object.keys(result)) {
      if (key.startsWith(`${removed}/`)) {
        delete result[key]
      }
    }
  }

  result[dir] = {
    ...(result[dir] ?? DEFAULT_DIR),
    children: nextChildren,
    error: null,
    loaded: true,
    loading: false,
  }

  return result
}

/** Format nodes for @pierre/trees, which uses a trailing slash for folders. */
const toTreePath = (node: FileNode): string => {
  if (node.type !== 'directory' || node.path.endsWith('/')) {
    return node.path
  }
  return `${node.path}/`
}

/** Walk the directory tree depth-first to build a flat file list. */
const buildFileList = (state: TreeState): readonly string[] => {
  const result: string[] = []
  const visited = new Set<string>()

  const walk = (dir: string) => {
    const dirState = state.dirs[dir]
    if (!dirState?.loaded) {
      return
    }

    for (const childPath of dirState.children) {
      if (visited.has(childPath)) {
        continue
      }
      visited.add(childPath)

      const node = state.nodes[childPath]
      if (!node) {
        continue
      }

      result.push(toTreePath(node))

      if (node.type === 'directory' && state.dirs[childPath]?.loaded) {
        walk(childPath)
      }
    }
  }

  walk('')
  return result
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseFileTreeStoreOptions {
  /** Function to fetch a directory listing via the `file.list` RPC. */
  readonly list: (dir: string) => Promise<readonly FileNode[]>
}

export interface FileTreeStore {
  /** Get direct child nodes for a directory path. */
  readonly children: (dir: string) => readonly FileNode[]
  /** Mark a directory as collapsed. */
  readonly collapseDir: (dir: string) => void
  /** Error message if the root directory failed to load. */
  readonly error: string | null
  /** Mark a directory as expanded and trigger lazy load. */
  readonly expandDir: (dir: string) => void
  /** Flat list of file paths for @pierre/trees. */
  readonly files: readonly string[]
  /** Check whether a node exists. */
  readonly hasNode: (path: string) => boolean
  /** Check whether a directory is currently expanded. */
  readonly isDirExpanded: (dir: string) => boolean
  /** Check whether a directory has been loaded. */
  readonly isDirLoaded: (dir: string) => boolean
  /** Whether the root directory is still loading. */
  readonly isLoading: boolean
  /** Load a directory's contents. Called on expand or for invalidation. */
  readonly listDir: (dir: string, opts?: { force?: boolean }) => void
  /** Get the type of a node by path. */
  readonly nodeType: (path: string) => 'file' | 'directory' | undefined
  /** Handle expanded items change from @pierre/trees (for lazy loading). */
  readonly onExpandedItemsChange: (items: string[]) => void
  /** Re-fetch every directory already represented in the stale tree. */
  readonly refreshLoadedDirs: () => void
}

export const useFileTreeStore = (
  options: UseFileTreeStoreOptions
): FileTreeStore => {
  const [state, setState] = useState<TreeState>({
    dirs: { '': ROOT_DIR },
    nodes: {},
  })

  const inflight = useRef(new Map<string, Promise<void>>())
  const listRef = useRef(options.list)
  listRef.current = options.list
  const expandedDirsRef = useRef(new Set<string>(['']))
  const loadedDirsRef = useRef<readonly string[]>([])
  loadedDirsRef.current = Object.keys(state.dirs).filter(
    (dir) => state.dirs[dir]?.loaded === true
  )

  const ensureDir = useCallback((dir: string) => {
    setState((prev) => {
      if (prev.dirs[dir]) {
        return prev
      }
      return { ...prev, dirs: { ...prev.dirs, [dir]: DEFAULT_DIR } }
    })
  }, [])

  const listDir = useCallback((dir: string, opts?: { force?: boolean }) => {
    // Ensure directory entry exists
    setState((prev) => {
      if (prev.dirs[dir]) {
        return prev
      }
      return { ...prev, dirs: { ...prev.dirs, [dir]: DEFAULT_DIR } }
    })

    // Dedup inflight requests
    if (inflight.current.has(dir) && !opts?.force) {
      return
    }

    // Mark loading
    setState((prev) => {
      const current = prev.dirs[dir]
      if (!opts?.force && current?.loaded) {
        return prev
      }
      return {
        ...prev,
        dirs: {
          ...prev.dirs,
          [dir]: { ...(current ?? DEFAULT_DIR), error: null, loading: true },
        },
      }
    })

    const promise = listRef
      .current(dir)
      .then((nodes) => {
        setState((prev) => {
          const prevChildren = prev.dirs[dir]?.children ?? []
          const nextChildren = nodes.map((n) => n.path)
          const nextSet = new Set(nextChildren)
          const removedDirs = findRemovedDirs(prevChildren, nextSet, prev.nodes)
          const newNodes = reconcileNodes(
            prev.nodes,
            prevChildren,
            nextSet,
            nodes
          )
          const newDirs = reconcileDirs(
            prev.dirs,
            dir,
            removedDirs,
            nextChildren
          )
          return { dirs: newDirs, nodes: newNodes }
        })
      })
      .catch((e: unknown) => {
        const message =
          e instanceof Error ? e.message : 'Failed to list directory'
        setState((prev) => ({
          ...prev,
          dirs: {
            ...prev.dirs,
            [dir]: {
              ...(prev.dirs[dir] ?? DEFAULT_DIR),
              error: message,
              loading: false,
            },
          },
        }))
      })
      .finally(() => {
        inflight.current.delete(dir)
      })

    inflight.current.set(dir, promise)
  }, [])

  const expandDir = useCallback(
    (dir: string) => {
      expandedDirsRef.current.add(dir)
      ensureDir(dir)
      setState((prev) => ({
        ...prev,
        dirs: {
          ...prev.dirs,
          [dir]: { ...(prev.dirs[dir] ?? DEFAULT_DIR), expanded: true },
        },
      }))
      listDir(dir)
    },
    [ensureDir, listDir]
  )

  const refreshLoadedDirs = useCallback(() => {
    for (const dir of loadedDirsRef.current) {
      listDir(dir, { force: true })
    }
  }, [listDir])

  const collapseDir = useCallback((dir: string) => {
    expandedDirsRef.current.delete(dir)
    setState((prev) => ({
      ...prev,
      dirs: {
        ...prev.dirs,
        [dir]: { ...(prev.dirs[dir] ?? DEFAULT_DIR), expanded: false },
      },
    }))
  }, [])

  const nodeType = useCallback(
    (path: string): 'file' | 'directory' | undefined => state.nodes[path]?.type,
    [state.nodes]
  )

  const hasNode = useCallback(
    (path: string): boolean => path in state.nodes,
    [state.nodes]
  )

  const isDirLoaded = useCallback(
    (dir: string): boolean => state.dirs[dir]?.loaded === true,
    [state.dirs]
  )

  const isDirExpanded = useCallback(
    (dir: string): boolean => state.dirs[dir]?.expanded === true,
    [state.dirs]
  )

  const children = useCallback(
    (dir: string): readonly FileNode[] => {
      const childPaths = state.dirs[dir]?.children ?? []
      return childPaths.flatMap((path) => {
        const node = state.nodes[path]
        return node === undefined ? [] : [node]
      })
    },
    [state.dirs, state.nodes]
  )

  const onExpandedItemsChange = useCallback(
    (items: string[]) => {
      const next = new Set(items)
      const prev = expandedDirsRef.current

      for (const item of next) {
        if (!prev.has(item)) {
          expandDir(item)
        }
      }
      for (const item of prev) {
        if (!next.has(item) && item !== '') {
          collapseDir(item)
        }
      }

      expandedDirsRef.current = next
      expandedDirsRef.current.add('')
    },
    [expandDir, collapseDir]
  )

  const files = useMemo(() => buildFileList(state), [state])

  const rootDir = state.dirs['']
  const isLoading = rootDir?.loading === true && !rootDir.loaded
  const error = rootDir?.error ?? null

  return {
    children,
    collapseDir,
    error,
    expandDir,
    files,
    hasNode,
    isDirLoaded,
    isDirExpanded,
    isLoading,
    listDir,
    nodeType,
    onExpandedItemsChange,
    refreshLoadedDirs,
  }
}
