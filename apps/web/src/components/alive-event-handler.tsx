/**
 * Top-level component that connects to GitHub Alive and fetches
 * individual comments/reviews when events arrive. Renders no UI.
 *
 * Instead of triggering a full `fetchComments` refresh, this component
 * fetches only the specific comment/review identified by the Alive event
 * and dispatches a typed DOM event with the full data. The review pane
 * listens for these events and merges the new item into its local state.
 *
 * Event flow:
 * 1. Alive pushes `pr-comment` → we call `review.fetchSingleIssueComment`
 *    or `review.fetchSingleReviewComment` depending on subtype
 * 2. Alive pushes `pr-review-submit` → we call `review.fetchSingleReview`
 * 3. Any event → we call `workspace.refreshPr` for instant PR state updates
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import type {
  PrComment,
  ReviewFinding,
  ReviewVerdict,
} from '@laborer/shared/rpc'
import { workspaces } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { useCallback } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { type GitHubAliveEvent, useAliveEvents } from '@/hooks/use-alive-events'
import { useLaborerStore } from '@/livestore/store'

// ---------------------------------------------------------------------------
// Custom DOM event types for Alive-driven updates
// ---------------------------------------------------------------------------

/**
 * Dispatched when a new issue comment is fetched from an Alive event.
 * The review pane merges this into its comment list without a full refresh.
 */
export interface AliveIssueCommentEvent {
  readonly comment: PrComment
  readonly verdict: ReviewVerdict | null
  readonly workspaceId: string
}

/**
 * Dispatched when a new inline review comment or finding is fetched.
 */
export type AliveReviewCommentEvent =
  | {
      readonly comment: PrComment
      readonly kind: 'comment'
      readonly workspaceId: string
    }
  | {
      readonly finding: ReviewFinding
      readonly kind: 'finding'
      readonly workspaceId: string
    }

/**
 * Dispatched when a review submission is fetched.
 */
export interface AliveReviewSubmitEvent {
  readonly authorLogin: string
  readonly body: string
  readonly reviewId: number
  readonly state: string
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// LiveStore queries and mutations
// ---------------------------------------------------------------------------

const allWorkspaces$ = queryDb(workspaces, { label: 'aliveWorkspaces' })

const refreshPrMutation = LaborerClient.mutation('workspace.refreshPr')
const fetchSingleIssueCommentMutation = LaborerClient.mutation(
  'review.fetchSingleIssueComment'
)
const fetchSingleReviewCommentMutation = LaborerClient.mutation(
  'review.fetchSingleReviewComment'
)
const fetchSingleReviewMutation = LaborerClient.mutation(
  'review.fetchSingleReview'
)

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Connects to GitHub Alive and fetches individual items when events arrive.
 * Mount this once near the app root.
 */
export function AliveEventHandler() {
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspaces$)
  const refreshPr = useAtomSet(refreshPrMutation, { mode: 'promise' })
  const fetchIssueComment = useAtomSet(fetchSingleIssueCommentMutation, {
    mode: 'promise',
  })
  const fetchReviewComment = useAtomSet(fetchSingleReviewCommentMutation, {
    mode: 'promise',
  })
  const fetchReview = useAtomSet(fetchSingleReviewMutation, {
    mode: 'promise',
  })

  const handleEvent = useCallback(
    (event: GitHubAliveEvent) => {
      const prNumber = event.pull_request_number

      // Find all workspaces with a matching PR number.
      const matchingWorkspaces = workspaceList.filter(
        (ws) => ws.prNumber === prNumber
      )

      if (matchingWorkspaces.length === 0) {
        return
      }

      console.log(
        `[Alive] ${event.type} for PR #${prNumber} — updating ${matchingWorkspaces.length} workspace(s)`
      )

      // Always trigger a PR status refresh for instant state updates.
      for (const ws of matchingWorkspaces) {
        refreshPr({ payload: { workspaceId: ws.id } }).catch(() => {
          // Silently ignore — polling will retry.
        })
      }

      // Fetch the specific item identified by the event.
      if (event.type === 'pr-comment') {
        const commentId = Number(event.comment_id)
        for (const ws of matchingWorkspaces) {
          if (event.subtype === 'issue-comment') {
            fetchIssueComment({
              payload: { workspaceId: ws.id, commentId },
            })
              .then((result) => {
                window.dispatchEvent(
                  new CustomEvent<AliveIssueCommentEvent>(
                    'alive:issue-comment',
                    {
                      detail: {
                        workspaceId: ws.id,
                        comment: result.comment,
                        verdict: result.verdict,
                      },
                    }
                  )
                )
              })
              .catch(() => {
                // Fallback: trigger a full refresh
                window.dispatchEvent(
                  new CustomEvent('alive:review-refresh', {
                    detail: { workspaceId: ws.id },
                  })
                )
              })
          } else {
            fetchReviewComment({
              payload: { workspaceId: ws.id, commentId },
            })
              .then((result) => {
                window.dispatchEvent(
                  new CustomEvent<AliveReviewCommentEvent>(
                    'alive:review-comment',
                    {
                      detail:
                        result.kind === 'finding'
                          ? {
                              kind: 'finding',
                              workspaceId: ws.id,
                              finding: result.finding,
                            }
                          : {
                              kind: 'comment',
                              workspaceId: ws.id,
                              comment: result.comment,
                            },
                    }
                  )
                )
              })
              .catch(() => {
                window.dispatchEvent(
                  new CustomEvent('alive:review-refresh', {
                    detail: { workspaceId: ws.id },
                  })
                )
              })
          }
        }
      }

      if (event.type === 'pr-review-submit') {
        const reviewId = Number(event.review_id)
        for (const ws of matchingWorkspaces) {
          fetchReview({
            payload: { workspaceId: ws.id, reviewId },
          })
            .then((result) => {
              window.dispatchEvent(
                new CustomEvent<AliveReviewSubmitEvent>('alive:review-submit', {
                  detail: {
                    workspaceId: ws.id,
                    reviewId: result.reviewId,
                    state: result.state,
                    authorLogin: result.authorLogin,
                    body: result.body,
                  },
                })
              )
            })
            .catch(() => {
              window.dispatchEvent(
                new CustomEvent('alive:review-refresh', {
                  detail: { workspaceId: ws.id },
                })
              )
            })
        }
      }
    },
    [
      workspaceList,
      refreshPr,
      fetchIssueComment,
      fetchReviewComment,
      fetchReview,
    ]
  )

  useAliveEvents(handleEvent)

  return null
}
