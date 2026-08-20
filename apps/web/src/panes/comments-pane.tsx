/**
 * Pull request comments pane — the conversation on a workspace's PR.
 *
 * Reads GitHub directly through the `pullRequest.comments` RPC, which shells
 * out to `gh`. Issue comments, submitted reviews, and line-anchored review
 * comments arrive as one chronological timeline and render as GitHub
 * Desktop's comment-like items: avatar, verb, age, and an optional markdown
 * bubble.
 *
 * Displayed as a right-side panel alongside workspace frames, the same way
 * the diff pane is.
 *
 * Freshness is polled rather than pushed. GitHub has no local watcher to
 * subscribe to, so the pane re-reads on an interval while it is mounted and
 * offers a manual refresh. Stale-while-revalidate keeps the conversation on
 * screen during a refresh, so reading is never interrupted by a spinner —
 * but a read that fails after one succeeded still says so, because a pane
 * quietly showing an hour-old conversation is worse than one admitting it
 * is behind.
 *
 * Polling costs three `gh api` calls per read against a 5,000/hour budget
 * shared with the rest of the app, so the loop only runs while the document
 * is visible and widens after consecutive failures.
 *
 * A branch with no pull request is an empty state, not an error: it is the
 * normal condition of a workspace whose work has not been opened yet.
 *
 * @see packages/server/src/services/pull-request-comments.ts — the reader
 * @see app/src/ui/notifications/pull-request-comment-like.tsx in
 *   desktop/desktop — the interface this restores
 */

import { useAtomRefresh, useAtomValue } from '@effect/atom-react/Hooks'
import { RpcError } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { Spinner } from '@laborer/ui/components/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { Cause, Effect, Option } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ExternalLink,
  GitPullRequest,
  MessagesSquare,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'
import { GitHubLink } from './comments-pane/external-links'
import { CommentTimelineItem } from './comments-pane/timeline-item'

/** How long a single conversation read may take before it is abandoned. */
const COMMENTS_FETCH_TIMEOUT = '15 seconds'

/**
 * How often the conversation is re-read while the pane is open and visible.
 *
 * GitHub's own web UI polls on roughly this cadence.
 */
export const POLL_INTERVAL_MS = 30_000

/**
 * The widest the poll interval may grow after repeated failures.
 *
 * A revoked token or a deleted worktree fails every time, and retrying that
 * twice a minute for an hour spends the rate limit on an answer that is not
 * going to change. Five minutes still notices when it is fixed.
 */
const MAX_POLL_INTERVAL_MS = 300_000

/** How long to wait before the next read, given the failures since the last success. */
const pollIntervalFor = (consecutiveFailures: number) =>
  Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_POLL_INTERVAL_MS)

/** How often the rendered ages tick, so "just now" does not go stale. */
const CLOCK_INTERVAL_MS = 60_000

/**
 * Query atom keyed by workspace, so two open panes never interrupt each
 * other's in-flight request.
 */
const commentsQuery = Atom.family((workspaceId: string) =>
  LaborerClient.runtime.atom(
    Effect.flatMap(LaborerClient, (client) =>
      client('pullRequest.comments', { workspaceId })
    ).pipe(
      Effect.timeoutOrElse({
        duration: COMMENTS_FETCH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RpcError({
              message: 'Timed out reading the pull request conversation',
              code: 'TIMEOUT',
            })
          ),
      })
    )
  )
)

interface CommentsPaneProps {
  /** Callback to close the pane. */
  readonly onClose?: (() => void) | undefined
  /** The workspace whose pull request conversation to display. */
  readonly workspaceId: string
}

