/**
 * Pull request panel reads and mutations, backing the `pullRequest.*` RPCs
 * beyond the conversation timeline.
 *
 * Everything speaks to GitHub through the `gh` CLI so authentication rides
 * on the user's existing login, exactly like
 * {@link ./pull-request-comments.js}. Three kinds of call feed the panel:
 *
 * - `gh pr view` / `gh repo view` `--json` for the header-shaped detail
 * - `gh api` REST for the files-API diff, review submission, and reviewer
 *   requests
 * - `gh api graphql` for what REST cannot reach: review threads, reactions,
 *   thread replies and resolution
 *
 * Request bodies — comment text, GraphQL documents carrying a reader's own
 * words — travel over stdin rather than argv, which is visible in process
 * listings and echoed back inside failure messages.
 *
 * The repository is always a parameter rather than something read back from
 * the worktree's origin remote, because the pull request a workspace holds
 * may live in the fork's parent — see
 * {@link ./github-pr-view.js parsePullRequestRepoSlug}.
 */

import { existsSync } from 'node:fs'
import type {
  PullRequestActionKind,
  PullRequestActivity,
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestDiffChangeType,
  PullRequestDiffResult,
  PullRequestFileContents,
  PullRequestMergeMethod,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestUpdateMethod,
} from '@laborer/shared/rpc'
import { Effect, Schema } from 'effect'
import {
  type GhApiFailure,
  ghApiFailure,
  missingWorktreeFailure,
  runGhExpectingSuccess,
} from './gh-cli.js'
import { fetchPullRequestComments } from './pull-request-comments.js'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? ''
  return text.length > 0 ? text : null
}

/**
 * A commit sha arrives from the client and goes straight into a request
 * path, so it is checked rather than trusted: hexadecimal only, from the
 * shortest abbreviation GitHub prints up to a whole sha.
 */
const COMMIT_SHA_REGEX = /^[0-9a-f]{7,64}$/i

const isCommitSha = (value: string): boolean => COMMIT_SHA_REGEX.test(value)

/**
 * The page a diff cursor names, or null for anything this walk cannot have
 * issued. The cursor goes into a request path, so it is parsed rather than
 * trusted; the length bound keeps a page number out of exponential notation.
 */
const DIFF_CURSOR_REGEX = /^[1-9][0-9]{0,6}$/

const diffCursorPage = (cursor: string): number | null =>
  DIFF_CURSOR_REGEX.test(cursor) ? Number(cursor) : null

/** Ensure exactly one trailing newline on a hunk block. */
const TRAILING_NEWLINE_REGEX = /\n?$/

const guardWorktree = (worktreePath: string) =>
  existsSync(worktreePath)
    ? Effect.void
    : Effect.fail(missingWorktreeFailure(worktreePath))

/** Decode a JSON document `gh` printed, naming the read that produced it. */
const decodeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  raw: string,
  label: string
): Effect.Effect<A, GhApiFailure> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => ghApiFailure(`Could not parse ${label} output`),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(schema)(parsed).pipe(
        Effect.mapError(() => ghApiFailure(`Unexpected ${label} response`))
      )
    )
  )

/**
 * Split `owner/repo`, refusing anything that is not one — each half goes
 * into a GraphQL variable or a request path as itself.
 */
const splitRepoSlug = (
  repoSlug: string
): Effect.Effect<
  { readonly owner: string; readonly repo: string },
  GhApiFailure
> => {
  const [owner, repo, ...rest] = repoSlug.split('/')
  if (
    owner === undefined ||
    repo === undefined ||
    owner.length === 0 ||
    repo.length === 0 ||
    rest.length > 0
  ) {
    return Effect.fail(
      ghApiFailure(`Not a GitHub owner/repo pair: ${repoSlug}`)
    )
  }
  return Effect.succeed({ owner, repo })
}

/**
 * A GraphQL request over stdin, so nothing a reader typed reaches argv. `gh`
 * exits non-zero on a GraphQL error, so a failed mutation is already a
 * failed command rather than a body to inspect.
 */
const runGraphql = (
  worktreePath: string,
  query: string,
  variables: Readonly<Record<string, string | number | boolean>>,
  label: string
) =>
  runGhExpectingSuccess(
    worktreePath,
    ['api', 'graphql', '--input', '-'],
    label,
    {
      stdin: JSON.stringify({ query, variables }),
    }
  )

// ---------------------------------------------------------------------------
// Shared raw GitHub shapes
// ---------------------------------------------------------------------------

const GhActor = Schema.Struct({
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
})

const toActor = (
  raw: typeof GhActor.Type | null | undefined
): PullRequestActor | null => {
  const login = trimmed(raw?.login)
  return login === null
    ? null
    : {
        avatarUrl: trimmed(raw?.avatarUrl),
        login,
        name: trimmed(raw?.name),
      }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const GhLabel = Schema.Struct({
  color: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.String,
})

const GhReviewRequest = Schema.Struct({
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhCheck = Schema.Struct({
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhPrDetail = Schema.Struct({
  additions: Schema.optional(Schema.Int),
  author: Schema.optional(Schema.NullOr(GhActor)),
  /** An object where somebody armed auto-merge, a JSON null where nobody
   *  has, and absent where GitHub did not answer for it at all. */
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Unknown)),
  baseRefName: Schema.String,
  body: Schema.optional(Schema.String),
  changedFiles: Schema.optional(Schema.Int),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  deletions: Schema.optional(Schema.Int),
  headRefName: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  labels: Schema.optional(Schema.Array(GhLabel)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.Int,
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  reviewRequests: Schema.optional(Schema.Array(GhReviewRequest)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(GhCheck))),
  title: Schema.String,
  updatedAt: Schema.String,
  url: Schema.String,
})

const GhRepoAccess = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
})

/** Every JSON field the detail read asks `gh pr view` for. */
const DETAIL_JSON_FIELDS =
  'number,title,body,url,author,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,closedAt,reviewRequests,labels,statusCheckRollup,autoMergeRequest'

const REPO_ACCESS_JSON_FIELDS =
  'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission'

const toState = (raw: {
  readonly state?: string | null | undefined
  readonly mergedAt?: string | null | undefined
}): PullRequestDetail['state'] => {
  if (trimmed(raw.mergedAt) !== null) {
    return 'merged'
  }
  const state = raw.state?.trim().toUpperCase()
  if (state === 'MERGED') {
    return 'merged'
  }
  if (state === 'CLOSED') {
    return 'closed'
  }
  return 'open'
}

const toMergeability = (
  value: string | null | undefined
): PullRequestDetail['mergeability'] => {
  switch (value?.trim().toUpperCase()) {
    case 'MERGEABLE':
      return 'mergeable'
    case 'CONFLICTING':
      return 'conflicting'
    default:
      return 'unknown'
  }
}

const toReviewDecision = (
  value: string | null | undefined
): PullRequestReviewDecision | null => {
  switch (value?.trim().toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changesRequested'
    case 'REVIEW_REQUIRED':
      return 'reviewRequired'
    default:
      return null
  }
}

const toCheckStatus = (raw: typeof GhCheck.Type): PullRequestCheckStatus => {
  // Commit statuses report a single `state`; check runs report `status` plus
  // a `conclusion` that only exists once the run has completed.
  const status = raw.status?.trim().toUpperCase()
  if (status !== undefined && status !== 'COMPLETED' && status !== '') {
    return 'pending'
  }
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
    // A completed check asking for manual intervention blocks, so it reads
    // as a failure rather than as neutral.
    case 'ACTION_REQUIRED':
      return 'failure'
    case 'CANCELLED':
      return 'cancelled'
    case 'SKIPPED':
      return 'skipped'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'neutral'
  }
}

