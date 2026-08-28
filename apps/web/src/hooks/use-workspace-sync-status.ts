/**
 * useWorkspaceSyncStatus — live ahead/behind counts for one workspace.
 *
 * Sync counts are not durable state: no task or project row carries them, so
 * there is nothing for the shared collections to stream. The counts come from
 * `workspace.refreshSyncStatus`, which reads `git status --porcelain=v2` in
 * the workspace's worktree and answers for the repo root as readily as for a
 * task-backed worktree.
 *
 * The query atom is keyed by workspace id, so a card and a frame header
 * showing the same workspace share one request. Push and pull invalidate the
 * workspace's reactivity keys, which refreshes every subscriber immediately
 * instead of leaving stale counts up until the next poll.
 *
 * @see packages/server/src/services/workspace-sync-service.ts — the git side
 * @see apps/web/src/hooks/use-workspace-sync-actions.ts — push/pull
 */

import { useAtomRefresh, useAtomValue } from '@effect/atom-react/Hooks'
import { useEffect, useMemo } from 'react'
import {
  LaborerClient,
  workspaceSyncReactivityKeys,
} from '@/atoms/laborer-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'

/** How often a mounted subscriber re-reads its workspace's sync status. */
const SYNC_STATUS_POLL_MS = 15_000

/** How long an unmounted workspace's counts stay cached before disposal. */
const SYNC_STATUS_TTL = '1 minute'

interface WorkspaceSyncCounts {
  /** Local commits not yet pushed, or null without an upstream branch. */
  readonly aheadCount: number | null
  /** Upstream commits not yet pulled, or null without an upstream branch. */
  readonly behindCount: number | null
  /** Whether the worktree holds uncommitted work. */
  readonly hasChanges: boolean
  /** Whether the branch tracks an upstream. */
  readonly hasUpstream: boolean
  /**
   * Whether git has answered yet. Before it has, every other field is a
   * placeholder rather than a fact, and a caller that acts on them would be
   * acting on silence — "no upstream" and "not asked yet" look identical.
   */
  readonly isKnown: boolean
}

const UNKNOWN_SYNC_COUNTS: WorkspaceSyncCounts = {
  aheadCount: null,
  behindCount: null,
  hasChanges: false,
  hasUpstream: false,
  isKnown: false,
}

/**
 * The ahead/behind counts for `workspaceId`, or null counts while the server
 * is still connecting, the branch has no upstream, or the read failed.
 */
function useWorkspaceSyncStatus(workspaceId: string): WorkspaceSyncCounts {
  const syncStatus$ = useMemo(
    () =>
      LaborerClient.query(
        'workspace.refreshSyncStatus',
        { workspaceId },
        {
          reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
          timeToLive: SYNC_STATUS_TTL,
        }
      ),
    [workspaceId]
  )
  const result = useAtomValue(syncStatus$)
  const refresh = useAtomRefresh(syncStatus$)
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)

  // Commits happen outside this view — in a terminal here, or on the remote,
  // which the server's background fetch pulls into the tracking refs this
  // status reads. GitHub Desktop refreshes on window focus for the same
  // reason; the interval covers the window that stays focused throughout.
  useEffect(() => {
    if (!isServerReady) {
      return
    }

    refresh()
    const interval = setInterval(refresh, SYNC_STATUS_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [isServerReady, refresh])

  return result._tag === 'Success'
    ? { ...result.value, isKnown: true }
    : UNKNOWN_SYNC_COUNTS
}

export { SYNC_STATUS_POLL_MS, useWorkspaceSyncStatus, type WorkspaceSyncCounts }
