/**
 * Hooks to manage collapse/expand state for sidebar groups.
 *
 * TanStack DB owns one row per real group identity. Groups default to expanded
 * when no row exists.
 *
 * Used for project headings (keyed by project ID) and workspace group
 * headers (keyed by Workspace ID).
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import {
  projectExpansionCollection,
  setExpansionPreference,
  workspaceExpansionCollection,
} from '@/db/local-preferences'

interface CollapseState {
  /** Check if a group is expanded. Defaults to true (expanded). */
  readonly isExpanded: (key: string) => boolean
  /** Toggle the expanded state of a group. */
  readonly toggle: (key: string) => void
}

function useCollapseState(
  collection:
    | typeof projectExpansionCollection
    | typeof workspaceExpansionCollection
): CollapseState {
  const { data } = useLiveQuery(
    (query) => query.from({ expansion: collection }),
    [collection]
  )
  const expandedMap = useMemo(
    () => new Map(data.map((row) => [row.id, row.expanded])),
    [data]
  )

  const isExpanded = useCallback(
    (key: string): boolean => {
      // Default to expanded (true) if not explicitly set
      return expandedMap.get(key) !== false
    },
    [expandedMap]
  )

  const toggle = useCallback(
    (key: string): void => {
      setExpansionPreference(collection, key, expandedMap.get(key) === false)
    },
    [collection, expandedMap]
  )

  return { isExpanded, toggle }
}

/** Collapse state for project headings, keyed by project ID. */
function useProjectCollapseState(): CollapseState {
  return useCollapseState(projectExpansionCollection)
}

/**
 * Collapse state for workspace group headers (workspaces with
 * sub-workspaces), keyed by Workspace ID.
 */
function useWorkspaceGroupCollapseState(): CollapseState {
  return useCollapseState(workspaceExpansionCollection)
}

export { useProjectCollapseState, useWorkspaceGroupCollapseState }
export type { CollapseState }
