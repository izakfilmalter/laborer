// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the tab is t3code's, ported whole; splitting it would diverge from the source it mirrors.
/**
 * The pull request summary: reviewers, labels, checks, description, and
 * the recent end of the conversation. Ported from t3code's
 * `PullRequestSummaryTab.tsx`.
 *
 * Laborer adaptations: posted remarks cannot be rewritten (Laborer has no
 * comment-edit RPC), so the pencil only appears on the description; the
 * finding hand-off buttons are gone (no agent composer to hand to); and a
 * remark reacts through its GraphQL node id, so entries without one hide
 * the affordance.
 */
import { useAtomSet } from '@effect/atom-react/Hooks'
import type { PullRequestActor, PullRequestComment } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@laborer/ui/components/collapsible'
import { Textarea } from '@laborer/ui/components/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pencil,
  Send,
  Tag,
  Users,
} from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  canEditPullRequest,
  commentActor,
  latestPullRequestReviewOutcomes,
  orderPullRequestComments,
  type PullRequestDetailView,
  pullRequestReviewOutcome,
  visibleBody,
} from './detail-logic'
import { openExternally } from './external-links'
import { PullRequestConversationGhost } from './ghosts'
import { PullRequestMarkdown } from './markdown'
import { PullRequestMarkdownEditor } from './markdown-editor'
import {
  PullRequestActorAvatar,
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  PullRequestReviewOutcomeBadge,
  pullRequestCheckStatusLabel,
  pullRequestReviewOutcomeLabel,
  pullRequestReviewOutcomeRingClassName,
  pullRequestReviewOutcomeStaleLabel,
} from './presentation'
import { pullRequestCommentMutation, pullRequestEditMutation } from './queries'
import { PullRequestReactionBar } from './reactions'
import { formatRelativeTime } from './relative-time'
import { PullRequestReviewerPicker } from './reviewer-picker'
import { sectionCollapseAnchorScrollTop } from './summary-scroll-logic'
import { PullRequestActivityUnavailableState } from './unavailable-states'

/** One reviewer, however GitHub happens to have cased their login this time. */
function reviewerKey(login: string): string {
  return login.toLowerCase()
}

const LEADING_HASH = /^#/
const HEX_COLOR = /^[0-9a-fA-F]{6}$/

/** A host colour only when it is one, so a malformed value falls back to the dot. */
function labelDotColor(color: string | null): string | null {
  const hex = color?.trim().replace(LEADING_HASH, '') ?? ''
  return HEX_COLOR.test(hex) ? `#${hex}` : null
}

/** The avatar carries the attribution alone; who it is arrives on hover. */
function CommentAuthor({ actor }: { actor: PullRequestActor | null }) {
  const login = actor?.login ?? 'ghost'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={login}
            className="shrink-0 rounded-full"
            role="img"
          />
        }
      >
        <PullRequestActorAvatar actor={actor} />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {actor?.name && actor.name !== login
          ? `${actor.name} (@${login})`
          : login}
      </TooltipContent>
    </Tooltip>
  )
}

const CAMEL_BOUNDARY = /([A-Z])/g

/** "changesRequested" reads as "Changes requested". */
function reviewStateLabel(state: string): string {
  const words = state.replace(CAMEL_BOUNDARY, ' $1').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Finished work — a resolved conversation or a dismissed approval — opens collapsed. */
function CollapsedComment({
  comment,
  baseHref,
  label,
  body,
  reactionBar,
  now,
}: {
  comment: PullRequestComment
  baseHref: string | null
  label: string
  /** Null where the remark is nothing but its verdict. */
  body: string | null
  reactionBar: ReactNode
  now: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <article className="group rounded-lg border border-border/60 [contain-intrinsic-block-size:44px] [content-visibility:auto]">
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 p-3 text-left transition-opacity hover:opacity-100',
            open ? 'opacity-100' : 'opacity-65'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-xs">
            <CommentAuthor actor={commentActor(comment)} />
            <span>{formatRelativeTime(comment.createdAt, now)}</span>
            <span>{label}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {open ? (
            <div className="px-3 pb-3">
              {comment.filePath ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <p className="truncate text-muted-foreground text-xs">
                        {comment.filePath}
                      </p>
                    }
                  />
                  <TooltipContent side="top">{comment.filePath}</TooltipContent>
                </Tooltip>
              ) : null}
              {/* A dismissal carries no more words than an approval does. */}
              {body === null ? null : (
                <PullRequestMarkdown
                  baseHref={baseHref}
                  className="mt-2"
                  text={comment.body}
                />
              )}
              {reactionBar}
            </div>
          ) : null}
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  )
}

