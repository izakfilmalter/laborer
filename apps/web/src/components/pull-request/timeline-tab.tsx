// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
/**
 * The pull request's whole history on one rail: comments, reviews,
 * commits and lifecycle events. Ported from t3code's
 * `PullRequestTimelineTab.tsx`.
 *
 * Laborer adaptations: remarks cannot be rewritten (no comment-edit RPC),
 * so the pencil and editor are gone, and a remark reacts through its
 * GraphQL node id — entries without one hide the affordance.
 */
import type { PullRequestActor } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@laborer/ui/components/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  ChevronDown,
  ExternalLink,
  FileCode2,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  isPullRequestVerdictStale,
  newestPullRequestCommitAt,
  type PullRequestDetailView,
  type PullRequestReviewOutcome,
  type PullRequestTimelineEvent,
  pullRequestReviewOutcome,
} from './detail-logic'
import { openExternally } from './external-links'
import { PullRequestMarkdown } from './markdown'
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeLabel,
  pullRequestReviewOutcomeStaleLabel,
  pullRequestReviewOutcomeToneClassName,
} from './presentation'
import { PullRequestReactionBar } from './reactions'
import { formatRelativeTime } from './relative-time'

/** What every comment on the timeline needs to react. */
interface ReactionSurface {
  readonly onRefresh: () => void
  readonly workspaceId: string
}

function TimelineBody({
  body,
  markdown,
  baseHref,
}: {
  body: string
  markdown: boolean
  baseHref: string | null
}) {
  return (
    <div className="mt-3">
      {markdown ? (
        <PullRequestMarkdown baseHref={baseHref} text={body} />
      ) : (
        <p className="whitespace-pre-wrap text-muted-foreground text-xs">
          {body}
        </p>
      )}
    </div>
  )
}

function ActorName({ actor }: { actor: PullRequestActor | null }) {
  return (
    <span className="font-semibold text-foreground">
      {actor?.login ?? 'ghost'}
    </span>
  )
}

function TimelineMarker({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <span
      className={cn(
        'absolute top-1/2 left-0 z-10 flex size-8 -translate-y-1/2 items-center justify-center bg-background',
        className
      )}
    >
      {children}
    </span>
  )
}

function IconMarker({
  icon,
  className,
}: {
  icon: ReactNode
  className?: string | undefined
}) {
  return (
    <TimelineMarker className={className}>
      <span className="flex size-7 items-center justify-center bg-background text-muted-foreground">
        {icon}
      </span>
    </TimelineMarker>
  )
}

function ActorTimelineMarker({
  actors,
  className,
  fallback,
  muted = false,
}: {
  actors: readonly PullRequestActor[]
  className?: string | undefined
  fallback: ReactNode
  muted?: boolean
}) {
  const actor = actors[0]
  return actor === undefined ? (
    <IconMarker className={className} icon={fallback} />
  ) : (
    <TimelineMarker className={className}>
      <PullRequestActorAvatar
        actor={actor}
        className={cn(
          'size-7 bg-muted text-[9px] transition-opacity',
          muted && 'opacity-45 grayscale'
        )}
      />
    </TimelineMarker>
  )
}

const CAMEL_BOUNDARY = /([A-Z])/g
const FIRST_LETTER = /^\w/u

function friendlyReviewState(value: string): string {
  const words = value.replace(CAMEL_BOUNDARY, ' $1').toLowerCase()
  return words.replace(FIRST_LETTER, (letter) => letter.toUpperCase())
}

function ReviewStateBadge({ state }: { state: string }) {
  return (
    <span className="font-medium text-[10px] text-muted-foreground">
      {friendlyReviewState(state)}
    </span>
  )
}

function OpenOnHostButton({
  url,
  onOpen,
}: {
  url: string | null
  onOpen: (url: string) => void
}) {
  return url === null ? null : (
    <Button
      aria-label="Open activity on GitHub"
      className="-mt-1 -mr-1 shrink-0 text-muted-foreground"
      onClick={() => onOpen(url)}
      size="icon-xs"
      variant="ghost"
    >
      <ExternalLink className="size-3" />
    </Button>
  )
}

