// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the panel is t3code's, ported whole; splitting it would diverge from the source it mirrors.
/**
 * The pull request panel: header chrome, lifecycle actions, and the
 * Summary | Timeline | Code sub-tabs. Ported from t3code's
 * `PullRequestDetailPanel.tsx`.
 *
 * Every sub-tab the reader has opened stays mounted behind the active one
 * and is hidden with `visibility`, which keeps boxes, sizes and scroll
 * offsets while taking hidden content out of the tab order. The Code tab
 * is lazy-loaded so the diff viewer's worker pool stays out of the bundle
 * until it is needed — and prefetched on mount so clicking it lands on a
 * chunk already in the module cache.
 *
 * Laborer adaptations: the panel is addressed by workspace id (a workspace
 * has at most one pull request); freshness is polled the way the retired
 * comments pane polled (GitHub has no watcher); permission gates collapse
 * to `viewerCanWrite`; and t3's checkout / agent hand-off / environment
 * picker affordances are gone — Laborer has no counterpart surface.
 * `PR_NOT_FOUND` renders the missing state rather than an error.
 */
import {
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type {
  PullRequestActionKind,
  PullRequestMergeMethod,
  PullRequestUpdateMethod,
} from '@laborer/shared/rpc'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@laborer/ui/components/alert-dialog'
import { Badge } from '@laborer/ui/components/badge'
import { Button } from '@laborer/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Input } from '@laborer/ui/components/input'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@laborer/ui/components/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { Cause, Option } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowUpRight,
  CircleDot,
  FileDiff,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link as LinkIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RefreshCw,
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { PullRequestChecksPopover } from './checks-popover'
import {
  canEditPullRequest,
  latestPullRequestReviewOutcomes,
  mergePullRequestView,
  readableFailure,
  shouldRefreshPullRequestActivity,
} from './detail-logic'
import { openExternally } from './external-links'
import { PullRequestDetailGhost, PullRequestTimelineGhost } from './ghosts'
import {
  PullRequestActorAvatar,
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestChecksState,
  pullRequestReviewOutcomeToneClassName,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from './presentation'
import {
  pullRequestActionMutation,
  pullRequestActivityQuery,
  pullRequestDetailQuery,
  pullRequestEditMutation,
} from './queries'
import { formatRelativeTime } from './relative-time'
import { PullRequestSummaryTab } from './summary-tab'
import { PullRequestTimelineTab } from './timeline-tab'
import {
  PullRequestActivityUnavailableState,
  PullRequestMissingState,
  PullRequestUnavailableState,
} from './unavailable-states'
import {
  useFailureStreak,
  usePolledRefresh,
  useSlowClock,
} from './use-polled-refresh'

type DetailTab = 'summary' | 'timeline' | 'code'

const ACTION_SUCCESS_LABELS: Record<PullRequestActionKind, string> = {
  merge: 'Pull request merged',
  ready: 'Marked ready for review',
  draft: 'Converted to draft',
  close: 'Pull request closed',
  reopen: 'Pull request reopened',
  updateBranch: 'Branch updated with the base branch',
  // True whichever it did: a pull request that was already mergeable merges
  // the moment this is armed.
  enableAutoMerge:
    'Auto-merge turned on — merges as soon as this is ready, sooner if it already is',
  disableAutoMerge: 'Auto-merge turned off',
}

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: 'Merge',
  squash: 'Squash',
  rebase: 'Rebase',
}

/** Said as the thing that did not happen, rather than as an operation error. */
const ACTION_FAILURE_LABELS: Record<PullRequestActionKind, string> = {
  merge: 'Could not merge this pull request',
  ready: 'Could not mark this ready for review',
  draft: 'Could not convert this to a draft',
  close: 'Could not close this pull request',
  reopen: 'Could not reopen this pull request',
  updateBranch: 'Could not update this branch',
  enableAutoMerge: 'Could not turn on auto-merge',
  disableAutoMerge: 'Could not turn off auto-merge',
}

/** What to try, for the times GitHub says only that it refused. */
const ACTION_FAILURE_HINTS: Record<PullRequestActionKind, string> = {
  merge:
    'GitHub refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.',
  ready:
    'GitHub refused it. Check that you have write access to this repository.',
  draft:
    'GitHub refused it. Check that you have write access to this repository.',
  close:
    'GitHub refused it. Check that you have write access, or that you opened it.',
  reopen:
    'GitHub refused it. Check that you have write access, and that the branch still exists.',
  updateBranch:
    'GitHub refused it. Check that you have write access to the branch — one from a fork also needs its author to allow edits from maintainers — and that it does not conflict with the base.',
  enableAutoMerge:
    'GitHub refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.',
  disableAutoMerge:
    'GitHub refused it. Check that you have write access, and that the merge has not already happened.',
}

/**
 * Said instead of the update hint when the reader asked for a rebase: it
 * fails on its own merits, because GitHub replays the commits and stops at
 * the first that does not apply.
 */
const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  'GitHub refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.'

const TABS: readonly { value: DetailTab; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'code', label: 'Code' },
]