/** What GitHub writes where a run has not reached that moment, not a time. */
const UNSET_TIMESTAMP = '0001-01-01T00:00:00Z'

const realTimestamp = (value: string | null | undefined): string | null => {
  const at = trimmed(value)
  return at === null || at === UNSET_TIMESTAMP ? null : at
}

/**
 * The rollup as one row per check, re-runs collapsed: two entries sharing a
 * workflow and a name are the same check run twice, and only the newest run
 * is a verdict. Ordering keeps each check's first appearance.
 */
const toChecks = (
  raw: readonly (typeof GhCheck.Type)[] | null | undefined
): readonly PullRequestCheck[] => {
  const byKey = new Map<string, { at: string; check: PullRequestCheck }>()
  for (const entry of raw ?? []) {
    const name = trimmed(entry.name) ?? trimmed(entry.context)
    if (name === null) {
      continue
    }
    const key = `${trimmed(entry.workflowName) ?? ''}\n${name}`
    const at =
      realTimestamp(entry.completedAt) ?? realTimestamp(entry.startedAt) ?? ''
    const check: PullRequestCheck = {
      description: trimmed(entry.description),
      name,
      status: toCheckStatus(entry),
      url: trimmed(entry.detailsUrl) ?? trimmed(entry.targetUrl),
    }
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { at, check })
    } else if (at.localeCompare(existing.at) > 0) {
      existing.at = at
      existing.check = check
    }
  }
  return [...byKey.values()].map((entry) => entry.check)
}

/** Outstanding review requests as actors; a team wears its slug as login. */
const toRequestedReviewers = (
  raw: readonly (typeof GhReviewRequest.Type)[] | undefined
): readonly PullRequestActor[] =>
  (raw ?? []).flatMap((request) => {
    const login = trimmed(request.login) ?? trimmed(request.slug)
    return login === null
      ? []
      : [
          {
            avatarUrl: trimmed(request.avatarUrl),
            login,
            name: trimmed(request.name),
          },
        ]
  })

/**
 * Whether the viewer's role on the repository is one that can push, which
 * is what merging needs. An unreported permission does not count as write:
 * offering a merge to a reader who cannot use it wastes the press.
 */
const toCanWrite = (viewerPermission: string | null | undefined): boolean => {
  switch (viewerPermission?.trim().toUpperCase()) {
    case 'ADMIN':
    case 'MAINTAIN':
    case 'WRITE':
      return true
    default:
      return false
  }
}

/**
 * Read the header-shaped half of the pull request: one `gh pr view`, one
 * `gh repo view` for the merge settings and the viewer's standing, and one
 * `gh api user` for who the reader is — concurrently, since none depends on
 * another.
 */
const fetchPullRequestDetail = Effect.fn('fetchPullRequestDetail')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number
) {
  yield* guardWorktree(worktreePath)

  const [detailRaw, accessRaw, viewerRaw] = yield* Effect.all(
    [
      runGhExpectingSuccess(
        worktreePath,
        [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          repoSlug,
          '--json',
          DETAIL_JSON_FIELDS,
        ],
        `gh pr view #${prNumber}`
      ),
      runGhExpectingSuccess(
        worktreePath,
        ['repo', 'view', repoSlug, '--json', REPO_ACCESS_JSON_FIELDS],
        `gh repo view ${repoSlug}`
      ),
      // The viewer login is a nicety, not a gate: a failure here must not
      // hold the title and the merge button off screen.
      runGhExpectingSuccess(
        worktreePath,
        ['api', 'user', '--jq', '.login'],
        'gh api user'
      ).pipe(Effect.orElseSucceed(() => null)),
    ],
    { concurrency: 3 }
  )

  const detail = yield* decodeJson(
    GhPrDetail,
    detailRaw.stdout.trim(),
    `gh pr view #${prNumber}`
  )
  const access = yield* decodeJson(
    GhRepoAccess,
    accessRaw.stdout.trim(),
    `gh repo view ${repoSlug}`
  )

  const result: PullRequestDetail = {
    additions: detail.additions ?? 0,
    author: toActor(detail.author),
    // A JSON null is GitHub saying "nobody armed this"; a missing key is
    // GitHub not saying, and the difference survives as null-vs-boolean.
    autoMergeEnabled:
      detail.autoMergeRequest === undefined
        ? null
        : detail.autoMergeRequest !== null,
    baseBranch: detail.baseRefName,
    body: detail.body ?? '',
    changedFiles: detail.changedFiles ?? 0,
    checks: toChecks(detail.statusCheckRollup),
    closedAt: trimmed(detail.closedAt),
    createdAt: detail.createdAt,
    deletions: detail.deletions ?? 0,
    headBranch: detail.headRefName,
    isDraft: detail.isDraft ?? false,
    labels: (detail.labels ?? []).flatMap((label) => {
      const name = trimmed(label.name)
      return name === null ? [] : [{ color: trimmed(label.color), name }]
    }),
    mergeability: toMergeability(detail.mergeable),
    mergeCapabilities: {
      merge: access.mergeCommitAllowed,
      rebase: access.rebaseMergeAllowed,
      squash: access.squashMergeAllowed,
    },
    mergedAt: trimmed(detail.mergedAt),
    number: detail.number,
    reviewDecision: toReviewDecision(detail.reviewDecision),
    reviewers: toRequestedReviewers(detail.reviewRequests),
    state: toState(detail),
    title: detail.title,
    updatedAt: detail.updatedAt,
    url: detail.url,
    viewer: viewerRaw === null ? null : trimmed(viewerRaw.stdout),
    viewerCanWrite: toCanWrite(access.viewerPermission),
  }
  return result
})

