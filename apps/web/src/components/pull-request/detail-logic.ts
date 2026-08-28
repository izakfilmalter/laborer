/**
 * Pure logic behind the pull request panel, ported from t3code's
 * `pullRequestDetail.logic.ts`.
 *
 * Laborer adaptations: the flat conversation carries author fields inline
 * (`authorLogin` / `authorAvatarUrl`) rather than a nested actor, review
 * states are Laborer's camelCase literals, and everything t3 built for
 * composer/thread hand-offs (prompts, findings, checkout preparation) is
 * left out because Laborer has no counterpart surface.
 */
import type {
  PullRequestActivity,
  PullRequestActor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestReaction,
  PullRequestReviewState,
  PullRequestReviewThread,
  PullRequestState,
} from '@laborer/shared/rpc'

/**
 * The merged view the tabs render: the header-shaped detail plus the
 * conversation-shaped activity, with the activity's fuller reviewer roster
 * winning once it arrives.
 */
export interface PullRequestDetailView extends PullRequestDetail {
  readonly comments: readonly PullRequestComment[]
  readonly commits: readonly PullRequestCommit[]
  /** Reactions on the pull request's own description. */
  readonly descriptionReactions: readonly PullRequestReaction[]
  readonly reviewThreads: readonly PullRequestReviewThread[]
  readonly threadsTruncated: boolean
}

/** Merge the two reads into the one view every tab renders. */
export function mergePullRequestView(
  detail: PullRequestDetail,
  activity: PullRequestActivity | null
): PullRequestDetailView {
  return {
    ...detail,
    reviewers: activity?.reviewers ?? detail.reviewers,
    comments: activity?.comments ?? [],
    commits: activity?.commits ?? [],
    descriptionReactions: activity?.reactions ?? [],
    reviewThreads: activity?.reviewThreads ?? [],
    threadsTruncated: activity?.threadsTruncated ?? false,
  }
}

/** The flat conversation's inline author fields as one actor, or null for ghosts. */
export function commentActor(
  comment: Pick<PullRequestComment, 'authorLogin' | 'authorAvatarUrl'>
): PullRequestActor | null {
  if (comment.authorLogin.length === 0) {
    return null
  }
  return {
    avatarUrl: comment.authorAvatarUrl,
    login: comment.authorLogin,
    name: null,
  }
}

/** Activity changes only when the same pull request reports a newer revision. */
export function shouldRefreshPullRequestActivity(
  previous: { readonly key: string; readonly updatedAt: string } | null,
  next: { readonly key: string; readonly updatedAt: string }
): boolean {
  return (
    previous !== null &&
    previous.key === next.key &&
    previous.updatedAt !== next.updatedAt
  )
}

/** Plain-language state, shown beside the author. Conflicts are a merge signal, not a state. */
export function describePullRequestState(
  state: PullRequestState,
  isDraft: boolean
): string {
  if (state === 'merged') {
    return 'Merged'
  }
  if (state === 'closed') {
    return 'Closed'
  }
  return isDraft ? 'Draft' : 'Ready for review'
}

/** Chronological ascending, oldest to newest — reversed for the "newest" reading order. */
export function orderPullRequestComments<
  T extends { readonly createdAt: string },
>(comments: readonly T[], order: 'newest' | 'oldest'): readonly T[] {
  return order === 'newest' ? comments.toReversed() : comments
}

/** A review that says something about the change itself, rather than only carrying remarks. */
export type PullRequestReviewOutcome =
  | 'approved'
  | 'changes-requested'
  | 'dismissed'

/** Which review states are a verdict. `commented` and `pending` are not. */
export function pullRequestReviewOutcome(
  reviewState: PullRequestReviewState | null
): PullRequestReviewOutcome | null {
  switch (reviewState) {
    case 'approved':
      return 'approved'
    case 'changesRequested':
      return 'changes-requested'
    case 'dismissed':
      return 'dismissed'
    default:
      return null
  }
}

/**
 * An instant as a number, because the text is not the order. NaN for
 * anything unparseable, which every caller treats as "cannot say".
 */
function instant(iso: string): number {
  return Date.parse(iso)
}

/**
 * The newest commit on the branch, which is what a verdict is current
 * against. Null where there are no commits with a parseable timestamp.
 */
export function newestPullRequestCommitAt(
  commits: readonly PullRequestCommit[]
): string | null {
  let newest: string | null = null
  let newestAt = Number.NEGATIVE_INFINITY
  for (const commit of commits) {
    const at = instant(commit.committedDate)
    if (Number.isNaN(at) || at <= newestAt) {
      continue
    }
    newest = commit.committedDate
    newestAt = at
  }
  return newest
}