function CommentsPaneHeader({
  isRefreshing,
  onClose,
  onRefresh,
  prNumber,
  prTitle,
  prUrl,
}: {
  readonly isRefreshing: boolean
  readonly onClose?: (() => void) | undefined
  readonly onRefresh: () => void
  readonly prNumber?: number | undefined
  readonly prTitle?: string | null | undefined
  readonly prUrl?: string | null | undefined
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3">
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      {/* Once the pull request is known, its title identifies the pane better
          than the word "Comments" does, and the icon still says what this is.
          The pane is narrow, so the title is the only thing allowed to
          shrink; the full text stays available as a tooltip. */}
      {prTitle ? (
        <span
          className="min-w-0 truncate font-medium text-foreground text-xs"
          title={prTitle}
        >
          {prTitle}
        </span>
      ) : (
        <span className="shrink-0 font-medium text-muted-foreground text-xs">
          Comments
        </span>
      )}
      {prNumber === undefined ? null : (
        <span className="shrink-0 text-muted-foreground/70 text-xs">
          #{prNumber}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {prUrl ? (
          <GitHubLink
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            href={prUrl}
            title="Open pull request on GitHub"
          >
            <ExternalLink className="size-3" />
            <span className="sr-only">Open pull request on GitHub</span>
          </GitHubLink>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Refresh comments"
                className="size-6"
                disabled={isRefreshing}
                onClick={onRefresh}
                size="icon"
                variant="ghost"
              />
            }
          >
            <RefreshCw
              className={isRefreshing ? 'size-3 animate-spin' : 'size-3'}
            />
          </TooltipTrigger>
          <TooltipContent>Refresh comments</TooltipContent>
        </Tooltip>
        {onClose && (
          <Button
            aria-label="Close comments"
            className="size-6"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * A clock that ticks slowly enough to be free and often enough that a
 * rendered age is never more than a minute wrong.
 */
function useSlowClock(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return now
}

/**
 * Re-reads the conversation on a cadence GitHub can afford.
 *
 * Two things bend the cadence, and both need a delay that differs from one
 * tick to the next — which `setInterval` cannot express — so every tick
 * schedules the one after it. A hidden document is not being read by
 * anyone, so it buys nothing and the loop stops until the pane is looked
 * at again; returning to a pane that went stale meanwhile reads
 * immediately rather than making the reader wait out an interval. And a
 * run of failures widens the gap, because whatever is wrong is not going
 * to be fixed by asking again in thirty seconds.
 */
function usePolledRefresh(refresh: () => void, failureStreak: number): void {
  // Held in a ref so a new function identity per render does not restart
  // the loop; the interval is a dependency because a changed cadence
  // means an outcome just landed and the countdown should start over.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const interval = pollIntervalFor(failureStreak)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastReadAt = Date.now()

    const stop = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const scheduleIn = (delay: number) => {
      stop()
      timer = setTimeout(() => {
        lastReadAt = Date.now()
        refreshRef.current()
        scheduleIn(interval)
      }, delay)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      // Resume where the loop left off: a pane hidden past its interval
      // owes the reader a read now, one hidden briefly does not.
      scheduleIn(Math.max(interval - (Date.now() - lastReadAt), 0))
    }

    if (document.visibilityState !== 'hidden') {
      scheduleIn(interval)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [interval])
}

/**
 * How many reads in a row have failed since the last one that worked.
 *
 * Only settled reads count: a refresh in flight still carries the previous
 * outcome, and counting that would double every failure.
 */
function useFailureStreak(
  result: Result.AsyncResult<unknown, unknown>
): number {
  const [streak, setStreak] = useState(0)
  const isFailure = Result.isFailure(result)

  useEffect(() => {
    if (result.waiting) {
      return
    }
    setStreak((previous) => (isFailure ? previous + 1 : 0))
  }, [result, isFailure])

  return streak
}

/**
 * Puts the newest comment on screen the first time there is one to show.
 *
 * The timeline is oldest-first, so a long pull request would otherwise open
 * three weeks in the past, with the review that made someone open the pane
 * below the fold. Only the first load jumps: a poll landing while someone
 * reads must never move the page under them.
 */
function useScrollToLatest(
  scrollRootRef: React.RefObject<HTMLDivElement | null>,
  commentCount: number
): void {
  const hasJumpedRef = useRef(false)

  useEffect(() => {
    if (hasJumpedRef.current || commentCount === 0) {
      return
    }
    // `ScrollArea` owns its scrolling element and does not hand out a ref
    // to it; the viewport is reachable only by its slot attribute.
    const viewport = scrollRootRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
    hasJumpedRef.current = true
  }, [scrollRootRef, commentCount])
}

/**
 * Says the conversation on screen is behind without taking it away.
 *
 * A failed refresh over data that already loaded is a footnote, not an
 * emergency: the comments are still worth reading, they are just not the
 * last word. It sits under the header, keeps the muted palette, and offers
 * the same retry the full-pane error state does.
 */
function StaleConversationBanner({
  message,
  onRetry,
}: {
  readonly message: string
  readonly onRetry: () => void
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-3">
      <TriangleAlert
        aria-hidden="true"
        className="size-3 shrink-0 text-muted-foreground"
      />
      {/* `output` is a live region by default, so the banner announces
          itself when a refresh fails without stealing focus. */}
      <output
        className="min-w-0 truncate text-muted-foreground text-xs"
        title={message}
      >
        Showing the last conversation read — {message}
      </output>
      <Button
        aria-label="Retry reading the pull request conversation"
        className="ml-auto h-5 shrink-0 px-1.5 text-xs"
        onClick={onRetry}
        size="sm"
        variant="ghost"
      >
        Retry
      </Button>
    </div>
  )
}

export function CommentsPane({ onClose, workspaceId }: CommentsPaneProps) {
  const commentsAtom = useMemo(() => commentsQuery(workspaceId), [workspaceId])
  const result = useAtomValue(commentsAtom)
  const refresh = useAtomRefresh(commentsAtom)
  const now = useSlowClock()
  const scrollRootRef = useRef<HTMLDivElement>(null)

  // GitHub cannot tell us when the conversation moves, so the pane asks.
  const failureStreak = useFailureStreak(result)
  usePolledRefresh(refresh, failureStreak)

  // Stale-while-revalidate: a waiting or failed Result keeps its previous
  // value, so a refresh never blanks the conversation being read.
  const conversationOption = Result.value(result)
  const conversation = Option.getOrUndefined(conversationOption)
  const hasData = Option.isSome(conversationOption)
  const isFailure = Result.isFailure(result)
  const comments = conversation?.comments ?? []

  useScrollToLatest(scrollRootRef, comments.length)

  // The last read stands on its own whether or not an earlier one
  // succeeded. Suppressing it once there is data would mean a revoked
  // token or a deleted worktree never surfaces again — the pane would show
  // an hour-old conversation and claim nothing was wrong.
  const failure = useMemo(() => {
    if (!isFailure) {
      return null
    }
    const squashed = Cause.squash(result.cause)
    return {
      code: extractErrorCode(squashed),
      message: extractErrorMessage(squashed),
    }
  }, [isFailure, result])

  const header = (
    <CommentsPaneHeader
      isRefreshing={result.waiting}
      onClose={onClose}
      onRefresh={refresh}
      prNumber={conversation?.number}
      prTitle={conversation?.title}
      prUrl={conversation?.url}
    />
  )

  if (!(hasData || failure)) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        {header}
        <div className="flex flex-1 items-center justify-center gap-3">
          <Spinner className="size-5 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Reading GitHub...</p>
        </div>
      </div>
    )
  }

  // With nothing to fall back on, the failure is the whole pane.
  if (failure && !hasData) {
    // A branch without a pull request is the ordinary state of new work,
    // not a failure the user should have to interpret.
    const isMissingPr = failure.code === 'PR_NOT_FOUND'

    return (
      <div className="flex h-full w-full flex-col bg-background">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {isMissingPr ? <GitPullRequest /> : <TriangleAlert />}
              </EmptyMedia>
              <EmptyTitle>
                {isMissingPr ? 'No pull request yet' : 'Could not read GitHub'}
              </EmptyTitle>
              <EmptyDescription>
                {isMissingPr
                  ? 'Open a pull request for this branch and its conversation will appear here.'
                  : failure.message}
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={refresh} size="sm" variant="outline">
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </Empty>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {header}
      {failure ? (
        <StaleConversationBanner message={failure.message} onRetry={refresh} />
      ) : null}
      {comments.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquare />
              </EmptyMedia>
              <EmptyTitle>No comments yet</EmptyTitle>
              <EmptyDescription>
                Reviews and comments on this pull request will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" ref={scrollRootRef}>
          <div className="relative px-3 py-3">
            {/* The timeline rail, running behind every avatar. */}
            <span
              aria-hidden="true"
              className="absolute top-4 bottom-4 left-[23px] border-border border-l border-dashed"
            />
            <ol className="flex flex-col gap-4">
              {comments.map((comment) => (
                <CommentTimelineItem
                  baseHref={conversation?.url ?? null}
                  comment={comment}
                  key={`${comment.kind}-${comment.id}`}
                  now={now}
                />
              ))}
            </ol>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