// ---------------------------------------------------------------------------
// Activity — review threads, reactions, commits, roster
// ---------------------------------------------------------------------------

/** GitHub's reaction names against Laborer's camelCase spellings. */
const REACTION_CONTENT_BY_GITHUB: Readonly<
  Record<string, PullRequestReactionContent>
> = {
  CONFUSED: 'confused',
  EYES: 'eyes',
  HEART: 'heart',
  HOORAY: 'hooray',
  LAUGH: 'laugh',
  ROCKET: 'rocket',
  THUMBS_DOWN: 'thumbsDown',
  THUMBS_UP: 'thumbsUp',
}

const GITHUB_REACTION_BY_CONTENT: Readonly<
  Record<PullRequestReactionContent, string>
> = {
  confused: 'CONFUSED',
  eyes: 'EYES',
  heart: 'HEART',
  hooray: 'HOORAY',
  laugh: 'LAUGH',
  rocket: 'ROCKET',
  thumbsDown: 'THUMBS_DOWN',
  thumbsUp: 'THUMBS_UP',
}

const GhReactionGroups = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        reactors: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              totalCount: Schema.optional(Schema.Int),
            })
          )
        ),
        viewerHasReacted: Schema.optional(Schema.Boolean),
      })
    )
  )
)

type GhReactionGroupsType = typeof GhReactionGroups.Type

/** The groups GitHub answered with; one nobody chose is dropped. */
const toReactions = (
  groups: GhReactionGroupsType
): readonly PullRequestReaction[] => {
  const reactions: PullRequestReaction[] = []
  for (const group of groups ?? []) {
    const content =
      REACTION_CONTENT_BY_GITHUB[trimmed(group.content)?.toUpperCase() ?? '']
    if (content === undefined) {
      continue
    }
    const count = group.reactors?.totalCount ?? 0
    if (count <= 0) {
      continue
    }
    reactions.push({
      content,
      count,
      viewerHasReacted: group.viewerHasReacted === true,
    })
  }
  return reactions
}

const REACTION_GROUPS_FIELDS = `reactionGroups {
  content
  viewerHasReacted
  reactors { totalCount }
}`

/**
 * One page of the conversation's GraphQL half. `$endCursor` walks the review
 * threads; everything else repeats identically on every page and is read
 * off the first.
 *
 * `comments` and `reviews` are asked for their ids and reactions alone: the
 * words arrive through the REST timeline, which carries no node id and no
 * reaction of any kind, and `databaseId` is what marries the two reads.
 *
 * Commits are asked for with `last` rather than `first` so a pull request
 * with more than a hundred commits keeps its newest ones.
 */