// The diff viewer pulls in its worker pool, so it stays out of the bundle
// until Code is opened. Named so the panel can also start the download
// before anyone has clicked the tab.
const loadCodeTab = () => import('./code-tab')
const PullRequestCodeTab = lazy(loadCodeTab)

const REPOSITORY_URL_PATTERN = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/
const REPOSITORY_NAME_PATTERN = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/

/** `https://github.com/owner/repo/pull/123` names the repository too. */
export function pullRequestRepositoryUrl(prUrl: string): string | null {
  return REPOSITORY_URL_PATTERN.exec(prUrl)?.[1] ?? null
}

/** `owner/repo`, for the header's repository crumb. */
export function pullRequestRepositoryName(prUrl: string): string | null {
  return REPOSITORY_NAME_PATTERN.exec(prUrl)?.[1] ?? null
}

/** Copy-to-clipboard with a short-lived "Copied" state for the branch chip. */
function useCopyToClipboard(timeout = 1600) {
  const [isCopied, setIsCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
    },
    []
  )
  const copy = useCallback(
    (text: string) => {
      navigator.clipboard?.writeText(text).then(
        () => {
          setIsCopied(true)
          if (timer.current !== null) {
            clearTimeout(timer.current)
          }
          timer.current = setTimeout(() => setIsCopied(false), timeout)
        },
        () => {
          toast.error('Could not copy to the clipboard')
        }
      )
    },
    [timeout]
  )
  return { copy, isCopied }
}

