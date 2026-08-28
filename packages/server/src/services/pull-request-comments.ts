/**
 * Pull request conversation reader.
 *
 * Reads a pull request's conversation straight from GitHub through the `gh`
 * CLI, so authentication rides on the user's existing GitHub login exactly
 * like {@link ../services/pr-watcher.js PrWatcher} does. Three REST
 * collections feed one timeline:
 *
 * - `issues/{n}/comments` — conversation comments on the pull request
 * - `pulls/{n}/reviews` — submitted reviews and their verdicts
 * - `pulls/{n}/comments` — comments anchored to a file and line in the diff
 *
 * The three shapes are normalized into {@link PullRequestComment} and sorted
 * oldest first, which is the order the UI renders as a timeline.
 *
 * Pending reviews are dropped: GitHub only shows them to their author, and a
 * body-less `COMMENTED` review is just the envelope around review comments
 * that already appear in the timeline on their own.
 *
 * Pagination rides on `gh api --paginate --slurp`, which wraps the pages in
 * one outer array. Without `--slurp` each page is printed as its own
 * top-level array, and stitching `[...][...]` back together means guessing
 * where one page ends — a guess any comment body containing `][` defeats,
 * and long conversations are exactly the case that paginates. `--slurp` has
 * shipped since GitHub CLI 2.42 (January 2024); an older CLI fails the
 * request with a message that says to upgrade rather than silently reading
 * one page.
 */

import { existsSync } from 'node:fs'
import type {
  PullRequestComment,
  PullRequestReviewState,
} from '@laborer/shared/rpc'
import { Effect, Schema } from 'effect'
import {
  type GhApiFailure,
  ghApiFailure,
  missingWorktreeFailure,
  runGh,
} from './gh-cli.js'

/** What an older `gh` prints when it does not know `--slurp`. */
const SLURP_UNSUPPORTED = 'unknown flag: --slurp'

/** GitHub's account shape, shared by every comment and review payload. */
const GhUser = Schema.Struct({
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.String,
})

const GhIssueComment = Schema.Struct({
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  html_url: Schema.String,
  id: Schema.Int,
  user: Schema.optional(Schema.NullOr(GhUser)),
})

const GhReview = Schema.Struct({
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  id: Schema.Int,
  state: Schema.String,
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GhUser)),
})

const GhReviewComment = Schema.Struct({
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  html_url: Schema.String,
  id: Schema.Int,
  in_reply_to_id: Schema.optional(Schema.NullOr(Schema.Int)),
  line: Schema.optional(Schema.NullOr(Schema.Int)),
  original_line: Schema.optional(Schema.NullOr(Schema.Int)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GhUser)),
})

const GhIssueComments = Schema.Array(GhIssueComment)
const GhReviews = Schema.Array(GhReview)
const GhReviewComments = Schema.Array(GhReviewComment)

/** Ghost and deleted accounts come back with no user object at all. */
const GHOST_USER = {
  authorAvatarUrl: null,
  authorLogin: 'ghost',
  authorUrl: null,
} as const

const authorOf = (user: typeof GhUser.Type | null | undefined) =>
  user
    ? {
        authorAvatarUrl: user.avatar_url ?? null,
        authorLogin: user.login,
        authorUrl: user.html_url ?? null,
      }
    : GHOST_USER

const REVIEW_STATES: Record<string, PullRequestReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changesRequested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

const reviewStateOf = (state: string): PullRequestReviewState =>
  REVIEW_STATES[state.toUpperCase()] ?? 'commented'

/**
 * Read the JSON `gh api --paginate --slurp` prints: one outer array holding
 * one array per page. A single page still arrives wrapped, and a plain array
 * is accepted so output that was never slurped still reads.
 */
const parsePaginatedJsonArray = (stdout: string): unknown => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return []
  }

  const parsed = JSON.parse(trimmed) as unknown
  if (Array.isArray(parsed) && parsed.every((page) => Array.isArray(page))) {
    return (parsed as unknown[][]).flat()
  }

  return parsed
}

