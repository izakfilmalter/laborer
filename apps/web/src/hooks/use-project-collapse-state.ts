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
  workspaceGroupExpansionCollection,
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
    | typeof workspaceGroupExpansionCollection
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
 * Collapse state for workspace group headers, keyed by Workspace ID for
 * sub-workspace stacks and by {@link authorGroupKey} for author groups.
 *
 * Both kinds of header are sidebar groups that collapse the same way and
 * default to expanded, so they share one collection rather than duplicating
 * the preference machinery. The author keys are prefixed to keep them from
 * ever colliding with a ULID.
 */
function useWorkspaceGroupCollapseState(): CollapseState {
  return useCollapseState(workspaceGroupExpansionCollection)
}

/**
 * Collapse key for one author's group inside one project.
 *
 * Scoped per project because the same person can have branches in several
 * repositories, and collapsing their group in one has nothing to say about
 * the others.
 */
const authorGroupKey = (projectId: string, login: string): string =>
  `author:${projectId}:${login}`

export {
  authorGroupKey,
  useProjectCollapseState,
  useWorkspaceGroupCollapseState,
}
export type { CollapseState }