/**
 * Whether a verdict was given before the code it was given on, measured
 * against commit dates — a proxy that errs towards leaving a verdict alone.
 */
export function isPullRequestVerdictStale(
  at: string,
  newestCommitAt: string | null
): boolean {
  if (newestCommitAt === null) {
    return false
  }
  const verdictAt = instant(at)
  const commitAt = instant(newestCommitAt)
  return (
    !(Number.isNaN(verdictAt) || Number.isNaN(commitAt)) && verdictAt < commitAt
  )
}

export interface PullRequestReviewOutcomeEntry {
  readonly actor: PullRequestActor | null
  readonly at: string
  /** A login where GitHub reported one, otherwise the review's own id. */
  readonly key: string
  readonly outcome: PullRequestReviewOutcome
  /** Commits landed after this verdict, so it speaks for older code. */
  readonly stale: boolean
}

/**
 * Where each reviewer landed: one entry per person and only their last
 * word. A dismissal is a verdict taken back, so it leaves nothing to show.
 */
export function latestPullRequestReviewOutcomes(
  comments: readonly PullRequestComment[],
  commits: readonly PullRequestCommit[] = []
): readonly PullRequestReviewOutcomeEntry[] {
  const newestCommitAt = newestPullRequestCommitAt(commits)
  const latest = new Map<string, PullRequestReviewOutcomeEntry>()
  for (const comment of comments) {
    const outcome = pullRequestReviewOutcome(comment.reviewState)
    if (outcome === null) {
      continue
    }
    // Two deleted accounts are two reviewers; keying both as "ghost" would
    // let one overwrite the other.
    const login =
      comment.authorLogin.length > 0
        ? comment.authorLogin
        : `ghost:${comment.id}`
    const current = latest.get(login)
    if (
      current !== undefined &&
      instant(current.at) > instant(comment.createdAt)
    ) {
      continue
    }
    latest.set(login, {
      key: login,
      actor: commentActor(comment),
      outcome,
      at: comment.createdAt,
      stale: isPullRequestVerdictStale(comment.createdAt, newestCommitAt),
    })
  }
  return [...latest.values()].filter((entry) => entry.outcome !== 'dismissed')
}

export interface PullRequestTimelineEvent {
  readonly actor: PullRequestActor | null
  readonly additions: number | null
  readonly at: string
  readonly body: string | null
  /** Every author attributed by GitHub; the first is the timeline marker. */
  readonly commitAuthors: readonly PullRequestActor[]
  readonly deletions: number | null
  readonly id: string
  readonly kind:
    | 'opened'
    | 'commit'
    | 'comment'
    | 'review'
    | 'merged'
    | 'closed'
  /** Whether `body` is markdown. A commit headline is plain text. */
  readonly markdown: boolean
  readonly path: string | null
  /** GraphQL node id `pullRequest.setReaction` addresses, when known. */
  readonly reactionSubjectId: string | null
  /** Empty for everything but a comment. */
  readonly reactions: readonly PullRequestReaction[]
  readonly reviewState: PullRequestReviewState | null
  readonly title: string
  /** Where the entry can be read on GitHub, or null for synthetic events. */
  readonly url: string | null
}

export type PullRequestTimelineRow =
  | { readonly kind: 'event'; readonly event: PullRequestTimelineEvent }
  | {
      readonly kind: 'comments'
      readonly events: readonly PullRequestTimelineEvent[]
    }

/**
 * Consecutive comments are one conversation section. Commits, lifecycle
 * updates and verdicts stay first-class rows and split those sections.
 */
export function groupPullRequestTimelineConversations(
  events: readonly PullRequestTimelineEvent[]
): readonly PullRequestTimelineRow[] {
  const rows: PullRequestTimelineRow[] = []
  for (const event of events) {
    if (
      (event.kind === 'comment' || event.kind === 'review') &&
      pullRequestReviewOutcome(event.reviewState) === null
    ) {
      const last = rows.at(-1)
      if (last?.kind === 'comments') {
        rows[rows.length - 1] = {
          kind: 'comments',
          events: [...last.events, event],
        }
      } else {
        rows.push({ kind: 'comments', events: [event] })
      }
    } else {
      rows.push({ kind: 'event', event })
    }
  }
  return rows
}

/**
 * Review bots keep their bookkeeping in HTML comments, which the markdown
 * renderer drops. A body that is nothing but a marker is treated as no
 * body at all; the body itself is passed on whole.
 */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, '').trim().length === 0
    ? null
    : body.trim()
}

/**
 * Flattens creation, commits, comments/reviews, and the terminal event
 * into one list, newest first. Merged wins over closed: GitHub sets both
 * timestamps on a merge.
 */