const ACTIVITY_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      ${REACTION_GROUPS_FIELDS}
      comments(first:100){ nodes{ id databaseId ${REACTION_GROUPS_FIELDS} } }
      reviews(first:100){ nodes{ id databaseId ${REACTION_GROUPS_FIELDS} } }
      reviewRequests(first:50){ nodes{ requestedReviewer{
        ... on User { login name avatarUrl }
        ... on Bot { login avatarUrl }
        ... on Team { slug name avatarUrl }
      } } }
      latestReviews(first:50){ nodes{ author{ login avatarUrl } } }
      commits(last:100){ nodes{ commit{
        oid messageHeadline committedDate additions deletions
        authors(first:3){ nodes{ name avatarUrl user{ login } } }
      } } }
      reviewThreads(first:50,after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line diffSide
          comments(first:50){
            totalCount
            nodes{ id databaseId author{ login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS} }
          }
        }
      }
    }
  }
}`

const GhThreadComment = Schema.Struct({
  author: Schema.optional(Schema.NullOr(GhActor)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  databaseId: Schema.optional(Schema.NullOr(Schema.Int)),
  id: Schema.String,
  reactionGroups: GhReactionGroups,
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhReactableNode = Schema.Struct({
  databaseId: Schema.optional(Schema.NullOr(Schema.Int)),
  id: Schema.String,
  reactionGroups: GhReactionGroups,
})

const GhRequestedReviewer = Schema.Struct({
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhActivityPullRequest = Schema.Struct({
  comments: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(GhReactableNode) }))
  ),
  commits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            commit: Schema.Struct({
              additions: Schema.optional(Schema.NullOr(Schema.Int)),
              authors: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    nodes: Schema.Array(
                      Schema.Struct({
                        avatarUrl: Schema.optional(
                          Schema.NullOr(Schema.String)
                        ),
                        name: Schema.optional(Schema.NullOr(Schema.String)),
                        user: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({
                              login: Schema.optional(
                                Schema.NullOr(Schema.String)
                              ),
                            })
                          )
                        ),
                      })
                    ),
                  })
                )
              ),
              committedDate: Schema.optional(Schema.NullOr(Schema.String)),
              deletions: Schema.optional(Schema.NullOr(Schema.Int)),
              messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
              oid: Schema.String,
            }),
          })
        ),
      })
    )
  ),
  latestReviews: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({ author: Schema.optional(Schema.NullOr(GhActor)) })
        ),
      })
    )
  ),
  reactionGroups: GhReactionGroups,
  reviewRequests: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            requestedReviewer: Schema.optional(
              Schema.NullOr(GhRequestedReviewer)
            ),
          })
        ),
      })
    )
  ),
  reviews: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(GhReactableNode) }))
  ),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        comments: Schema.Struct({
          nodes: Schema.Array(GhThreadComment),
          totalCount: Schema.optional(Schema.Int),
        }),
        diffSide: Schema.optional(Schema.NullOr(Schema.String)),
        id: Schema.optional(Schema.NullOr(Schema.String)),
        isOutdated: Schema.optional(Schema.Boolean),
        isResolved: Schema.optional(Schema.Boolean),
        line: Schema.optional(Schema.NullOr(Schema.Int)),
        path: Schema.optional(Schema.NullOr(Schema.String)),
      })
    ),
  }),
})

const GhActivityPage = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          pullRequest: Schema.NullOr(GhActivityPullRequest),
        })
      ),
    })
  ),
  // GraphQL can answer with data *and* errors: decoding the errors is what
  // lets a partially answered page fail instead of reading as a short list.
  errors: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          message: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
})

const GhActivityPages = Schema.Array(GhActivityPage)

/** What an older `gh` prints when it does not know `--slurp`. */
const SLURP_UNSUPPORTED = 'unknown flag: --slurp'

/** Reactions and the node id a database id resolves to, for the timeline. */
interface ReactableFacts {
  readonly nodeId: string
  readonly reactions: readonly PullRequestReaction[]
}

type GhActivityPullRequestType = typeof GhActivityPullRequest.Type

/** What the walk over the activity's thread pages accumulates. */
interface ThreadAccumulator {
  readonly factsByDatabaseId: Map<number, ReactableFacts>
  readonly reviewThreads: PullRequestReviewThread[]
  threadsTruncated: boolean
}

/** One GraphQL review thread as the contract carries it, or nothing. */
const toReviewThread = (
  thread: GhActivityPullRequestType['reviewThreads']['nodes'][number]
): PullRequestReviewThread | null => {
  const id = trimmed(thread.id)
  const path = trimmed(thread.path)
  if (id === null || path === null) {
    return null
  }
  return {
    comments: thread.comments.nodes.map((comment) => ({
      author: toActor(comment.author),
      body: comment.body ?? '',
      createdAt: comment.createdAt,
      id: comment.id,
      reactions: toReactions(comment.reactionGroups),
      url: trimmed(comment.url),
    })),
    id,
    isOutdated: thread.isOutdated === true,
    isResolved: thread.isResolved === true,
    line:
      thread.line !== null && thread.line !== undefined && thread.line > 0
        ? thread.line
        : null,
    path,
    side: thread.diffSide?.toUpperCase() === 'LEFT' ? 'left' : 'right',
  }
}

/** Fold one page's threads into the accumulator: whole conversations for
 *  the diff, and node ids keyed by database id for the timeline. */
const collectThreadPage = (
  pullRequest: GhActivityPullRequestType,
  accumulator: ThreadAccumulator
): void => {
  for (const thread of pullRequest.reviewThreads.nodes) {
    const mapped = toReviewThread(thread)
    if (mapped === null) {
      continue
    }
    if (
      (thread.comments.totalCount ?? thread.comments.nodes.length) >
      thread.comments.nodes.length
    ) {
      accumulator.threadsTruncated = true
    }
    for (const comment of thread.comments.nodes) {
      if (comment.databaseId != null) {
        accumulator.factsByDatabaseId.set(comment.databaseId, {
          nodeId: comment.id,
          reactions: toReactions(comment.reactionGroups),
        })
      }
    }
    accumulator.reviewThreads.push(mapped)
  }
}

/**
 * Everyone on the review, asked or answered, keyed by login so someone who
 * was asked and then answered appears once. A team wears its slug.
 */
const rosterOf = (
  pullRequest: GhActivityPullRequestType
): readonly PullRequestActor[] => {
  const roster = new Map<string, PullRequestActor>()
  const sources: readonly (
    | typeof GhRequestedReviewer.Type
    | null
    | undefined
  )[] = [
    ...(pullRequest.reviewRequests?.nodes ?? []).map(
      (node) => node.requestedReviewer
    ),
    ...(pullRequest.latestReviews?.nodes ?? []).map((node) => node.author),
  ]
  for (const raw of sources) {
    const login = trimmed(raw?.login) ?? trimmed(raw?.slug)
    if (login === null || roster.has(login)) {
      continue
    }
    roster.set(login, {
      avatarUrl: trimmed(raw?.avatarUrl),
      login,
      name: trimmed(raw?.name),
    })
  }
  return [...roster.values()]
}

const commitsOf = (
  pullRequest: GhActivityPullRequestType
): readonly PullRequestCommit[] =>
  (pullRequest.commits?.nodes ?? []).flatMap((node) => {
    const committedDate = trimmed(node.commit.committedDate)
    if (committedDate === null) {
      return []
    }
    return [
      {
        additions: node.commit.additions ?? null,
        authors: (node.commit.authors?.nodes ?? []).flatMap((author) => {
          const login = trimmed(author.user?.login) ?? trimmed(author.name)
          return login === null
            ? []
            : [
                {
                  avatarUrl: trimmed(author.avatarUrl),
                  login,
                  name: trimmed(author.name),
                },
              ]
        }),
        committedDate,
        deletions: node.commit.deletions ?? null,
        messageHeadline: node.commit.messageHeadline ?? '',
        oid: node.commit.oid,
      },
    ]
  })

/** Node ids and reactions for the conversation comments and reviews the
 *  REST timeline answers for without any. */
const collectReactableNodes = (
  pullRequest: GhActivityPullRequestType,
  factsByDatabaseId: Map<number, ReactableFacts>
): void => {
  for (const node of [
    ...(pullRequest.comments?.nodes ?? []),
    ...(pullRequest.reviews?.nodes ?? []),
  ]) {
    if (node.databaseId != null) {
      factsByDatabaseId.set(node.databaseId, {
        nodeId: node.id,
        reactions: toReactions(node.reactionGroups),
      })
    }
  }
}

/**
 * Why one page cannot be read, or null for a whole one. A page whose data
 * came back null is a query GitHub refused, not a pull request with nothing
 * on it, so it fails rather than reading as empty; a page carrying errors
 * is a partial answer, and a partial conversation misleads.
 */
const activityPageFailure = (
  page: typeof GhActivityPage.Type,
  label: string
): GhApiFailure | null => {
  const errors = page.errors ?? []
  if (errors.length > 0) {
    return ghApiFailure(
      `${label} returned errors: ${errors
        .map((error) => error.message ?? 'unknown error')
        .join('; ')}`
    )
  }
  if (page.data?.repository?.pullRequest == null) {
    return ghApiFailure(`${label} returned no pull request`)
  }
  return null
}

/**
 * Read the conversation: the REST timeline and the GraphQL half — review
 * threads, reactions, commits, and the reviewer roster — concurrently, then
 * marry the two by database id so timeline entries carry the node ids that
 * reactions are addressed by.
 */
const fetchPullRequestActivity = Effect.fn('fetchPullRequestActivity')(
  function* (worktreePath: string, repoSlug: string, prNumber: number) {
    yield* guardWorktree(worktreePath)
    const { owner, repo } = yield* splitRepoSlug(repoSlug)

    const label = `gh api graphql activity for #${prNumber}`
    const [timeline, graphqlRaw] = yield* Effect.all(
      [
        fetchPullRequestComments(worktreePath, repoSlug, prNumber),
        runGhExpectingSuccess(
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
            `query=${ACTIVITY_QUERY}`,
          ],
          label
        ).pipe(
          Effect.mapError((failure) =>
            failure.message.includes(SLURP_UNSUPPORTED)
              ? ghApiFailure(
                  'Reading pull request activity needs GitHub CLI 2.42 or newer (gh api --slurp)'
                )
              : failure
          )
        ),
      ],
      { concurrency: 2 }
    )

    const pages = yield* decodeJson(
      GhActivityPages,
      graphqlRaw.stdout.trim() || '[]',
      label
    )

    const accumulator: ThreadAccumulator = {
      factsByDatabaseId: new Map<number, ReactableFacts>(),
      reviewThreads: [],
      threadsTruncated: false,
    }
    let reactions: readonly PullRequestReaction[] = []
    let reviewers: readonly PullRequestActor[] = []
    let commits: readonly PullRequestCommit[] = []

    for (const [index, page] of pages.entries()) {
      const failure = activityPageFailure(page, label)
      if (failure !== null) {
        return yield* Effect.fail(failure)
      }
      const pullRequest = page.data?.repository?.pullRequest
      if (pullRequest == null) {
        continue
      }
      collectThreadPage(pullRequest, accumulator)

      // The roster, the commits, and the pull request's own reactions travel
      // with every page, and the first one already carries all of them.
      if (index === 0) {
        reactions = toReactions(pullRequest.reactionGroups)
        collectReactableNodes(pullRequest, accumulator.factsByDatabaseId)
        reviewers = rosterOf(pullRequest)
        commits = commitsOf(pullRequest)
      }
    }

    const comments: readonly PullRequestComment[] = timeline.map((entry) => {
      const facts = accumulator.factsByDatabaseId.get(entry.id)
      return facts === undefined
        ? entry
        : { ...entry, nodeId: facts.nodeId, reactions: facts.reactions }
    })

    const activity: PullRequestActivity = {
      comments,
      commits,
      reactions,
      reviewers,
      reviewThreads: accumulator.reviewThreads,
      threadsTruncated: accumulator.threadsTruncated,
    }
    return activity
  }
)

