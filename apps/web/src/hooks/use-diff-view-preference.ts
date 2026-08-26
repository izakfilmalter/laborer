/**
 * The diff pane's per-workspace view question: what it compares against,
 * and whether whitespace-only changes count.
 *
 * Held in the same TanStack DB local-storage collection every other UI
 * preference uses, keyed by workspace id — so closing and reopening the
 * pane, or opening a second one on the same workspace, lands back on the
 * question the reader was asking. A workspace with no row yet answers
 * with the defaults rather than an empty state.
 *
 * @see `@/db/local-preferences` for the collection and its parser.
 */

import type { DiffTarget } from '@laborer/shared/rpc'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback } from 'react'
import {
  diffViewCollection,
  setDiffViewPreference,
} from '@/db/local-preferences'
import {
  DEFAULT_DIFF_TARGET,
  diffTargetKey,
  parseDiffTargetKey,
} from '@/lib/diff-target'

export interface DiffViewPreferenceState {
  readonly ignoreWhitespace: boolean
  readonly setIgnoreWhitespace: (ignoreWhitespace: boolean) => void
  readonly setTarget: (target: DiffTarget) => void
  readonly target: DiffTarget
}

export function useDiffViewPreference(
  workspaceId: string
): DiffViewPreferenceState {
  const { data } = useLiveQuery((query) =>
    query.from({ diffView: diffViewCollection })
  )

  const row = data.find((candidate) => candidate.id === workspaceId)
  // A row written by an older build, or one whose ref was hand-edited out
  // of storage, degrades to the default rather than taking the pane down.
  const target =
    (row ? parseDiffTargetKey(row.targetKey) : null) ?? DEFAULT_DIFF_TARGET
  const ignoreWhitespace = row?.ignoreWhitespace ?? false

  const setTarget = useCallback(
    (next: DiffTarget) => {
      setDiffViewPreference(workspaceId, {
        ignoreWhitespace,
        targetKey: diffTargetKey(next),
      })
    },
    [ignoreWhitespace, workspaceId]
  )

  const setIgnoreWhitespace = useCallback(
    (next: boolean) => {
      setDiffViewPreference(workspaceId, {
        ignoreWhitespace: next,
        targetKey: diffTargetKey(target),
      })
    },
    [target, workspaceId]
  )

  return { ignoreWhitespace, setIgnoreWhitespace, setTarget, target }
}