export function buildPullRequestTimeline(
  detail: Pick<
    PullRequestDetailView,
    'createdAt' | 'author' | 'commits' | 'comments' | 'mergedAt' | 'closedAt'
  >
): readonly PullRequestTimelineEvent[] {
  return [
    {
      id: 'created',
      at: detail.createdAt,
      kind: 'opened' as const,
      title: 'opened this pull request',
      body: null,
      markdown: false,
      url: null,
      actor: detail.author,
      commitAuthors: [],
      additions: null,
      deletions: null,
      path: null,
      reviewState: null,
      reactions: [],
      reactionSubjectId: null,
    },
    ...detail.commits.map((commit) => ({
      id: commit.oid,
      at: commit.committedDate,
      kind: 'commit' as const,
      title: `Commit ${commit.oid.slice(0, 7)}`,
      body: commit.messageHeadline || null,
      markdown: false,
      url: null,
      actor: commit.authors[0] ?? null,
      commitAuthors: commit.authors,
      additions: commit.additions,
      deletions: commit.deletions,
      path: null,
      reviewState: null,
      reactions: [],
      reactionSubjectId: null,
    })),
    ...detail.comments.map((comment) => ({
      id: `${comment.kind}-${comment.id}`,
      at: comment.createdAt,
      kind:
        comment.kind === 'review' ? ('review' as const) : ('comment' as const),
      title: comment.kind === 'review' ? 'reviewed' : 'commented',
      body: visibleBody(comment.body),
      markdown: true,
      url: comment.url,
      actor: commentActor(comment),
      commitAuthors: [],
      additions: null,
      deletions: null,
      path: comment.filePath,
      reviewState: comment.reviewState,
      reactions: comment.reactions ?? [],
      reactionSubjectId: comment.nodeId ?? null,
    })),
    ...(detail.mergedAt
      ? [
          {
            id: 'merged',
            at: detail.mergedAt,
            kind: 'merged' as const,
            title: 'Pull request merged',
            body: null,
            markdown: false,
            url: null,
            actor: null,
            commitAuthors: [],
            additions: null,
            deletions: null,
            path: null,
            reviewState: null,
            reactions: [],
            reactionSubjectId: null,
          },
        ]
      : []),
    ...(detail.closedAt && !detail.mergedAt
      ? [
          {
            id: 'closed',
            at: detail.closedAt,
            kind: 'closed' as const,
            title: 'Pull request closed',
            body: null,
            markdown: false,
            url: null,
            actor: null,
            commitAuthors: [],
            additions: null,
            deletions: null,
            path: null,
            reviewState: null,
            reactions: [],
            reactionSubjectId: null,
          },
        ]
      : []),
  ].toSorted((left, right) => right.at.localeCompare(left.at))
}

/**
 * Whether the title and description can be rewritten from here: the reader
 * wrote the change, or their role on the repository can push.
 */
export function canEditPullRequest(
  detail: Pick<PullRequestDetail, 'author' | 'viewer' | 'viewerCanWrite'>
): boolean {
  const viewer = detail.viewer?.trim().toLowerCase() ?? null
  const author = detail.author?.login.trim().toLowerCase() ?? null
  return (
    detail.viewerCanWrite ||
    (viewer !== null && author !== null && viewer === author)
  )
}

/** The internal wrapper a failed `gh` operation arrives in. */
const OPERATION_PREFIX = /^Pull request operation \w+ failed:\s*/iu

/** Sentences that report only that a tool exited: true, and no help at all. */
const TOOL_NOISE = [
  /^(github|gitlab|bitbucket|azure devops)?\s*(cli|api)?\s*(command\s*)?failed\.?$/iu,
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
]

/** How much of the host's own message a toast can carry before it stops being read. */
const FAILURE_DETAIL_MAX_LENGTH = 320

/**
 * What to put under a failed action: the host's own sentence when it said
 * something, otherwise what to go and check.
 */
function failureMessage(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message
  }
  if (typeof failure === 'string') {
    return failure
  }
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'message' in failure &&
    typeof (failure as { message: unknown }).message === 'string'
  ) {
    return (failure as { message: string }).message
  }
  return ''
}

export function readableFailure(failure: unknown, hint: string): string {
  const detail = failureMessage(failure).replace(OPERATION_PREFIX, '').trim()
  if (
    detail.length === 0 ||
    TOOL_NOISE.some((pattern) => pattern.test(detail))
  ) {
    return hint
  }
  return detail.length <= FAILURE_DETAIL_MAX_LENGTH
    ? detail
    : `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`
}