function Section({
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  /** Controls riding on the heading row itself — a sibling of the trigger. */
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const headingRef = useRef<HTMLDivElement>(null)
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current
      const section = heading?.closest<HTMLElement>(
        '[data-pull-request-summary-section]'
      )
      const scroller = heading?.closest<HTMLElement>(
        '[data-pull-request-summary-scroll]'
      )
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        })
        // Synchronous with the press: the reader sees the heading they
        // pressed stay put rather than a jump first.
        if (target !== null) {
          scroller.scrollTop = target
        }
      }
    }
    setOpen(nextOpen)
  }
  return (
    <Collapsible
      data-pull-request-summary-section
      onOpenChange={setOpenWithScrollAnchor}
      open={open}
    >
      {/* The heading rides the top of the scroll box the way a diff's file
          header does. Opaque, because the rows it covers scroll beneath it. */}
      <div
        className="sticky top-0 z-10 flex w-full items-center border-border/60 border-t bg-background pr-4"
        ref={headingRef}
      >
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left font-medium text-sm">
          <span>{title}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          {count === undefined ? null : (
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          )}
        </CollapsibleTrigger>
        {open ? actions : null}
      </div>
      <CollapsibleContent>
        <div className="px-4 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CommentComposer({
  workspaceId,
  onCommented,
}: {
  workspaceId: string
  onCommented: () => void
}) {
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const postComment = useAtomSet(pullRequestCommentMutation, {
    mode: 'promise',
  })

  const submit = async () => {
    const trimmed = body.trim()
    if (trimmed.length === 0 || posting) {
      return
    }
    setPosting(true)
    try {
      await postComment({ payload: { workspaceId, body: trimmed } })
    } catch {
      setPosting(false)
      toast.error('Could not post the comment')
      return
    }
    setPosting(false)
    setBody('')
    onCommented()
  }

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        aria-label="Comment on this pull request"
        // Locked while posting: the body is cleared on success, which would
        // otherwise throw away a new draft typed in flight.
        disabled={posting}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Leave a comment"
        rows={3}
        value={body}
      />
      <div className="flex justify-end">
        <Button
          disabled={body.trim().length === 0 || posting}
          onClick={() => submit()}
          size="xs"
          variant="outline"
        >
          <Send className="size-3.5" />
          {posting ? 'Posting...' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}

/**
 * What a first render of the conversation carries. A pull request with two
 * hundred comments is two hundred markdown documents.
 */
const COMMENT_PAGE = 30

export function PullRequestSummaryTab({
  workspaceId,
  detail,
  activityPending,
  activityError,
  now,
  onRefresh,
}: {
  workspaceId: string
  detail: PullRequestDetailView
  activityPending: boolean
  activityError: string | null
  /** Rendering clock, so every entry in one pass agrees on "now". */
  now: number
  onRefresh: () => void
}) {
  // Keyed by the pull request, so opening another one starts at the end of
  // its conversation.
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE })
  const shownComments = shown.url === detail.url ? shown.count : COMMENT_PAGE
  // Windowed by recency regardless of display order.
  const recentComments = detail.comments.slice(
    Math.max(0, detail.comments.length - shownComments)
  )
  const hiddenCommentCount = detail.comments.length - recentComments.length
  const [commentOrder, setCommentOrder] = useState<'newest' | 'oldest'>(
    'newest'
  )
  const visibleComments = orderPullRequestComments(recentComments, commentOrder)
  // Read from the whole conversation, not the window shown below it.
  const reviewOutcomes = latestPullRequestReviewOutcomes(
    detail.comments,
    detail.commits
  )
  const outcomeByLogin = new Map(
    reviewOutcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : []
    )
  )
  // The people a review was asked of, then anyone who ruled without being
  // on that list: GitHub drops a reviewer from the requested set once they
  // have reviewed, and their verdict is what this row exists to show.
  const reviewerEntries = [
    ...detail.reviewers.map((actor) => ({
      key: actor.login,
      actor,
      outcome: outcomeByLogin.get(reviewerKey(actor.login))?.outcome ?? null,
      stale: outcomeByLogin.get(reviewerKey(actor.login))?.stale ?? false,
    })),
    ...reviewOutcomes
      .filter(
        (entry) =>
          !detail.reviewers.some(
            (actor) =>
              entry.actor !== null &&
              reviewerKey(actor.login) === reviewerKey(entry.actor.login)
          )
      )
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome: entry.outcome,
        stale: entry.stale,
      })),
  ]

  // A comment that already lives on a review thread is that thread: the
  // thread carries the resolution state the bare comment has lost.
  const threadByCommentId = new Map(
    detail.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment) => [comment.id, thread] as const)
    )
  )
  /** Review-thread membership is matched by node id where the flat entry has one. */
  const threadOfComment = (comment: PullRequestComment) =>
    comment.nodeId === undefined
      ? undefined
      : threadByCommentId.get(comment.nodeId)

  const openCheck = (url: string) => {
    openExternally(url)
  }

  const edit = useAtomSet(pullRequestEditMutation, { mode: 'promise' })
  // Keyed by the pull request, like the comment window above it, so an
  // editor left open never reappears over the next pull request's body.
  const [bodyScope, setBodyScope] = useState<string | null>(null)
  const [bodySaving, setBodySaving] = useState(false)

  const saveBody = async (body: string) => {
    if (bodySaving) {
      return
    }
    setBodySaving(true)
    try {
      await edit({ payload: { workspaceId, body } })
    } catch {
      setBodySaving(false)
      toast.error('Could not save the description')
      return
    }
    setBodySaving(false)
    setBodyScope(null)
    onRefresh()
  }

  return (
    <div className="h-full overflow-y-auto" data-pull-request-summary-scroll>
      <section className="px-4 py-3">
        <div>
          <MetaRow icon={<Users className="size-3.5" />} label="Reviewers">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {reviewerEntries.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex items-center -space-x-1">
                  {reviewerEntries.map((entry) => {
                    const login = entry.actor?.login ?? 'ghost'
                    const named =
                      entry.actor?.name && entry.actor.name !== login
                        ? `${entry.actor.name} (@${login})`
                        : login
                    return (
                      <Tooltip key={entry.key}>
                        {/* A verdict rides the face that earned it rather
                            than a row of its own: the ring sits outside the
                            one that separates overlapping avatars. */}
                        <TooltipTrigger
                          render={
                            <span
                              className={cn(
                                'relative rounded-full hover:z-10',
                                entry.outcome
                                  ? pullRequestReviewOutcomeRingClassName(
                                      entry.outcome,
                                      entry.stale
                                    )
                                  : undefined
                              )}
                            />
                          }
                        >
                          <PullRequestActorLabel
                            actor={entry.actor}
                            className={cn(
                              'gap-0 [&>span:last-child]:sr-only',
                              entry.outcome
                                ? undefined
                                : '[&>img]:ring-2 [&>img]:ring-background [&>span:first-child]:ring-2 [&>span:first-child]:ring-background'
                            )}
                            tooltip={false}
                          />
                          {entry.outcome ? (
                            <span className="sr-only">
                              {entry.stale
                                ? pullRequestReviewOutcomeStaleLabel(
                                    entry.outcome
                                  )
                                : pullRequestReviewOutcomeLabel(entry.outcome)}
                            </span>
                          ) : null}
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {entry.outcome
                            ? `${named} — ${
                                entry.stale
                                  ? pullRequestReviewOutcomeStaleLabel(
                                      entry.outcome
                                    )
                                  : pullRequestReviewOutcomeLabel(entry.outcome)
                              }`
                            : named}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </span>
              )}
              <PullRequestReviewerPicker
                allowed={detail.viewerCanWrite}
                onRequested={onRefresh}
                workspaceId={workspaceId}
              />
            </span>
          </MetaRow>
          {detail.labels.length > 0 ? (
            <MetaRow icon={<Tag className="size-3.5" />} label="Labels">
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {detail.labels.map((label) => {
                  const dot = labelDotColor(label.color)
                  return (
                    <span
                      className="inline-flex max-w-48 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 py-0.5 pr-2 pl-1.5 text-xs"
                      key={label.name}
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full bg-muted-foreground"
                        {...(dot ? { style: { backgroundColor: dot } } : {})}
                      />
                      <span className="truncate">{label.name}</span>
                    </span>
                  )
                })}
              </span>
            </MetaRow>
          ) : null}
          <MetaRow
            icon={<MessageSquare className="size-3.5" />}
            label="Comments"
          >
            {activityPending
              ? 'Loading conversation…'
              : activityError
                ? 'Conversation unavailable'
                : detail.comments.length === 1
                  ? '1 comment'
                  : `${detail.comments.length} comments`}
          </MetaRow>
        </div>
      </section>

      <Section title="Description">
        <div className="group">
          {bodyScope === detail.url ? (
            <PullRequestMarkdownEditor
              // Empty is a real answer here: saving nothing clears it.
              allowEmpty
              baseHref={detail.url}
              label="Pull request description"
              onCancel={() => setBodyScope(null)}
              onSave={(body) => saveBody(body)}
              placeholder="Describe this pull request"
              saving={bodySaving}
              value={detail.body}
            />
          ) : (
            <div className="flex items-start gap-1">
              <PullRequestMarkdown
                baseHref={detail.url}
                className="min-w-0 flex-1"
                text={
                  detail.body.trim().length > 0
                    ? detail.body
                    : '_No description provided._'
                }
              />
              {canEditPullRequest(detail) ? (
                <Button
                  aria-label="Edit description"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => setBodyScope(detail.url)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Pencil className="size-3" />
                </Button>
              ) : null}
            </div>
          )}
          <PullRequestReactionBar
            canReact={true}
            className="mt-2"
            onRefresh={onRefresh}
            reactions={detail.descriptionReactions}
            workspaceId={workspaceId}
          />
        </div>
      </Section>

      <Section count={detail.checks.length} title="Checks">
        {detail.checks.length === 0 ? (
          <p className="text-muted-foreground text-xs">No checks reported.</p>
        ) : (
          <div className="space-y-0.5">
            {detail.checks.map((check, index) => (
              <div
                className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60"
                // Position too: GitHub decides how many runs share a name.
                key={`${index}:${check.name}:${check.url ?? ''}`}
              >
                <button
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                    check.url ? undefined : 'cursor-default'
                  )}
                  disabled={!check.url}
                  onClick={() => check.url && openCheck(check.url)}
                  type="button"
                >
                  <PullRequestCheckStatusIcon status={check.status} />
                  <span className="min-w-0 flex-1 truncate">{check.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {pullRequestCheckStatusLabel(check.status)}
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Comments"
        {...(activityPending || activityError
          ? {}
          : { count: detail.comments.length })}
        actions={
          !(activityPending || activityError) && detail.comments.length > 0 ? (
            <Button
              aria-label={
                commentOrder === 'newest'
                  ? 'Show oldest comments first'
                  : 'Show newest comments first'
              }
              className="h-7 shrink-0 px-2 text-[10px] text-muted-foreground"
              onClick={() =>
                setCommentOrder((value) =>
                  value === 'newest' ? 'oldest' : 'newest'
                )
              }
              size="xs"
              variant="ghost"
            >
              <ArrowDownUp aria-hidden className="size-3" />
              {commentOrder === 'newest' ? 'Newest first' : 'Oldest first'}
            </Button>
          ) : null
        }
      >
        {activityPending ? (
          <PullRequestConversationGhost />
        ) : activityError ? (
          <PullRequestActivityUnavailableState
            compact
            error={activityError}
            onRetry={onRefresh}
          />
        ) : (
          <>
            {detail.threadsTruncated ? (
              <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                This conversation is longer than this panel reads in one go. The
                most recent {detail.comments.length} are here; open it on GitHub
                to read the rest.
              </p>
            ) : null}
            {detail.comments.length === 0 ? (
              <p className="py-2 text-muted-foreground text-xs">
                No comments yet.
              </p>
            ) : (
              <div className="space-y-3">
                {hiddenCommentCount > 0 ? (
                  // Hundreds of comments are hundreds of markdown renders,
                  // and the ones worth arriving for are the recent ones.
                  <Button
                    className="w-full"
                    onClick={() =>
                      setShown({
                        url: detail.url,
                        count: shownComments + COMMENT_PAGE,
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    Show {Math.min(hiddenCommentCount, COMMENT_PAGE)} earlier{' '}
                    {hiddenCommentCount === 1 ? 'comment' : 'comments'}
                  </Button>
                ) : null}
                {visibleComments.map((comment) => {
                  const thread = threadOfComment(comment)
                  const body = visibleBody(comment.body)
                  const outcome = pullRequestReviewOutcome(comment.reviewState)
                  const reactionBar = (
                    <PullRequestReactionBar
                      canReact={comment.nodeId !== undefined}
                      onRefresh={onRefresh}
                      reactions={comment.reactions ?? []}
                      workspaceId={workspaceId}
                      {...(comment.nodeId === undefined
                        ? {}
                        : { subjectId: comment.nodeId })}
                      {...(body === null ? {} : { className: 'mt-2' })}
                    />
                  )
                  if (thread?.isResolved || outcome === 'dismissed') {
                    return (
                      <CollapsedComment
                        baseHref={detail.url}
                        body={body}
                        comment={comment}
                        key={`${comment.kind}-${comment.id}`}
                        label={
                          thread?.isResolved ? 'Resolved' : 'Approval dismissed'
                        }
                        now={now}
                        reactionBar={reactionBar}
                      />
                    )
                  }
                  return (
                    <article
                      className="group rounded-lg border border-border/60 p-3 [contain-intrinsic-block-size:120px] [content-visibility:auto]"
                      key={`${comment.kind}-${comment.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-xs">
                          <CommentAuthor actor={commentActor(comment)} />
                          <span>
                            {formatRelativeTime(comment.createdAt, now)}
                          </span>
                          {outcome ? (
                            <PullRequestReviewOutcomeBadge outcome={outcome} />
                          ) : comment.reviewState ? (
                            <span>{reviewStateLabel(comment.reviewState)}</span>
                          ) : null}
                          {body === null ? reactionBar : null}
                        </span>
                      </div>
                      {comment.filePath ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <p className="mt-1 truncate text-muted-foreground text-xs">
                                {comment.filePath}
                              </p>
                            }
                          />
                          <TooltipContent side="top">
                            {comment.filePath}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {/* A verdict usually carries no words; the badge above
                          already said it. */}
                      {body === null ? null : (
                        <PullRequestMarkdown
                          baseHref={detail.url}
                          className="mt-2"
                          text={comment.body}
                        />
                      )}
                      {body === null ? null : reactionBar}
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
        {/* Posting is a core capability and remains usable even if the
            activity read failed. */}
        <CommentComposer
          key={`${workspaceId}#${detail.number}`}
          onCommented={onRefresh}
          workspaceId={workspaceId}
        />
      </Section>
    </div>
  )
}
