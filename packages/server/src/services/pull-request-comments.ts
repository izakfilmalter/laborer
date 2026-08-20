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
import { spawn } from '../lib/spawn.js'
import { resolveOriginRepoSlug } from './github-pr-view.js'

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

interface GhApiFailure {
  readonly _tag: 'GhApiFailure'
  readonly message: string
}

const ghApiFailure = (message: string): GhApiFailure => ({
  _tag: 'GhApiFailure',
  message,
})

/**
 * A workspace can outlive its directory, for example when its project is
 * removed. Node reports a missing cwd as `spawn gh ENOENT`, which reads like
 * a missing GitHub CLI unless the worktree is named explicitly.
 */
const missingWorktreeFailure = (worktreePath: string): GhApiFailure =>
  ghApiFailure(`Worktree no longer exists: ${worktreePath}`)

/** The directory can also disappear between the guard and the spawn. */
const spawnFailure = (
  worktreePath: string,
  apiPath: string,
  error: unknown
): GhApiFailure =>
  existsSync(worktreePath)
    ? ghApiFailure(`Failed to run gh api ${apiPath}: ${String(error)}`)
    : missingWorktreeFailure(worktreePath)

interface GhApiOutput {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Run `gh` in a worktree, holding the child process in a scope.
 *
 * The fiber running this is interrupted whenever the caller's timeout fires,
 * a sibling request fails, or the client closes the pane — and interrupting
 * a fiber does nothing to the OS process it started. Acquiring the process
 * in a scope makes the kill part of the fiber's unwinding instead.
 */
const runGhApi = (
  worktreePath: string,
  apiPath: string
): Effect.Effect<GhApiOutput, GhApiFailure> =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(['gh', 'api', '--paginate', '--slurp', apiPath], {
            cwd: worktreePath,
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        catch: (error) => spawnFailure(worktreePath, apiPath, error),
      }),
      (spawned) => Effect.ignore(Effect.try(() => spawned.kill()))
    )

    return yield* Effect.tryPromise({
      try: async () => {
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()

        return { exitCode, stderr, stdout }
      },
      catch: (error) => spawnFailure(worktreePath, apiPath, error),
    })
  }).pipe(Effect.scoped)

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
    const result = yield* runGhApi(worktreePath, apiPath)

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
 */
const fetchPullRequestComments = Effect.fn('fetchPullRequestComments')(
  function* (worktreePath: string, prNumber: number) {
    if (!existsSync(worktreePath)) {
      return yield* Effect.fail(missingWorktreeFailure(worktreePath))
    }

    const repoSlug = yield* resolveOriginRepoSlug(worktreePath)
    if (repoSlug === null) {
      return yield* Effect.fail(
        ghApiFailure(
          `Could not resolve a GitHub repository from the origin remote in ${worktreePath}`
        )
      )
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

export { fetchPullRequestComments, parsePaginatedJsonArray }
export type { GhApiFailure }