function ConversationCard({
  event,
  baseHref,
  onOpen,
  reactions,
  now,
}: {
  event: PullRequestTimelineEvent
  baseHref: string | null
  onOpen: (url: string) => void
  reactions: ReactionSurface
  now: number
}) {
  const canReact = event.reactionSubjectId !== null
  return (
    <article className="group py-2">
      <div className="px-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
              <ActorName actor={event.actor} />
              <span className="text-muted-foreground">{event.title}</span>
              {event.reviewState ? (
                <ReviewStateBadge state={event.reviewState} />
              ) : null}
            </div>
            <PullRequestMetaLine className="mt-1 flex-wrap text-[11px] text-muted-foreground">
              <span>{formatRelativeTime(event.at, now)}</span>
              {event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2 aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
          </div>
          <OpenOnHostButton onOpen={onOpen} url={event.url} />
        </div>
      </div>
      {event.body ? (
        <div className="px-2 pb-2">
          <TimelineBody
            baseHref={baseHref}
            body={event.body}
            markdown={event.markdown}
          />
        </div>
      ) : null}
      {canReact || event.reactions.length > 0 ? (
        <div className="px-2 pb-2">
          <PullRequestReactionBar
            canReact={canReact}
            onRefresh={reactions.onRefresh}
            reactions={event.reactions}
            workspaceId={reactions.workspaceId}
            {...(event.reactionSubjectId === null
              ? {}
              : { subjectId: event.reactionSubjectId })}
          />
        </div>
      ) : null}
    </article>
  )
}

function uniqueConversationActors(events: readonly PullRequestTimelineEvent[]) {
  const actors = new Map<string, PullRequestActor>()
  for (const event of events) {
    const actor = event.actor
    if (actor !== null && !actors.has(actor.login)) {
      actors.set(actor.login, actor)
    }
  }
  return [...actors.values()]
}

function ConversationGroup({
  events,
  baseHref,
  onOpen,
  reactions,
  now,
}: {
  events: readonly PullRequestTimelineEvent[]
  baseHref: string | null
  onOpen: (url: string) => void
  reactions: ReactionSurface
  now: number
}) {
  const [open, setOpen] = useState(false)
  const actors = uniqueConversationActors(events)
  const first = events[0]
  if (first === undefined) {
    return null
  }

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={actors}
        className="top-6"
        fallback={<MessageSquare className="size-3.5" />}
        muted={!open}
      />
      <Collapsible onOpenChange={setOpen} open={open}>
        <div>
          <CollapsibleTrigger
            className={cn(
              'flex w-full min-w-0 items-center gap-3 py-2 text-left transition-opacity hover:opacity-100',
              open
                ? 'text-foreground opacity-100'
                : 'text-muted-foreground opacity-55'
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-xs">
                {events.length.toLocaleString()}{' '}
                {events.length === 1 ? 'comment' : 'comments'}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {actors.length.toLocaleString()}{' '}
                {actors.length === 1 ? 'author' : 'authors'} ·{' '}
                {formatRelativeTime(first.at, now)}
              </span>
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
              <div className="mt-1 space-y-1">
                {events.map((event) => (
                  <ConversationCard
                    baseHref={baseHref}
                    event={event}
                    key={`${reactions.workspaceId}:${event.id}`}
                    now={now}
                    onOpen={onOpen}
                    reactions={reactions}
                  />
                ))}
              </div>
            ) : null}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}

function CommitEvent({
  event,
  onOpen,
  now,
}: {
  event: PullRequestTimelineEvent
  onOpen: (oid: string) => void
  now: number
}) {
  return (
    <button
      aria-label={`View commit ${event.id}`}
      className="group relative mb-5 block w-full rounded-sm pl-12 text-left outline-none [contain-intrinsic-block-size:48px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(event.id)}
      type="button"
    >
      <ActorTimelineMarker
        actors={event.commitAuthors}
        fallback={<GitCommitHorizontal className="size-3.5" />}
      />
      <div className="flex min-w-0 items-center gap-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-foreground text-xs transition-colors group-hover:text-primary">
            {event.body ?? 'Untitled commit'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <code className="font-mono">{event.id.slice(0, 7)}</code>
            <span>{formatRelativeTime(event.at, now)}</span>
          </div>
        </div>
        {event.additions !== null && event.deletions !== null ? (
          <PullRequestDiffStat
            additions={event.additions}
            className="ml-auto shrink-0 font-mono text-[10px]"
            deletions={event.deletions}
          />
        ) : null}
      </div>
    </button>
  )
}

function LifecycleEvent({
  event,
  now,
}: {
  event: PullRequestTimelineEvent
  now: number
}) {
  const presentation =
    event.kind === 'opened'
      ? {
          icon: <GitPullRequest className="size-3.5" />,
          label: 'Pull request opened',
        }
      : event.kind === 'merged'
        ? {
            icon: <GitMerge className="size-3.5" />,
            label: 'Pull request merged',
          }
        : {
            icon: <GitPullRequestClosed className="size-3.5" />,
            label: 'Pull request closed',
          }

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <IconMarker icon={presentation.icon} />
      <div className="py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.actor ? <ActorName actor={event.actor} /> : null}
          <span className="font-semibold text-foreground">
            {presentation.label}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTime(event.at, now)}
        </div>
      </div>
    </div>
  )
}