// ---------------------------------------------------------------------------
// Diff — the files API assembled into a unified patch
// ---------------------------------------------------------------------------

/** What the files API serves at most in one response — one slice of files. */
const DIFF_FILES_PAGE_SIZE = 100

const GhPullFile = Schema.Struct({
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
  filename: Schema.String,
  /** Absent for a binary file, and for a diff GitHub considers too large. */
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only on a rename, naming the file the hunks are counted against. */
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhPullFiles = Schema.Array(GhPullFile)

/**
 * One file's slice of the patch, and its stats when GitHub withheld the
 * hunks. A file with no hunks is still a file that changed: a pure rename
 * has none to give, and a binary one has none that can be shown. Both are
 * listed, and only the second is a hole in the patch.
 */
const filePatchSection = (
  file: typeof GhPullFile.Type
): {
  readonly omitted: PullRequestOmittedFileStat | null
  readonly section: string
} => {
  const hunks = file.patch ?? ''
  const status = file.status?.trim().toLowerCase()
  const additions = file.additions ?? 0
  const deletions = file.deletions ?? 0
  const omitted =
    hunks.length === 0 && additions + deletions > 0
      ? { additions, deletions, path: file.filename }
      : null
  // A rename counts its hunks against the old path, which is the only place
  // it is named.
  const oldPath =
    status === 'renamed'
      ? (trimmed(file.previous_filename) ?? file.filename)
      : file.filename
  const header = [
    `diff --git a/${oldPath} b/${file.filename}`,
    // The files API reports no file mode, so the ordinary one stands in:
    // the viewer reads these lines as "added" and "removed" rather than
    // for the mode they carry.
    ...(status === 'added' ? ['new file mode 100644'] : []),
    ...(status === 'removed' ? ['deleted file mode 100644'] : []),
    ...(status === 'renamed'
      ? [`rename from ${oldPath}`, `rename to ${file.filename}`]
      : []),
    `--- ${status === 'added' ? '/dev/null' : `a/${oldPath}`}`,
    `+++ ${status === 'removed' ? '/dev/null' : `b/${file.filename}`}`,
  ].join('\n')
  return {
    omitted,
    section:
      hunks.length === 0
        ? `${header}\n`
        : `${header}\n${hunks.replace(TRAILING_NEWLINE_REGEX, '\n')}`,
  }
}

/**
 * The files API returns hunks per file with no `diff --git` header, so the
 * unified patch every diff viewer expects is assembled here.
 */
const buildFilesPatch = (
  files: readonly (typeof GhPullFile.Type)[]
): {
  readonly omittedFileStats: readonly PullRequestOmittedFileStat[]
  readonly patch: string
  readonly truncated: boolean
} => {
  const sections: string[] = []
  const omittedFileStats: PullRequestOmittedFileStat[] = []
  for (const file of files) {
    const { omitted, section } = filePatchSection(file)
    if (omitted !== null) {
      omittedFileStats.push(omitted)
    }
    sections.push(section)
  }
  return {
    omittedFileStats,
    patch: sections.join(''),
    truncated: omittedFileStats.length > 0,
  }
}

/**
 * One slice of the pull request's patch, a whole number of files at a time.
 * A named commit is read from the commit endpoint, which lists the same
 * file entries and pages them the same way — only wrapped in an object,
 * which jq unwraps before they are decoded. An empty commit carries no
 * `files` at all, which is a commit with nothing in it rather than an
 * answer that could not be read.
 */
const fetchPullRequestDiff = Effect.fn('fetchPullRequestDiff')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  options?: {
    readonly commit?: string | undefined
    readonly cursor?: string | undefined
  }
) {
  yield* guardWorktree(worktreePath)

  const commit = options?.commit
  if (commit !== undefined && !isCommitSha(commit)) {
    return yield* Effect.fail(
      ghApiFailure(`Not a commit sha this repository could hold: ${commit}`)
    )
  }
  const page =
    options?.cursor === undefined ? 1 : diffCursorPage(options.cursor)
  if (page === null) {
    return yield* Effect.fail(
      ghApiFailure('The diff cursor was not one this pull request handed out')
    )
  }

  const paging = `per_page=${DIFF_FILES_PAGE_SIZE}&page=${page}`
  const label =
    commit === undefined
      ? `gh api pulls/${prNumber}/files page ${page}`
      : `gh api commits/${commit} page ${page}`
  const result = yield* runGhExpectingSuccess(
    worktreePath,
    [
      'api',
      commit === undefined
        ? `repos/${repoSlug}/pulls/${prNumber}/files?${paging}`
        : `repos/${repoSlug}/commits/${commit}?${paging}`,
      ...(commit === undefined ? [] : ['--jq', '.files // []']),
    ],
    label
  )

  const files = yield* decodeJson(GhPullFiles, result.stdout.trim(), label)
  const assembled = buildFilesPatch(files)
  const diff: PullRequestDiffResult = {
    nextCursor: files.length >= DIFF_FILES_PAGE_SIZE ? String(page + 1) : null,
    omittedFileStats: assembled.omittedFileStats,
    patch: assembled.patch,
    truncated: assembled.truncated,
  }
  return diff
})