/**
 * Run `gh api` in a worktree and decode the JSON array it prints. Failures
 * are values, not defects, so the caller can turn a missing `gh`, a revoked
 * token, or a deleted worktree into one RPC error.
 */
const ghApiList = <A, I>(
  schema: Schema.Codec<A, I>,
  worktreePath: string,
  apiPath: string
): Effect.Effect<A, GhApiFailure> =>
  Effect.gen(function* () {
    const result = yield* runGh(
      worktreePath,
      ['api', '--paginate', '--slurp', apiPath],
      `gh api ${apiPath}`
    )

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim()
      if (stderr.includes(SLURP_UNSUPPORTED)) {
        return yield* Effect.fail(
          ghApiFailure(
            'Reading pull request comments needs GitHub CLI 2.42 or newer (gh api --slurp)'
          )
        )
      }

      return yield* Effect.fail(
        ghApiFailure(
          stderr || `gh api ${apiPath} exited with ${result.exitCode}`
        )
      )
    }

    const parsed = yield* Effect.try({
      try: () => parsePaginatedJsonArray(result.stdout),
      catch: () => ghApiFailure(`Could not parse gh api ${apiPath} output`),
    })

    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(() =>
        ghApiFailure(`Unexpected gh api ${apiPath} response shape`)
      )
    )
  })

const issueCommentEntry = (
  comment: typeof GhIssueComment.Type
): PullRequestComment => ({
  ...authorOf(comment.user),
  body: comment.body ?? '',
  createdAt: comment.created_at,
  filePath: null,
  id: comment.id,
  inReplyToId: null,
  kind: 'issue',
  line: null,
  reviewState: null,
  url: comment.html_url,
})

const reviewEntry = (review: typeof GhReview.Type): PullRequestComment => ({
  ...authorOf(review.user),
  body: review.body ?? '',
  createdAt: review.submitted_at ?? '',
  filePath: null,
  id: review.id,
  inReplyToId: null,
  kind: 'review',
  line: null,
  reviewState: reviewStateOf(review.state),
  url: review.html_url,
})

const reviewCommentEntry = (
  comment: typeof GhReviewComment.Type
): PullRequestComment => ({
  ...authorOf(comment.user),
  body: comment.body ?? '',
  createdAt: comment.created_at,
  filePath: comment.path ?? null,
  id: comment.id,
  inReplyToId: comment.in_reply_to_id ?? null,
  kind: 'reviewComment',
  line: comment.line ?? comment.original_line ?? null,
  reviewState: null,
  url: comment.html_url,
})

/**
 * Whether a review earns its own timeline entry.
 *
 * A pending review is invisible to everyone but its author, and a body-less
 * `COMMENTED` review is only the envelope GitHub wraps around review
 * comments that already stand on their own.
 */
const isTimelineReview = (review: typeof GhReview.Type): boolean => {
  const state = reviewStateOf(review.state)
  if (state === 'pending') {
    return false
  }

  return state !== 'commented' || (review.body ?? '').trim().length > 0
}

/**
 * Oldest first — the order a conversation is read in.
 *
 * Comment ids and review ids come from separate GitHub sequences, so the id
 * tie-break says nothing about which entry really came first. It only has to
 * be deterministic, so entries sharing a timestamp keep the same order on
 * every render; that is the property this relies on, not the ordering.
 */
const byCreatedAt = (left: PullRequestComment, right: PullRequestComment) =>
  left.createdAt.localeCompare(right.createdAt) || left.id - right.id

/**
 * Read every conversation entry for a pull request.
 *
 * The three collections are fetched concurrently; any one of them failing
 * fails the whole read, because a half-loaded conversation is more
 * misleading than an error the user can retry.
 *
 * The repository is a parameter rather than something read back from the
 * worktree's origin remote, because the pull request a caller holds may live
 * in the fork's parent — see
 * {@link ./github-pr-view.js parsePullRequestRepoSlug}. Asking origin about
 * an upstream number reads someone else's conversation, or nobody's.
 */
