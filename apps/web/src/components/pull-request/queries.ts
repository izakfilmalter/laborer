/**
 * Query atoms and mutation atoms behind the pull request panel.
 *
 * The reads follow the pattern `conversation-query.ts` established: one
 * shared `Atom.family` per question so every surface reuses the same
 * in-flight read and cached result, a per-attempt timeout so a dead
 * connection can never hang the panel, and an idle TTL so a closed panel
 * releases its cache. The mutations are plain `LaborerClient.mutation`
 * atoms; callers refetch detail and activity after each one lands.
 */
import { RpcError } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { Atom } from 'effect/unstable/reactivity'
import { LaborerClient } from '@/atoms/laborer-client'

/** How long a single pull request read may take before it is abandoned. */
const PR_FETCH_TIMEOUT = '20 seconds'

const timeoutError = (message: string) =>
  Effect.fail(new RpcError({ message, code: 'TIMEOUT' }))

/** The header-shaped half: title, state, checks, and what the viewer may do. */
export const pullRequestDetailQuery = Atom.family((workspaceId: string) =>
  LaborerClient.runtime
    .atom(
      Effect.flatMap(LaborerClient, (client) =>
        client('pullRequest.detail', { workspaceId })
      ).pipe(
        Effect.timeoutOrElse({
          duration: PR_FETCH_TIMEOUT,
          orElse: () => timeoutError('Timed out reading the pull request'),
        })
      )
    )
    .pipe(Atom.setIdleTTL('1 minute'))
)

/** The conversation-shaped half: timeline, threads, commits, reviewers. */
export const pullRequestActivityQuery = Atom.family((workspaceId: string) =>
  LaborerClient.runtime
    .atom(
      Effect.flatMap(LaborerClient, (client) =>
        client('pullRequest.activity', { workspaceId })
      ).pipe(
        Effect.timeoutOrElse({
          duration: PR_FETCH_TIMEOUT,
          orElse: () =>
            timeoutError('Timed out reading the pull request activity'),
        })
      )
    )
    .pipe(Atom.setIdleTTL('1 minute'))
)

export interface PullRequestDiffRequest {
  readonly commit: string | null
  readonly cursor: string | null
  readonly workspaceId: string
}

/**
 * One slice of the diff is one question: workspace, commit scope, and
 * cursor together. `Atom.family` keys by identity, hence the string.
 */
export const pullRequestDiffRequestKey = (
  request: PullRequestDiffRequest
): string =>
  JSON.stringify([request.workspaceId, request.commit, request.cursor])

export const parsePullRequestDiffRequestKey = (
  key: string
): PullRequestDiffRequest | null => {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      return null
    }
    const [workspaceId, commit, cursor] = parsed as [unknown, unknown, unknown]
    if (typeof workspaceId !== 'string') {
      return null
    }
    return {
      workspaceId,
      commit: typeof commit === 'string' ? commit : null,
      cursor: typeof cursor === 'string' ? cursor : null,
    }
  } catch {
    return null
  }
}

/** A whole number of files of the unified patch, paged by cursor. */
export const pullRequestDiffQuery = Atom.family((requestKey: string) =>
  LaborerClient.runtime
    .atom(
      Effect.flatMap(LaborerClient, (client) => {
        const request = parsePullRequestDiffRequestKey(requestKey)
        if (request === null) {
          return Effect.fail(
            new RpcError({
              message: 'Could not read which diff slice was asked for',
              code: 'INVALID_DIFF_REQUEST',
            })
          )
        }
        return client('pullRequest.diff', {
          workspaceId: request.workspaceId,
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
          ...(request.commit === null ? {} : { commit: request.commit }),
        })
      }).pipe(
        Effect.timeoutOrElse({
          duration: '30 seconds',
          orElse: () => timeoutError('Timed out reading the pull request diff'),
        })
      )
    )
    .pipe(Atom.setIdleTTL('1 minute'))
)

/** Who a review may be asked of. Read only once the picker opens. */
export const pullRequestReviewerCandidatesQuery = Atom.family(
  (workspaceId: string) =>
    LaborerClient.runtime
      .atom(
        Effect.flatMap(LaborerClient, (client) =>
          client('pullRequest.reviewerCandidates', { workspaceId })
        ).pipe(
          Effect.timeoutOrElse({
            duration: PR_FETCH_TIMEOUT,
            orElse: () => timeoutError('Timed out reading who can review this'),
          })
        )
      )
      .pipe(Atom.setIdleTTL('1 minute'))
)

// ---------------------------------------------------------------------------
// Mutations — callers refetch detail/activity after each one lands.
// ---------------------------------------------------------------------------

export const pullRequestCommentMutation = LaborerClient.mutation(
  'pullRequest.comment'
)
export const pullRequestEditMutation =
  LaborerClient.mutation('pullRequest.edit')
export const pullRequestActionMutation =
  LaborerClient.mutation('pullRequest.action')
export const pullRequestSubmitReviewMutation = LaborerClient.mutation(
  'pullRequest.submitReview'
)
export const pullRequestReplyToThreadMutation = LaborerClient.mutation(
  'pullRequest.replyToThread'
)
export const pullRequestSetThreadResolutionMutation = LaborerClient.mutation(
  'pullRequest.setThreadResolution'
)
export const pullRequestSetReactionMutation = LaborerClient.mutation(
  'pullRequest.setReaction'
)
export const pullRequestRequestReviewersMutation = LaborerClient.mutation(
  'pullRequest.requestReviewers'
)