/** Expansion serves source files, not blobs that would stall a review pane. */
const DIFF_FILE_MAX_BYTES = 1024 * 1024

/**
 * Both sides of one diff file in full: the base (or parent-commit) revision
 * for the old side, the head for the new. Binary and oversized blobs are
 * refused rather than rendered as garbage.
 */
const fetchPullRequestDiffFileContents = Effect.fn(
  'fetchPullRequestDiffFileContents'
)(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly changeType: PullRequestDiffChangeType
    readonly commit?: string | undefined
    readonly newPath: string
    readonly oldPath: string
  }
) {
  yield* guardWorktree(worktreePath)

  const commit = input.commit
  if (commit !== undefined && !isCommitSha(commit)) {
    return yield* Effect.fail(
      ghApiFailure(`Not a commit sha this repository could hold: ${commit}`)
    )
  }

  const refsLabel = `gh api revisions for #${prNumber}`
  const refsResult = yield* runGhExpectingSuccess(
    worktreePath,
    [
      'api',
      commit === undefined
        ? `repos/${repoSlug}/pulls/${prNumber}`
        : `repos/${repoSlug}/commits/${commit}`,
      '--jq',
      commit === undefined
        ? '[.base.sha, .head.sha] | @tsv'
        : '[.parents[0].sha, .sha] | @tsv',
    ],
    refsLabel
  )

  // Keep a leading tab: a root commit has no parent, and jq represents that
  // absent old revision as the empty field before the tab. Every file in it
  // is new, so that is a usable answer whenever the old side is not needed.
  const [baseRef, headRef, ...extraRefs] = refsResult.stdout
    .trimEnd()
    .split('\t')
  const rootCommitNewFile =
    commit !== undefined && input.changeType === 'new' && baseRef === ''
  if (
    !headRef ||
    extraRefs.length > 0 ||
    (!rootCommitNewFile && (baseRef === undefined || !isCommitSha(baseRef))) ||
    !isCommitSha(headRef)
  ) {
    return yield* Effect.fail(
      ghApiFailure(
        `Pull request #${prNumber} reported no usable base and head revisions`
      )
    )
  }

  const readFile = (revision: string, filePath: string) =>
    runGhExpectingSuccess(
      worktreePath,
      [
        'api',
        '--header',
        'Accept: application/vnd.github.raw+json',
        `repos/${repoSlug}/contents/${filePath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(revision)}`,
      ],
      `gh api contents ${filePath}`
    ).pipe(
      Effect.flatMap((result) => {
        if (Buffer.byteLength(result.stdout, 'utf8') > DIFF_FILE_MAX_BYTES) {
          return Effect.fail(
            ghApiFailure(
              `The diff file '${filePath}' exceeds the 1 MB expansion limit`
            )
          )
        }
        if (result.stdout.includes('\0')) {
          return Effect.fail(
            ghApiFailure(`The diff file '${filePath}' is binary`)
          )
        }
        return Effect.succeed(result.stdout)
      })
    )

  const oldRevision = baseRef ?? ''
  const [oldContents, newContents] = yield* Effect.all(
    [
      input.changeType === 'new'
        ? Effect.succeed('')
        : readFile(oldRevision, input.oldPath),
      input.changeType === 'deleted'
        ? Effect.succeed('')
        : readFile(headRef, input.newPath),
    ],
    { concurrency: 2 }
  )
  const contents: PullRequestFileContents = { newContents, oldContents }
  return contents
})

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Post a conversation comment; the body travels over stdin. */
const commentOnPullRequest = Effect.fn('commentOnPullRequest')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  body: string
) {
  yield* guardWorktree(worktreePath)
  yield* runGhExpectingSuccess(
    worktreePath,
    ['pr', 'comment', String(prNumber), '--repo', repoSlug, '--body-file', '-'],
    `gh pr comment #${prNumber}`,
    { stdin: body }
  )
})