const fetchPullRequestComments = Effect.fn('fetchPullRequestComments')(
  function* (worktreePath: string, repoSlug: string, prNumber: number) {
    if (!existsSync(worktreePath)) {
      return yield* Effect.fail(missingWorktreeFailure(worktreePath))
    }

    const [issueComments, reviews, reviewComments] = yield* Effect.all(
      [
        ghApiList(
          GhIssueComments,
          worktreePath,
          `repos/${repoSlug}/issues/${prNumber}/comments?per_page=100`
        ),
        ghApiList(
          GhReviews,
          worktreePath,
          `repos/${repoSlug}/pulls/${prNumber}/reviews?per_page=100`
        ),
        ghApiList(
          GhReviewComments,
          worktreePath,
          `repos/${repoSlug}/pulls/${prNumber}/comments?per_page=100`
        ),
      ],
      { concurrency: 3 }
    )

    return [
      ...issueComments.map(issueCommentEntry),
      ...reviews.filter(isTimelineReview).map(reviewEntry),
      ...reviewComments.map(reviewCommentEntry),
    ].sort(byCreatedAt)
  }
)

/**
 * How many opinionated reviews one request will read. A pull request with
 * more than this many distinct reviewers holding an opinion does not exist
 * in practice, and `totalCount` says when that assumption broke, so the
 * connection is asked for flat rather than paginated: `gh api --paginate`
 * follows exactly one cursor, and that cursor belongs to the threads.
 */
const MAX_OPINIONATED_REVIEWS = 100

/**
 * Two GraphQL-only facts, asked for together because they are read on the
 * same poll and GraphQL charges per request:
 *
 * - Whether a review thread is settled. The REST review comments carry no
 *   resolution state at all, so "unresolved conversations" has to be asked
 *   for here.
 * - Who currently holds an opinion. `latestOpinionatedReviews` is each
 *   reviewer's last APPROVED or CHANGES_REQUESTED verdict, which is the set
 *   github.com counts. The neighbouring `latestReviews` is each reviewer's
 *   last review of *any* kind, so an approver who later leaves a plain
 *   comment silently drops out of it.
 */