/**
 * A verdict, as its own row rather than a line inside a collapsed
 * conversation: it wears the reviewer's face on the rail and the verdict's
 * own colour beside their name.
 */
function ReviewVerdictEvent({
  event,
  outcome,
  stale,
  baseHref,
  onOpen,
  reactions,
  now,
}: {
  event: PullRequestTimelineEvent
  outcome: PullRequestReviewOutcome
  /** Commits landed after this verdict, so it speaks for older code. */
  stale: boolean
  baseHref: string | null
  onOpen: (url: string) => void
  reactions: ReactionSurface
  now: number
}) {
  const canReact = event.reactionSubjectId !== null
  return (
    <div className="group relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      {/* Pinned rather than centred: this row grows with a body and a
          reaction bar. */}
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        className="top-6"
        fallback={<PullRequestReviewOutcomeIcon outcome={outcome} />}
      />
      <div className="flex min-w-0 items-start gap-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={event.actor} />
            {/* The word alone, in the verdict's own colour. A verdict
                overtaken by later commits keeps its word and loses that
                colour. */}
            <Tooltip disabled={!stale}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      'font-medium lowercase',
                      stale
                        ? 'text-muted-foreground opacity-70'
                        : pullRequestReviewOutcomeToneClassName(outcome)
                    )}
                  />
                }
              >
                {pullRequestReviewOutcomeLabel(outcome)}
                {stale ? (
                  <span className="sr-only">, before the latest commits</span>
                ) : null}
              </TooltipTrigger>
              <TooltipContent>
                {pullRequestReviewOutcomeStaleLabel(outcome)}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PullRequestMetaLine className="flex-wrap text-[11px] text-muted-foreground">
              <span>{formatRelativeTime(event.at, now)}</span>
              {event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2 aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
            {canReact || event.reactions.length > 0 ? (
              <PullRequestReactionBar
                canReact={canReact}
                onRefresh={reactions.onRefresh}
                reactions={event.reactions}
                workspaceId={reactions.workspaceId}
                {...(event.reactionSubjectId === null
                  ? {}
                  : { subjectId: event.reactionSubjectId })}
              />
            ) : null}
          </div>
          {/* An approval usually carries no words. When it does they are the
              review, so they stay visible. */}
          {event.body ? (
            <TimelineBody
              baseHref={baseHref}
              body={event.body}
              markdown={event.markdown}
            />
          ) : null}
        </div>
        <OpenOnHostButton onOpen={onOpen} url={event.url} />
      </div>
    </div>
  )
}

export function PullRequestTimelineTab({
  detail,
  workspaceId,
  order,
  now,
  onOpenCommit,
  onRefresh,
}: {
  detail: PullRequestDetailView
  workspaceId: string
  order: 'newest' | 'oldest'
  /** Rendering clock, so every entry in one pass agrees on "now". */
  now: number
  onOpenCommit: (oid: string) => void
  onRefresh: () => void
}) {
  const events = buildPullRequestTimeline(detail)
  const newestCommitAt = newestPullRequestCommitAt(detail.commits)
  const reactions: ReactionSurface = { workspaceId, onRefresh }
  const orderedEvents = order === 'newest' ? events : events.toReversed()
  const rows = groupPullRequestTimelineConversations(orderedEvents)
  const openOnHost = (url: string) => {
    openExternally(url)
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          <span
            aria-hidden
            className="absolute top-1 bottom-5 left-[15px] w-px bg-border/45"
          />
          {rows.map((row) => {
            if (row.kind === 'comments') {
              return (
                <ConversationGroup
                  baseHref={detail.url}
                  events={row.events}
                  key={`comments:${row.events[0]?.id ?? 'empty'}`}
                  now={now}
                  onOpen={openOnHost}
                  reactions={reactions}
                />
              )
            }
            const event = row.event
            if (event.kind === 'commit') {
              return (
                <CommitEvent
                  event={event}
                  key={event.id}
                  now={now}
                  onOpen={onOpenCommit}
                />
              )
            }
            const outcome = pullRequestReviewOutcome(event.reviewState)
            if (outcome !== null) {
              return (
                <ReviewVerdictEvent
                  baseHref={detail.url}
                  event={event}
                  key={event.id}
                  now={now}
                  onOpen={openOnHost}
                  outcome={outcome}
                  reactions={reactions}
                  stale={isPullRequestVerdictStale(event.at, newestCommitAt)}
                />
              )
            }
            return <LifecycleEvent event={event} key={event.id} now={now} />
          })}
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <GitPullRequest className="mb-2 size-5" />
            <p className="text-xs">No activity yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
