/**
 * useProjectPullRequests — every open pull request in a project's repository.
 *
 * The sidebar's author headings are built from local workspaces, which only
 * know about branches somebody already pulled in. This is the other half: what
 * that person has open that is not here yet. Together they let a heading say
 * "three of their five are checked out" instead of quietly showing three.
 *
 * Not durable state, so nothing streams it — it is a `gh pr list` read behind
 * `github.pullRequests`, cached on the server and polled here. Pull requests
 * open and merge on the remote, out of this window's sight, so a mounted
 * sidebar re-reads on an interval and on focus, the same rhythm the sync
 * counts use.
 *
 * @see packages/server/src/services/github-pull-requests.ts — the `gh` side
 */

import { useAtomRefresh, useAtomValue } from '@effect/atom-react/Hooks'
import type { OpenPullRequest } from '@laborer/shared/rpc'
import { useEffect, useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'

/** How often a mounted sidebar re-reads its project's open pull requests. */
const PULL_REQUEST_POLL_MS = 120_000

/** How long an unmounted project's listing stays cached before disposal. */
const PULL_REQUEST_TTL = '5 minutes'

const NO_PULL_REQUESTS: readonly OpenPullRequest[] = []

/**
 * The open pull requests for `projectId`, or an empty list while the server is
 * still connecting, GitHub cannot be asked, or the repository has none.
 *
 * Those cases are one answer on purpose: the sidebar shows what it can prove
 * is open, and proving nothing means showing only the branches already here.
 */
function useProjectPullRequests(projectId: string): readonly OpenPullRequest[] {
  const pullRequests$ = useMemo(
    () =>
      LaborerClient.query(
        'github.pullRequests',
        { projectId },
        { timeToLive: PULL_REQUEST_TTL }
      ),
    [projectId]
  )
  const result = useAtomValue(pullRequests$)
  const refresh = useAtomRefresh(pullRequests$)
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)

  useEffect(() => {
    if (!isServerReady) {
      return
    }

    const interval = setInterval(refresh, PULL_REQUEST_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [isServerReady, refresh])

  return result._tag === 'Success'
    ? result.value.pullRequests
    : NO_PULL_REQUESTS
}

export { PULL_REQUEST_POLL_MS, useProjectPullRequests }