const REVIEW_SUMMARY_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      latestOpinionatedReviews(first:${MAX_OPINIONATED_REVIEWS}){
        totalCount
        nodes{state}
      }
      reviewThreads(first:100,after:$endCursor){
        nodes{isResolved}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`

const GhOpinionatedReviews = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ state: Schema.optional(Schema.NullOr(Schema.String)) })
  ),
  totalCount: Schema.Number,
})

const GhReviewThreadPage = Schema.Struct({
  // GraphQL can answer with data *and* errors: a field the token may not read
  // comes back null beside an entry here. Decoding the errors is what lets a
  // partially answered page fail instead of reading as a short count.
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          message: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.NullOr(
            Schema.Struct({
              latestOpinionatedReviews: Schema.optional(
                Schema.NullOr(GhOpinionatedReviews)
              ),
              reviewThreads: Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({ isResolved: Schema.Boolean })
                ),
              }),
            })
          ),
        })
      ),
    })
  ),
})
const GhReviewThreadPages = Schema.Array(GhReviewThreadPage)

/** What one poll needs to know about a pull request's reviews. */
interface PullRequestReviewSummary {
  /**
   * Reviewers whose standing opinion is an approval, or null when the answer
   * would be a guess — more reviewers than one request reads, or a GitHub
   * that did not return the field.
   */
  readonly approvals: number | null
  readonly unresolvedThreads: number
}

/**
 * Approvals on the pull request comes only from the first page: the reviews
 * connection carries no cursor, so every page repeats the same answer, and
 * adding them up would multiply the count by the number of thread pages.
 */
const approvalsOf = (
  reviews: typeof GhOpinionatedReviews.Type | null | undefined
): number | null => {
  if (reviews == null || reviews.totalCount > reviews.nodes.length) {
    return null
  }

  return reviews.nodes.filter(
    (review) => review.state?.toUpperCase() === 'APPROVED'
  ).length
}

/**
 * Read the review facts behind the pull request badge: how many threads are
 * still waiting on someone, and how many reviewers stand behind it.
 *
 * A thread is the unit of resolution, not a comment: a ten-reply argument
 * that ends in agreement is one settled thread, and counting its comments
 * would report nine outstanding things to do. Outdated threads still count,
 * matching what GitHub itself shows, because a thread against code that has
 * since moved is still a thread nobody answered.
 *
 * The repository is a parameter rather than something read back from the
 * worktree's origin remote, because the pull request a caller holds may live
 * in the fork's parent — see
 * {@link ./github-pr-view.js parsePullRequestRepoSlug}.
 */
const fetchPullRequestReviewSummary = Effect.fn(
  'fetchPullRequestReviewSummary'
)(function* (worktreePath: string, repoSlug: string, prNumber: number) {
  if (!existsSync(worktreePath)) {
    return yield* Effect.fail(missingWorktreeFailure(worktreePath))
  }

  const [owner, repo] = repoSlug.split('/')
  if (owner === undefined || repo === undefined || repo.length === 0) {
    return yield* Effect.fail(
      ghApiFailure(`Not a GitHub owner/repo pair: ${repoSlug}`)
    )
  }

  const label = `gh api graphql reviewSummary for #${prNumber}`
  const result = yield* runGh(
    worktreePath,
    [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
      '-F',
      `number=${prNumber}`,
      '-f',
      `query=${REVIEW_SUMMARY_QUERY}`,
    ],
    label
  )

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    return yield* Effect.fail(
      ghApiFailure(
        stderr.includes(SLURP_UNSUPPORTED)
          ? 'Reading unresolved review threads needs GitHub CLI 2.42 or newer (gh api --slurp)'
          : stderr || `${label} exited with ${result.exitCode}`
      )
    )
  }

  const parsed = yield* Effect.try({
    try: () => JSON.parse(result.stdout.trim() || '[]') as unknown,
    catch: () => ghApiFailure(`Could not parse ${label} output`),
  })

  const pages = yield* Schema.decodeUnknownEffect(GhReviewThreadPages)(
    parsed
  ).pipe(Effect.mapError(() => ghApiFailure(`Unexpected ${label} response`)))

  // A page whose data came back null is a query GitHub refused, not a pull
  // request with nothing on it, so it fails rather than reading as zero. A
  // page carrying errors is the same story told the other way: the threads
  // it did return are a partial answer, and a partial count reads as
  // progress nobody made.
  let unresolved = 0
  let approvals: number | null = null
  for (const [index, page] of pages.entries()) {
    const errors = page.errors ?? []
    if (errors.length > 0) {
      return yield* Effect.fail(
        ghApiFailure(
          `${label} returned errors: ${errors
            .map((error) => error.message ?? 'unknown error')
            .join('; ')}`
        )
      )
    }

    const pullRequest = page.data?.repository?.pullRequest
    if (pullRequest == null) {
      return yield* Effect.fail(
        ghApiFailure(`${label} returned no pull request`)
      )
    }
    if (index === 0) {
      approvals = approvalsOf(pullRequest.latestOpinionatedReviews)
    }
    unresolved += pullRequest.reviewThreads.nodes.filter(
      (thread) => !thread.isResolved
    ).length
  }

  return { approvals, unresolvedThreads: unresolved }
})

/** The thread half of {@link fetchPullRequestReviewSummary}, on its own. */
const fetchUnresolvedReviewThreadCount = (
  worktreePath: string,
  repoSlug: string,
  prNumber: number
): Effect.Effect<number, GhApiFailure> =>
  fetchPullRequestReviewSummary(worktreePath, repoSlug, prNumber).pipe(
    Effect.map((summary) => summary.unresolvedThreads)
  )

export {
  fetchPullRequestComments,
  fetchPullRequestReviewSummary,
  fetchUnresolvedReviewThreadCount,
  parsePaginatedJsonArray,
}
export type { GhApiFailure } from './gh-cli.js'
export type { PullRequestReviewSummary }