export function PullRequestPanel({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  const [tab, setTab] = useState<DetailTab>('summary')
  const [timelineOrder, setTimelineOrder] = useState<'newest' | 'oldest'>(
    'newest'
  )
  const [selectedCodeCommitOid, setSelectedCodeCommitOid] = useState<
    string | null
  >(null)
  const openCommit = (oid: string) => {
    setSelectedCodeCommitOid(oid)
    setTab('code')
  }
  // Every tab the reader has opened stays mounted behind the active one:
  // the diff viewer virtualizes against its own scroll position, and a
  // large description re-parses its markdown on every return otherwise.
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<DetailTab>>(
    () => new Set<DetailTab>(['summary'])
  )
  useEffect(() => {
    setMountedTabs((previous) =>
      previous.has(tab) ? previous : new Set<DetailTab>(previous).add(tab)
    )
  }, [tab])
  const [chromeCondensed, setChromeCondensed] = useState(false)
  // Each mounted tab remembers its own scroll chrome.
  const chromeStateByTab = useRef<Partial<Record<DetailTab, boolean>>>({})
  useEffect(() => {
    setChromeCondensed(chromeStateByTab.current[tab] ?? false)
  }, [tab])
  const condensed = chromeCondensed
  const scrollerRef = useRef<HTMLElement | null>(null)
  const foldRef = useRef<HTMLDivElement | null>(null)
  const condensedRowRef = useRef<HTMLDivElement | null>(null)
  // Refund after the fold commits so the content under the reader does not
  // jump with its height.
  const compensationRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (compensationRef.current === null) {
      return
    }
    const scroller = scrollerRef.current
    const delta = compensationRef.current
    compensationRef.current = null
    if (scroller) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta)
    }
  }, [])
  const [mergeMethod, setMergeMethod] =
    useState<PullRequestMergeMethod>('merge')
  const [confirmation, setConfirmation] = useState<{
    readonly open: boolean
    readonly action: 'merge' | 'close' | 'enableAutoMerge'
  }>({ open: false, action: 'merge' })
  const confirmAction = confirmation.action
  const { copy: copyBranchToClipboard, isCopied: isBranchCopied } =
    useCopyToClipboard()
  const now = useSlowClock()
  // The chunk is fetched as soon as the panel exists, so a reader who does
  // click Code lands on a chunk already in the module cache.
  useEffect(() => {
    loadCodeTab().catch(() => undefined)
  }, [])

  const detailAtom = useMemo(
    () => pullRequestDetailQuery(workspaceId),
    [workspaceId]
  )
  const activityAtom = useMemo(
    () => pullRequestActivityQuery(workspaceId),
    [workspaceId]
  )
  const detailResult = useAtomValue(detailAtom)
  const activityResult = useAtomValue(activityAtom)
  const refreshDetailAtom = useAtomRefresh(detailAtom)
  const refreshActivityAtom = useAtomRefresh(activityAtom)

  // Stale-while-revalidate: a waiting or failed Result keeps its previous
  // value, so a refresh never blanks what is being read.
  const coreDetail = Option.getOrNull(Result.value(detailResult))
  const activity = Option.getOrNull(Result.value(activityResult))
  const detail = useMemo(
    () =>
      coreDetail === null ? null : mergePullRequestView(coreDetail, activity),
    [activity, coreDetail]
  )
  const detailFailure = Result.isFailure(detailResult)
    ? Cause.squash(detailResult.cause)
    : null
  const detailErrorCode =
    detailFailure === null ? undefined : extractErrorCode(detailFailure)
  const activityFailure = Result.isFailure(activityResult)
    ? Cause.squash(activityResult.cause)
    : null
  const activityPending = activity === null && activityFailure === null
  const activityError =
    activity === null && activityFailure !== null
      ? extractErrorMessage(activityFailure)
      : null

  const refreshDetail = useCallback(() => {
    refreshDetailAtom()
    refreshActivityAtom()
  }, [refreshDetailAtom, refreshActivityAtom])

  // GitHub cannot tell us when the conversation moves, so the panel asks.
  // Core detail is cheap enough to re-read on the cadence; the revision
  // effect below reads the heavier activity only after the same pull
  // request reports a change.
  const failureStreak = useFailureStreak(detailResult)
  usePolledRefresh(refreshDetailAtom, failureStreak)
  const activityRevision = useRef<{
    readonly key: string
    readonly updatedAt: string
  } | null>(null)
  useEffect(() => {
    if (!coreDetail) {
      return
    }
    const next = { key: workspaceId, updatedAt: coreDetail.updatedAt }
    if (shouldRefreshPullRequestActivity(activityRevision.current, next)) {
      refreshActivityAtom()
    }
    activityRevision.current = next
  }, [coreDetail, refreshActivityAtom, workspaceId])

  // The button goes around GitHub's cache rather than through it: it also
  // hands the Code tab a token to drop its accumulated pages.
  const [refreshToken, setRefreshToken] = useState(0)
  const refreshFromHost = useCallback(() => {
    refreshDetail()
    setRefreshToken((token) => token + 1)
  }, [refreshDetail])

  const runAction = useAtomSet(pullRequestActionMutation, { mode: 'promise' })
  // Which action is in flight, not merely that one is: every control here
  // is disabled while any runs, but only the pressed button says what.
  const [pendingAction, setPendingAction] =
    useState<PullRequestActionKind | null>(null)
  const actionPending = pendingAction !== null
  const edit = useAtomSet(pullRequestEditMutation, { mode: 'promise' })
  // Scoped to the pull request it was typed against.
  const [titleScope, setTitleScope] = useState<{
    readonly key: string
    readonly text: string
  } | null>(null)
  const titleDraft = titleScope?.key === workspaceId ? titleScope.text : null
  const [titleSaving, setTitleSaving] = useState(false)

  const perform = async (
    action: PullRequestActionKind,
    method?: PullRequestMergeMethod,
    updateMethod?: PullRequestUpdateMethod
  ) => {
    if (pendingAction !== null) {
      return
    }
    setPendingAction(action)
    try {
      await runAction({
        payload: {
          workspaceId,
          action,
          ...(method ? { mergeMethod: method } : {}),
          ...(updateMethod ? { updateMethod } : {}),
        },
      })
    } catch (failure) {
      setPendingAction(null)
      // GitHub's own sentence, because it is the only thing that says why.
      const hint =
        updateMethod === 'rebase'
          ? UPDATE_BRANCH_REBASE_FAILURE_HINT
          : ACTION_FAILURE_HINTS[action]
      toast.error(ACTION_FAILURE_LABELS[action], {
        description: readableFailure(failure, hint),
      })
      return
    }
    setPendingAction(null)
    toast.success(ACTION_SUCCESS_LABELS[action])
    // A branch update moves the head commit, which leaves the diff pointed
    // at a comparison that no longer exists.
    if (action === 'updateBranch') {
      refreshFromHost()
    } else {
      refreshDetail()
    }
  }

  const saveTitle = async (next: string) => {
    const title = next.trim()
    if (detail === null || titleSaving) {
      return
    }
    if (title.length === 0 || title === detail.title) {
      setTitleScope(null)
      return
    }
    setTitleSaving(true)
    try {
      await edit({ payload: { workspaceId, title } })
    } catch (failure) {
      setTitleSaving(false)
      // The draft stays open with the words still in it.
      toast.error('The title could not be saved', {
        description: readableFailure(failure, 'GitHub refused the new title.'),
      })
      return
    }
    setTitleSaving(false)
    setTitleScope(null)
    refreshDetail()
  }

  // The repository's own settings narrow the strategies on offer.
  const allowedMergeMethods = detail
    ? (Object.keys(MERGE_METHOD_LABELS) as PullRequestMergeMethod[]).filter(
        (method) => detail.mergeCapabilities[method]
      )
    : []
  const selectedMergeMethod = allowedMergeMethods.includes(mergeMethod)
    ? mergeMethod
    : (allowedMergeMethods[0] ?? 'merge')
  const selectedMergeMethodLabel = MERGE_METHOD_LABELS[selectedMergeMethod]
  const conflicting =
    detail?.state === 'open' && detail.mergeability === 'conflicting'
  // Only an outright yes arms it.
  const autoMergeArmed =
    detail?.state === 'open' && detail.autoMergeEnabled === true
  // Two questions folded into one on Laborer's contract: whether this
  // account's role on the repository can push.
  const can = (_action: PullRequestActionKind) =>
    detail?.viewerCanWrite === true
  // One live action holds the slot.
  const primaryAction =
    detail === null || detail.state !== 'open' || conflicting
      ? null
      : detail.isDraft && can('ready')
        ? 'ready'
        : can('merge') && allowedMergeMethods.length > 0
          ? 'merge'
          : null
  const showsDraftToggle =
    detail?.state === 'open' &&
    can(detail.isDraft ? 'ready' : 'draft') &&
    !(detail.isDraft && primaryAction === 'ready')
  const showsAutoMerge =
    detail?.state === 'open' &&
    ((autoMergeArmed && can('disableAutoMerge')) ||
      (!(autoMergeArmed || detail.isDraft || conflicting) &&
        can('enableAutoMerge') &&
        allowedMergeMethods.length > 0))
  const showsMergeMethods =
    detail?.state === 'open' &&
    can('merge') &&
    !(detail.isDraft || conflicting) &&
    allowedMergeMethods.length > 1
  // GitHub does not say whether the branch is behind, so the update lives
  // in the menu whenever it could work at all (open and not conflicting).
  const showsUpdateBranch =
    detail?.state === 'open' && !conflicting && can('updateBranch')
  const statePresentation = detail
    ? resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft })
    : null
  const checksSummary = detail
    ? summarizePullRequestChecks(detail.checks)
    : null
  const checksState = detail ? pullRequestChecksState(detail.checks) : null
  // Approvals that still stand, and only those; not counted at all from a
  // conversation this panel only holds the recent end of.
  const approvalCount =
    detail && !detail.threadsTruncated
      ? latestPullRequestReviewOutcomes(detail.comments, detail.commits).filter(
          (entry) => entry.outcome === 'approved' && !entry.stale
        ).length
      : 0
  const repositoryName = detail ? pullRequestRepositoryName(detail.url) : null
  const repositoryUrl = detail ? pullRequestRepositoryUrl(detail.url) : null

  if (detail === null && detailFailure === null) {
    return <PullRequestDetailGhost />
  }

  if (detail === null && detailFailure !== null) {
    if (detailErrorCode === 'PR_NOT_FOUND') {
      return (
        <div className="flex h-full min-h-0 w-full flex-col bg-background">
          <PullRequestMissingState onRetry={refreshDetail} />
        </div>
      )
    }
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background">
        <PullRequestUnavailableState
          error={extractErrorMessage(detailFailure)}
          onRetry={refreshDetail}
        />
      </div>
    )
  }
  if (detail === null || statePresentation === null) {
    return <PullRequestDetailGhost />
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-border/60 border-b">
        <div className="ml-4 grid h-7 min-w-0 items-center">
          <div
            aria-hidden={condensed}
            className={cn(
              'col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-muted-foreground text-sm transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs',
              condensed
                ? 'pointer-events-none -translate-y-1 opacity-0 duration-100'
                : 'translate-y-0 opacity-100 delay-50 duration-150'
            )}
            inert={condensed}
          >
            {repositoryName ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    repositoryUrl ? (
                      <button
                        className="min-w-0 cursor-pointer truncate text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => openExternally(repositoryUrl)}
                        type="button"
                      >
                        {repositoryName}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-medium text-muted-foreground">
                        {repositoryName}
                      </span>
                    )
                  }
                />
                <TooltipContent side="top">
                  {repositoryUrl
                    ? `Open ${repositoryName} repository`
                    : repositoryName}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Open pull request #${detail.number} on GitHub`}
                    className={cn(
                      'shrink-0 font-medium underline-offset-2 hover:underline',
                      statePresentation.toneClassName
                    )}
                    onClick={() => openExternally(detail.url)}
                    type="button"
                  >
                    #{detail.number}
                  </button>
                }
              />
              <TooltipContent side="top">Open on GitHub</TooltipContent>
            </Tooltip>
          </div>
          <div
            aria-hidden={!condensed}
            className={cn(
              'col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-muted-foreground text-sm transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs',
              condensed
                ? 'translate-y-0 opacity-100 delay-50 duration-150'
                : 'pointer-events-none translate-y-1 opacity-0 duration-100'
            )}
            inert={!condensed}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Open pull request #${detail.number} on GitHub`}
                    className={cn(
                      'shrink-0 font-medium underline-offset-2 hover:underline',
                      statePresentation.toneClassName
                    )}
                    onClick={() => openExternally(detail.url)}
                    tabIndex={condensed ? 0 : -1}
                    type="button"
                  >
                    #{detail.number}
                  </button>
                }
              />
              <TooltipContent side="top">Open on GitHub</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {detail.title}
                  </span>
                }
              />
              <TooltipContent side="top">{detail.title}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="mr-4 flex h-7 min-w-0 flex-nowrap items-center justify-end gap-1">
          {/* Said where the Merge button is, because it is the answer to why
              nobody has pressed it. */}
          {autoMergeArmed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    className="h-5 shrink-0 gap-1 rounded px-1.5 text-[10px]"
                    variant="secondary"
                  >
                    <GitMerge aria-hidden className="size-3" />
                    Auto-merge
                  </Badge>
                }
              />
              <TooltipContent side="top">
                GitHub will merge this on its own once its requirements are met
              </TooltipContent>
            </Tooltip>
          ) : null}
          {primaryAction === 'ready' ? (
            <Button
              disabled={actionPending}
              onClick={() => perform('ready')}
              size="xs"
            >
              Ready for review
            </Button>
          ) : primaryAction === 'merge' ? (
            <Button
              disabled={actionPending}
              onClick={() => setConfirmation({ open: true, action: 'merge' })}
              size="xs"
            >
              {pendingAction === 'merge'
                ? 'Merging...'
                : selectedMergeMethodLabel}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="More pull request actions"
                  className="size-6 text-muted-foreground"
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-72" side="bottom">
              <DropdownMenuItem onClick={() => refreshFromHost()}>
                <RefreshCw className="size-3.5" />
                Refresh
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {detail.state === 'open' ? (
                <>
                  {/* Only where the button row could not take it. */}
                  {showsDraftToggle ? (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onClick={() =>
                        perform(detail.isDraft ? 'ready' : 'draft')
                      }
                    >
                      {detail.isDraft ? (
                        <GitPullRequest className="size-3.5" />
                      ) : (
                        <GitPullRequestDraft className="size-3.5" />
                      )}
                      {detail.isDraft ? 'Ready for review' : 'Convert to draft'}
                    </DropdownMenuItem>
                  ) : null}
                  {/* The same merge, left with GitHub to carry out once the
                      things it waits on are done. */}
                  {autoMergeArmed && can('disableAutoMerge') ? (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onClick={() => perform('disableAutoMerge')}
                    >
                      <GitMerge className="size-3.5" />
                      Disable auto-merge
                    </DropdownMenuItem>
                  ) : showsAutoMerge ? (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onClick={() =>
                        setConfirmation({
                          open: true,
                          action: 'enableAutoMerge',
                        })
                      }
                    >
                      <GitMerge className="size-3.5" />
                      Enable auto-merge
                    </DropdownMenuItem>
                  ) : null}
                  {showsUpdateBranch ? (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onClick={() =>
                        perform('updateBranch', undefined, 'merge')
                      }
                    >
                      <GitMerge className="size-3.5" />
                      Update branch with {detail.baseBranch}
                    </DropdownMenuItem>
                  ) : null}
                  {/* A preference for the merge action rather than a second
                      action, so it is a radio group. Hidden while
                      conflicting: every method would fail. */}
                  {showsMergeMethods ? (
                    <>
                      {showsDraftToggle ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuRadioGroup
                        onValueChange={(method) =>
                          setMergeMethod(method as PullRequestMergeMethod)
                        }
                        value={selectedMergeMethod}
                      >
                        {allowedMergeMethods.map((method) => (
                          <DropdownMenuRadioItem
                            disabled={actionPending}
                            key={method}
                            value={method}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <GitMerge className="size-3.5" />
                              <span>{MERGE_METHOD_LABELS[method]}</span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  ) : null}
                  {showsDraftToggle ||
                  showsAutoMerge ||
                  showsUpdateBranch ||
                  showsMergeMethods ? (
                    <DropdownMenuSeparator />
                  ) : null}
                </>
              ) : null}
              <DropdownMenuItem onClick={() => openExternally(detail.url)}>
                <ArrowUpRight className="size-3.5" />
                Open on GitHub
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigator.clipboard?.writeText(detail.url)}
              >
                <LinkIcon className="size-3.5" />
                Copy link
              </DropdownMenuItem>
              {detail.state === 'open' && can('close') ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={actionPending}
                    onClick={() =>
                      setConfirmation({ open: true, action: 'close' })
                    }
                    variant="destructive"
                  >
                    <GitPullRequestClosed className="size-3.5" />
                    Close pull request
                  </DropdownMenuItem>
                </>
              ) : detail.state === 'closed' && can('reopen') ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={actionPending}
                    onClick={() => perform('reopen')}
                  >
                    <GitPullRequest className="size-3.5" />
                    Reopen pull request
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            'col-span-2 grid',
            condensed
              ? 'grid-rows-[1fr]'
              : 'grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none'
          )}
        >
          <div
            className={cn(
              'min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none',
              condensed
                ? 'translate-y-0 opacity-100 delay-50'
                : 'translate-y-1 opacity-0 duration-100'
            )}
            inert={!condensed}
            ref={condensedRowRef}
          >
            <div className="col-span-2 min-w-0 px-4 pt-1 pb-2">
              <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-muted-foreground text-xs">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={detail.author?.login ?? 'ghost'}
                          className="shrink-0 rounded-full"
                          role="img"
                        />
                      }
                    >
                      <PullRequestActorAvatar actor={detail.author} />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {detail.author?.login ?? 'ghost'}
                    </TooltipContent>
                  </Tooltip>
                  <span className="shrink-0">
                    {formatRelativeTime(detail.updatedAt, now)}
                  </span>
                </span>
                <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
                <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-muted-foreground/65">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                          <code className="min-w-0 truncate">
                            {detail.baseBranch}
                          </code>
                        </span>
                      }
                    />
                    <TooltipContent side="top">
                      {detail.baseBranch}
                    </TooltipContent>
                  </Tooltip>
                  <ArrowLeft
                    aria-label="receives changes from"
                    className="size-3 shrink-0 opacity-60"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <code className="min-w-0 flex-1 truncate">
                          {detail.headBranch}
                        </code>
                      }
                    />
                    <TooltipContent side="top">
                      {detail.headBranch}
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <FileDiff aria-hidden className="size-3" />
                    {detail.changedFiles.toLocaleString()}
                    <span className="sr-only">
                      changed {detail.changedFiles === 1 ? 'file' : 'files'}
                    </span>
                  </span>
                  <PullRequestDiffStat
                    additions={detail.additions}
                    className="shrink-0 font-mono text-[11px]"
                    deletions={detail.deletions}
                  />
                </span>
              </div>
            </div>
          </div>
        </div>

        <div
          className={cn(
            'col-span-2 grid',
            // Collapse before the scroll refund paints; only reopening eases
            // back in.
            condensed
              ? 'grid-rows-[0fr]'
              : 'grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none'
          )}
        >
          <div
            className={cn(
              'min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none',
              condensed
                ? '-translate-y-1 opacity-0 duration-100'
                : 'translate-y-0 opacity-100 delay-50'
            )}
            inert={condensed}
            ref={foldRef}
          >
            <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
              {titleDraft === null ? (
                <div className="group flex min-w-0 items-start gap-1">
                  <h1 className="min-w-0 flex-1 font-semibold text-base leading-snug">
                    {detail.title}
                  </h1>
                  {canEditPullRequest(detail) ? (
                    <Button
                      aria-label="Edit title"
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                      onClick={() =>
                        setTitleScope({ key: workspaceId, text: detail.title })
                      }
                      size="icon-xs"
                      variant="ghost"
                    >
                      <Pencil className="size-3" />
                    </Button>
                  ) : null}
                </div>
              ) : (
                // A title is one line of text, not markdown.
                <div className="space-y-2">
                  <Input
                    aria-label="Pull request title"
                    autoFocus
                    disabled={titleSaving}
                    onChange={(event) =>
                      setTitleScope({
                        key: workspaceId,
                        text: event.target.value,
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        saveTitle(titleDraft)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setTitleScope(null)
                      }
                    }}
                    value={titleDraft}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={titleSaving}
                      onClick={() => setTitleScope(null)}
                      size="xs"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={titleSaving || titleDraft.trim().length === 0}
                      onClick={() => saveTitle(titleDraft)}
                      size="xs"
                      variant="outline"
                    >
                      {titleSaving ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                </div>
              )}
              <PullRequestMetaLine className="mt-2 text-muted-foreground text-xs">
                <PullRequestActorLabel
                  actor={detail.author}
                  className="font-medium"
                />
                <span>updated {formatRelativeTime(detail.updatedAt, now)}</span>
              </PullRequestMetaLine>

              <div className="mt-4 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-muted-foreground/70 text-xs">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                          <code className="min-w-0 truncate">
                            {detail.baseBranch}
                          </code>
                        </span>
                      }
                    />
                    <TooltipContent side="top">
                      {detail.baseBranch}
                    </TooltipContent>
                  </Tooltip>
                  <ArrowLeft
                    aria-label="receives changes from"
                    className="size-3.5 shrink-0 opacity-60"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          aria-label={
                            isBranchCopied
                              ? 'Branch name copied'
                              : 'Copy pull request branch'
                          }
                          className="grid w-fit min-w-0 max-w-full shrink cursor-pointer rounded px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          onClick={() =>
                            copyBranchToClipboard(detail.headBranch)
                          }
                          type="button"
                        />
                      }
                    >
                      <code
                        className={cn(
                          'col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none',
                          isBranchCopied ? 'opacity-0' : 'opacity-100'
                        )}
                      >
                        {detail.headBranch}
                      </code>
                      <span
                        aria-hidden="true"
                        className={cn(
                          'col-start-1 row-start-1 truncate text-center transition-opacity duration-150 motion-reduce:transition-none',
                          isBranchCopied ? 'opacity-100' : 'opacity-0'
                        )}
                      >
                        Copied
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {`${isBranchCopied ? 'Copied' : 'Copy pull request branch'}: ${detail.headBranch}`}
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <FileDiff className="size-3.5" />
                    {detail.changedFiles.toLocaleString()}{' '}
                    {detail.changedFiles === 1 ? 'file' : 'files'}
                  </span>
                  <PullRequestDiffStat
                    additions={detail.additions}
                    className="shrink-0 font-mono text-xs"
                    deletions={detail.deletions}
                  />
                </span>
              </div>
            </div>
          </div>
        </div>

        <nav
          aria-label="Pull request tabs"
          className="col-span-2 flex min-w-0 items-center gap-1 overflow-x-auto border-border/60 border-t px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <ToggleGroup size="sm" value={[tab]}>
            {TABS.map((item) => (
              <ToggleGroupItem
                key={item.value}
                onClick={() => setTab(item.value)}
                value={item.value}
              >
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {tab === 'summary' ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
              {checksState !== null ? (
                <PullRequestChecksPopover
                  checks={detail.checks}
                  checksState={checksState}
                />
              ) : (
                <CircleDot aria-hidden className="size-3.5" />
              )}
              {checksSummary}
            </span>
          ) : tab === 'timeline' ? (
            <div className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
              <PullRequestMetaLine
                className={cn(
                  'whitespace-nowrap text-[11px] transition-opacity',
                  (activityPending || activityError) && 'opacity-35'
                )}
              >
                <span className="inline-flex items-center gap-1">
                  <MessageSquare aria-hidden className="size-3" />
                  {activityError
                    ? '—'
                    : activityPending
                      ? '…'
                      : detail.comments.length.toLocaleString()}
                  <span className="sr-only">
                    {activityError
                      ? 'Comments unavailable'
                      : detail.comments.length === 1
                        ? 'comment'
                        : 'comments'}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <GitCommitHorizontal aria-hidden className="size-3" />
                  {activityError
                    ? '—'
                    : activityPending
                      ? '…'
                      : detail.commits.length.toLocaleString()}
                  <span className="sr-only">
                    {activityError
                      ? 'Commits unavailable'
                      : detail.commits.length === 1
                        ? 'commit'
                        : 'commits'}
                  </span>
                </span>
                {approvalCount > 0 ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1',
                      pullRequestReviewOutcomeToneClassName('approved')
                    )}
                  >
                    <PullRequestReviewOutcomeIcon
                      className="size-3"
                      outcome="approved"
                    />
                    {approvalCount.toLocaleString()}
                    <span className="sr-only">
                      {approvalCount === 1 ? 'approval' : 'approvals'}
                    </span>
                  </span>
                ) : null}
              </PullRequestMetaLine>
              <Button
                aria-label={
                  timelineOrder === 'newest'
                    ? 'Show oldest activity first'
                    : 'Show newest activity first'
                }
                className="h-7 px-2 text-[10px] text-muted-foreground"
                onClick={() =>
                  setTimelineOrder((value) =>
                    value === 'newest' ? 'oldest' : 'newest'
                  )
                }
                size="xs"
                variant="ghost"
              >
                <ArrowDownUp aria-hidden className="size-3" />
                {timelineOrder === 'newest' ? 'Newest first' : 'Oldest first'}
              </Button>
            </div>
          ) : null}
        </nav>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onScrollCapture={(event) => {
          const scroller = event.target as HTMLElement
          scrollerRef.current = scroller
          const top = scroller.scrollTop
          setChromeCondensed((previous) => {
            let next = previous
            const foldHeight = foldRef.current?.scrollHeight ?? 0
            // The condensed row remains mounted, so refund only the height
            // that actually leaves.
            const chromeDelta =
              foldHeight - (condensedRowRef.current?.scrollHeight ?? 0)
            if (previous) {
              // The hard top reopens the chrome with no refund: the reader
              // asked for the top.
              if (top < 4 && foldHeight > 0) {
                next = false
              }
            } else if (foldHeight > 0 && top > foldHeight + 32) {
              compensationRef.current = -chromeDelta
              next = true
            }
            chromeStateByTab.current[tab] = next
            return next
          })
        }}
      >
        {mountedTabs.has('summary') ? (
          <div
            className={cn('absolute inset-0', tab !== 'summary' && 'invisible')}
          >
            <PullRequestSummaryTab
              activityError={activityError}
              activityPending={activityPending}
              detail={detail}
              now={now}
              onRefresh={refreshDetail}
              workspaceId={workspaceId}
            />
          </div>
        ) : null}
        {mountedTabs.has('timeline') ? (
          <div
            className={cn(
              'absolute inset-0',
              tab !== 'timeline' && 'invisible'
            )}
          >
            {activityPending ? (
              <PullRequestTimelineGhost />
            ) : activityError ? (
              <PullRequestActivityUnavailableState
                error={activityError}
                onRetry={refreshActivityAtom}
              />
            ) : (
              <PullRequestTimelineTab
                detail={detail}
                now={now}
                onOpenCommit={openCommit}
                onRefresh={refreshDetail}
                order={timelineOrder}
                workspaceId={workspaceId}
              />
            )}
          </div>
        ) : null}
        {mountedTabs.has('code') ? (
          <div
            className={cn('absolute inset-0', tab !== 'code' && 'invisible')}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                  Loading pull request diff...
                </div>
              }
            >
              <PullRequestCodeTab
                detail={detail}
                now={now}
                onRefresh={refreshDetail}
                onSelectedCommitChange={setSelectedCodeCommitOid}
                refreshToken={refreshToken}
                selectedCommitOid={selectedCodeCommitOid}
                workspaceId={workspaceId}
              />
            </Suspense>
          </div>
        ) : null}
      </div>

      <AlertDialog
        onOpenChange={(open) =>
          setConfirmation((current) => ({ ...current, open }))
        }
        open={confirmation.open}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'merge'
                ? 'Merge pull request?'
                : confirmAction === 'enableAutoMerge'
                  ? 'Enable auto-merge?'
                  : 'Close pull request?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'merge'
                ? `This merges #${detail.number} using ${selectedMergeMethod}.`
                : confirmAction === 'enableAutoMerge'
                  ? `This merges #${detail.number} using ${selectedMergeMethod} as soon as GitHub considers it ready, which may be immediately.`
                  : `This closes #${detail.number} without merging it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" variant="outline">
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={actionPending}
              onClick={() => {
                const action = confirmAction
                setConfirmation((current) => ({ ...current, open: false }))
                if (action === 'merge') {
                  perform('merge', selectedMergeMethod)
                }
                if (action === 'enableAutoMerge') {
                  perform('enableAutoMerge', selectedMergeMethod)
                }
                if (action === 'close') {
                  perform('close')
                }
              }}
              size="sm"
              variant={confirmAction === 'close' ? 'destructive' : 'default'}
            >
              {confirmAction === 'merge'
                ? selectedMergeMethodLabel
                : confirmAction === 'enableAutoMerge'
                  ? 'Enable auto-merge'
                  : 'Close'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
