/**
 * Pure function to determine what actions to take when a file watcher event
 * arrives. Used for client-side invalidation of the lazy file tree.
 *
 * Adapted from OpenCode's watcher invalidation pattern:
 * @see .reference/opencode/packages/app/src/context/file/watcher.ts
 *
 * @see docs/lazy-file-service/PRD.md — Client-Side Invalidation (Layer 3)
 * @see Issue 6: Client tree pane — Lazy per-directory fetching
 */

import type { FileWatcherEvent } from '@laborer/shared/rpc'

/**
 * Operations the invalidation function can invoke.
 * These are callbacks provided by the tree store / component.
 */
export interface WatcherOps {
  /** Check whether a file node exists in the tree store. */
  readonly hasNode: (path: string) => boolean
  /** Check whether a directory has been loaded (fetched at least once). */
  readonly isDirLoaded: (path: string) => boolean
  /** Check whether a node is a directory. */
  readonly nodeType: (path: string) => 'file' | 'directory' | undefined
  /** Re-fetch a directory listing (with force flag to bypass cache). */
  readonly refreshDir: (path: string) => void
}

/**
 * Determine what to invalidate when a file watcher event arrives.
 *
 * Rules:
 * - `.git/` path changes are ignored (handled by branch detection, not tree)
 * - `"change"` events: if the path is a known directory that's been loaded,
 *   refresh that directory listing
 * - `"add"` / `"unlink"` events: refresh the parent directory listing so the
 *   new/removed entry appears/disappears
 * - Only loaded directories are refreshed — unloaded ones will be fetched
 *   fresh when the user expands them
 */
export const invalidateFromWatcher = (
  event: FileWatcherEvent,
  ops: WatcherOps
): void => {
  const { file: path, event: kind } = event

  // Skip .git/ internal changes — branch detection handles those
  if (path.startsWith('.git/') || path === '.git') {
    return
  }

  // For "change" events, check if the path is a loaded directory
  if (kind === 'change') {
    // If the path is a known directory node, refresh it
    const type = ops.nodeType(path)
    if (type === 'directory' && ops.isDirLoaded(path)) {
      ops.refreshDir(path)
    }
    // Also check if the root changed (empty string = root)
    if (path === '' && ops.isDirLoaded('')) {
      ops.refreshDir('')
    }
    return
  }

  // For "add" / "unlink" events, refresh the parent directory
  if (kind !== 'add' && kind !== 'unlink') {
    return
  }

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

  if (!ops.isDirLoaded(parent)) {
    return
  }
  ops.refreshDir(parent)
}
