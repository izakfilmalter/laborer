/**
 * Hooks to manage collapse/expand state for sidebar groups.
 *
 * Stores a `Record<string, boolean>` mapping group keys to their
 * expanded state. Persisted to localStorage so collapse state survives
 * page reloads. Defaults to all groups expanded when no stored state
 * exists.
 *
 * Used for project headings (keyed by project ID) and workspace group
 * headers (keyed by `<projectId>:<branchName>` so the state survives
 * workspace destruction/recreation on the same branch).
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 */

import { useCallback, useEffect, useState } from 'react'

const PROJECT_STORAGE_KEY = 'laborer:project-collapse-state'
const WORKSPACE_GROUP_STORAGE_KEY = 'laborer:workspace-group-collapse-state'

/**
 * Read the persisted collapse state from localStorage.
 * Returns undefined if nothing is stored or the stored value is invalid.
 */
function readStoredState(
  storageKey: string
): Record<string, boolean> | undefined {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) {
      return undefined
    }
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, boolean>
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the collapse state to localStorage, merging with whatever is
 * already stored. Several hook instances can exist at once (one per
 * project group); merging keeps one instance's writes from clobbering
 * keys it never touched.
 */
function writeStoredState(
  storageKey: string,
  state: Record<string, boolean>
): void {
  try {
    const merged = { ...readStoredState(storageKey), ...state }
    localStorage.setItem(storageKey, JSON.stringify(merged))
  } catch {
    // Silently ignore storage errors (e.g. quota exceeded)
  }
}

interface CollapseState {
  /** Check if a group is expanded. Defaults to true (expanded). */
  readonly isExpanded: (key: string) => boolean
  /** Toggle the expanded state of a group. */
  readonly toggle: (key: string) => void
}

function useCollapseState(storageKey: string): CollapseState {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(
    () => readStoredState(storageKey) ?? {}
  )

  // Persist to localStorage on every change
  useEffect(() => {
    writeStoredState(storageKey, expandedMap)
  }, [storageKey, expandedMap])

  const isExpanded = useCallback(
    (key: string): boolean => {
      // Default to expanded (true) if not explicitly set
      return expandedMap[key] !== false
    },
    [expandedMap]
  )

  const toggle = useCallback((key: string): void => {
    setExpandedMap((prev) => ({
      ...prev,
      [key]: prev[key] === false,
    }))
  }, [])

  return { isExpanded, toggle }
}

/** Collapse state for project headings, keyed by project ID. */
function useProjectCollapseState(): CollapseState {
  return useCollapseState(PROJECT_STORAGE_KEY)
}

/**
 * Collapse state for workspace group headers (workspaces with
 * sub-workspaces), keyed by `<projectId>:<branchName>`.
 */
function useWorkspaceGroupCollapseState(): CollapseState {
  return useCollapseState(WORKSPACE_GROUP_STORAGE_KEY)
}

export { useProjectCollapseState, useWorkspaceGroupCollapseState }
export type { CollapseState }