/**
 * Rewrite the pull request's own title and/or body through `gh pr edit`. A
 * field the caller did not name is left off the command, so GitHub keeps
 * the words that are there.
 */
const editPullRequest = Effect.fn('editPullRequest')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly body?: string | undefined
    readonly title?: string | undefined
  }
) {
  yield* guardWorktree(worktreePath)
  if (input.title === undefined && input.body === undefined) {
    return yield* Effect.fail(
      ghApiFailure('Nothing to edit: neither a title nor a body was given')
    )
  }
  yield* runGhExpectingSuccess(
    worktreePath,
    [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repoSlug,
      ...(input.title === undefined ? [] : ['--title', input.title]),
      ...(input.body === undefined ? [] : ['--body-file', '-']),
    ],
    `gh pr edit #${prNumber}`,
    input.body === undefined ? undefined : { stdin: input.body }
  )
})

/** Each action as its `gh pr` subcommand and flags. */
const actionArgs = (
  action: PullRequestActionKind,
  mergeMethod: PullRequestMergeMethod | undefined,
  updateMethod: PullRequestUpdateMethod | undefined
): { readonly flags: readonly string[]; readonly subcommand: string } => {
  switch (action) {
    case 'merge':
      return { flags: [`--${mergeMethod ?? 'merge'}`], subcommand: 'merge' }
    // `--auto` arms the same command instead of running it, and still needs
    // the strategy: GitHub stores it with the standing instruction.
    case 'enableAutoMerge':
      return {
        flags: ['--auto', `--${mergeMethod ?? 'merge'}`],
        subcommand: 'merge',
      }
    case 'disableAutoMerge':
      return { flags: ['--disable-auto'], subcommand: 'merge' }
    // `gh` updates with a merge commit unless asked to rebase, which is
    // GitHub's own default.
    case 'updateBranch':
      return {
        flags: updateMethod === 'rebase' ? ['--rebase'] : [],
        subcommand: 'update-branch',
      }
    case 'ready':
      return { flags: [], subcommand: 'ready' }
    case 'draft':
      return { flags: ['--undo'], subcommand: 'ready' }
    case 'close':
      return { flags: [], subcommand: 'close' }
    case 'reopen':
      return { flags: [], subcommand: 'reopen' }
    default:
      return action satisfies never
  }
}

/** Run one lifecycle action against the pull request. */
const runPullRequestAction = Effect.fn('runPullRequestAction')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly action: PullRequestActionKind
    readonly mergeMethod?: PullRequestMergeMethod | undefined
    readonly updateMethod?: PullRequestUpdateMethod | undefined
  }
) {
  yield* guardWorktree(worktreePath)
  const { flags, subcommand } = actionArgs(
    input.action,
    input.mergeMethod,
    input.updateMethod
  )
  yield* runGhExpectingSuccess(
    worktreePath,
    ['pr', subcommand, String(prNumber), '--repo', repoSlug, ...flags],
    `gh pr ${subcommand} #${prNumber}`
  )
})

const REVIEW_EVENTS: Record<
  PullRequestReviewVerdict,
  'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'
> = {
  approve: 'APPROVE',
  comment: 'COMMENT',
  requestChanges: 'REQUEST_CHANGES',
}

const gitHubReviewPosition = (
  position: PullRequestReviewCommentDraft['position']
): { readonly line: number; readonly side: 'LEFT' | 'RIGHT' } => {
  switch (position.kind) {
    case 'added':
      return { line: position.newLine, side: 'RIGHT' }
    case 'deleted':
      return { line: position.oldLine, side: 'LEFT' }
    case 'context':
      return position.side === 'left'
        ? { line: position.oldLine, side: 'LEFT' }
        : { line: position.newLine, side: 'RIGHT' }
    default:
      return position satisfies never
  }
}

/**
 * Submit a whole review as one REST request, so nothing is visible to
 * anyone else until the verdict is sent. The payload travels over stdin.
 */
const submitPullRequestReview = Effect.fn('submitPullRequestReview')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly body: string
    readonly comments: readonly PullRequestReviewCommentDraft[]
    readonly verdict: PullRequestReviewVerdict
  }
) {
  yield* guardWorktree(worktreePath)
  yield* runGhExpectingSuccess(
    worktreePath,
    [
      'api',
      '--method',
      'POST',
      `repos/${repoSlug}/pulls/${prNumber}/reviews`,
      '--input',
      '-',
    ],
    `gh api reviews #${prNumber}`,
    {
      stdin: JSON.stringify({
        body: input.body,
        comments: input.comments.map((comment) => ({
          body: comment.body,
          path: comment.path,
          ...gitHubReviewPosition(comment.position),
        })),
        event: REVIEW_EVENTS[input.verdict],
      }),
    }
  )
})

const REVIEW_THREAD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`

/** Reply to a review thread, named by its GraphQL node id. */
const replyToReviewThread = Effect.fn('replyToReviewThread')(function* (
  worktreePath: string,
  threadId: string,
  body: string
) {
  yield* guardWorktree(worktreePath)
  yield* runGraphql(
    worktreePath,
    REVIEW_THREAD_REPLY_MUTATION,
    { body, threadId },
    'gh api graphql replyToReviewThread'
  )
})

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`

const UNRESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`

/** Mark a review thread resolved, or unresolved again. */
const setReviewThreadResolution = Effect.fn('setReviewThreadResolution')(
  function* (worktreePath: string, threadId: string, resolved: boolean) {
    yield* guardWorktree(worktreePath)
    yield* runGraphql(
      worktreePath,
      resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
      { threadId },
      'gh api graphql setReviewThreadResolution'
    )
  }
)

const PULL_REQUEST_NODE_ID_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
}`

const GhNodeIdEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({ id: Schema.String }),
    }),
  }),
})

const ADD_REACTION_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`

const REMOVE_REACTION_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`

/**
 * Add a reaction to a remark, or take it back. An omitted subject reacts to
 * the pull request itself, whose node id is looked up here because nothing
 * in the conversation names it.
 */
const setPullRequestReaction = Effect.fn('setPullRequestReaction')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly content: PullRequestReactionContent
    readonly reacted: boolean
    readonly subjectId?: string | undefined
  }
) {
  yield* guardWorktree(worktreePath)

  let subjectId = input.subjectId
  if (subjectId === undefined) {
    const { owner, repo } = yield* splitRepoSlug(repoSlug)
    const label = `gh api graphql nodeId for #${prNumber}`
    const result = yield* runGhExpectingSuccess(
      worktreePath,
      [
        'api',
        'graphql',
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${prNumber}`,
        '-f',
        `query=${PULL_REQUEST_NODE_ID_QUERY}`,
      ],
      label
    )
    const envelope = yield* decodeJson(
      GhNodeIdEnvelope,
      result.stdout.trim(),
      label
    )
    subjectId = envelope.data.repository.pullRequest.id
  }

  yield* runGraphql(
    worktreePath,
    input.reacted ? ADD_REACTION_MUTATION : REMOVE_REACTION_MUTATION,
    { content: GITHUB_REACTION_BY_CONTENT[input.content], subjectId },
    'gh api graphql setReaction'
  )
})

/**
 * Who a review may be asked of, and who it already has been, in one read.
 *
 * `assignableUsers` is the list GitHub's own reviewer picker is built from
 * — everyone with access — rather than `collaborators`, which REST refuses
 * to anyone without push access. Teams appear only where one has already
 * been requested, so that request can be taken back.
 */
const REVIEWER_CANDIDATES_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    assignableUsers(first: 100) {
      pageInfo { hasNextPage }
      nodes { login name avatarUrl }
    }
    pullRequest(number: $number) {
      author { login }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Team { slug name avatarUrl }
            ... on Bot { login avatarUrl }
          }
        }
      }
    }
  }
}`

const GhReviewerCandidates = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      assignableUsers: Schema.Struct({
        nodes: Schema.Array(Schema.NullOr(GhActor)),
        pageInfo: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ hasNextPage: Schema.optional(Schema.Boolean) })
          )
        ),
      }),
      pullRequest: Schema.NullOr(
        Schema.Struct({
          author: Schema.optional(Schema.NullOr(GhActor)),
          reviewRequests: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    requestedReviewer: Schema.optional(
                      Schema.NullOr(GhRequestedReviewer)
                    ),
                  })
                ),
              })
            )
          ),
        })
      ),
    }),
  }),
})

/**
 * The people this pull request may be sent to, with whoever is already on
 * it marked. The author is dropped rather than shown as an unusable row:
 * GitHub refuses a review request from whoever opened the pull request.
 */
const fetchReviewerCandidates = Effect.fn('fetchReviewerCandidates')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number
) {
  yield* guardWorktree(worktreePath)
  const { owner, repo } = yield* splitRepoSlug(repoSlug)

  const label = `gh api graphql reviewerCandidates for #${prNumber}`
  const result = yield* runGhExpectingSuccess(
    worktreePath,
    [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
      '-F',
      `number=${prNumber}`,
      '-f',
      `query=${REVIEWER_CANDIDATES_QUERY}`,
    ],
    label
  )
  const envelope = yield* decodeJson(
    GhReviewerCandidates,
    result.stdout.trim(),
    label
  )

  const repository = envelope.data.repository
  const pullRequest = repository.pullRequest
  const author = trimmed(pullRequest?.author?.login)
  const candidates = new Map<string, PullRequestReviewerCandidate>()
  for (const node of pullRequest?.reviewRequests?.nodes ?? []) {
    const raw = node.requestedReviewer
    const slug = trimmed(raw?.slug)
    const id = slug ?? trimmed(raw?.login)
    if (id === null) {
      continue
    }
    const kind: PullRequestReviewerKind = slug === null ? 'user' : 'team'
    candidates.set(`${kind} ${id}`, {
      avatarUrl: trimmed(raw?.avatarUrl),
      id,
      isRequested: true,
      kind,
      login: id,
      name: trimmed(raw?.name),
    })
  }
  for (const node of repository.assignableUsers.nodes) {
    const login = trimmed(node?.login)
    if (login === null || login === author || candidates.has(`user ${login}`)) {
      continue
    }
    candidates.set(`user ${login}`, {
      avatarUrl: trimmed(node?.avatarUrl),
      id: login,
      isRequested: false,
      kind: 'user',
      login,
      name: trimmed(node?.name),
    })
  }
  const list: PullRequestReviewerCandidateList = {
    candidates: [...candidates.values()],
    truncated: repository.assignableUsers.pageInfo?.hasNextPage === true,
  }
  return list
})

/**
 * Ask somebody for a review, or take the request back: the same collection
 * posted to or deleted from, with the same body either way. Posting to a
 * login GitHub has already been asked about is what a re-request is.
 */
const setReviewerRequest = Effect.fn('setReviewerRequest')(function* (
  worktreePath: string,
  repoSlug: string,
  prNumber: number,
  input: {
    readonly requested: boolean
    readonly reviewers: readonly {
      readonly id: string
      readonly kind: PullRequestReviewerKind
    }[]
  }
) {
  yield* guardWorktree(worktreePath)
  yield* runGhExpectingSuccess(
    worktreePath,
    [
      'api',
      '--method',
      input.requested ? 'POST' : 'DELETE',
      `repos/${repoSlug}/pulls/${prNumber}/requested_reviewers`,
      '--input',
      '-',
    ],
    `gh api requested_reviewers #${prNumber}`,
    {
      stdin: JSON.stringify({
        reviewers: input.reviewers.flatMap((reviewer) =>
          reviewer.kind === 'user' ? [reviewer.id] : []
        ),
        team_reviewers: input.reviewers.flatMap((reviewer) =>
          reviewer.kind === 'team' ? [reviewer.id] : []
        ),
      }),
    }
  )
})

export {
  buildFilesPatch,
  commentOnPullRequest,
  editPullRequest,
  fetchPullRequestActivity,
  fetchPullRequestDetail,
  fetchPullRequestDiff,
  fetchPullRequestDiffFileContents,
  fetchReviewerCandidates,
  replyToReviewThread,
  runPullRequestAction,
  setPullRequestReaction,
  setReviewThreadResolution,
  setReviewerRequest,
  submitPullRequestReview,
}
