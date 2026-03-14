/**
 * Review pane — displays PR review findings and comments from GitHub.
 *
 * Fetches comments via the `review.fetchComments` RPC on mount and renders
 * them in two grouped sections: structured Findings (with severity badges,
 * file:line links, category tags, and collapsible suggested fixes) and
 * Comments (human-authored PR comments with author info and body).
 *
 * Findings are sorted by severity: critical first, then warning, then info.
 * Both sections are collapsible with heading counts.
 *
 * Each finding card has a checkbox for triage selection. Reaction state
 * indicators show which findings are queued (rocket), fixed (thumbs-up),
 * or won't-fix (confused). Already-resolved findings are visually dimmed.
 * A selected count and select all/deselect all control appear in the header.
 *
 * "Fix Selected" adds rocket reactions to all selected findings and spawns
 * a `brrr fix` terminal. "Unqueue" removes the rocket reaction from a
 * single finding.
 *
 * File:line references in finding cards and inline comment cards are
 * clickable — clicking opens the file in the user's configured editor
 * via the `editor.open` RPC.
 *
 * Polls the server every 30 seconds while mounted and provides a manual
 * refresh button. Polling stops automatically when the pane is unmounted.
 *
 * Handles loading, empty (no PR), and error states.
 *
 * @see docs/review-findings-panel/PRD-review-findings-panel.md
 * @see Issue #6: Polling + manual refresh
 * @see Issue #8: Checkbox selection + reaction state display
 * @see Issue #9: Rocket reaction RPCs + Fix Selected action
 * @see Issue #10: Click-to-open-in-editor
 */

import {
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect-atom/atom-react/Hooks'
import type {
  PrComment,
  PrCommentReaction,
  ReviewFinding,
  ReviewSeverity,
} from '@laborer/shared/rpc'
import {
  AlertTriangle,
  ChevronRight,
  ClipboardCheck,
  FileCode,
  GitPullRequestClosed,
  MessageSquare,
  RefreshCw,
  Rocket,
  Search,
  ThumbsUp,
  Wrench,
  X,
} from 'lucide-react'
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { cn, extractErrorCode, extractErrorMessage } from '@/lib/utils'
import { useDiffScrollDispatch } from '@/panels/diff-scroll-context'
import { usePanelActions } from '@/panels/panel-context'

const addReactionMutation = LaborerClient.mutation('review.addReaction')
const removeReactionMutation = LaborerClient.mutation('review.removeReaction')
const fixFindingsMutation = LaborerClient.mutation('brrr.fix')
const editorOpenMutation = LaborerClient.mutation('editor.open')

/** Polling interval in milliseconds (30 seconds). */
const POLL_INTERVAL_MS = 30_000

interface ReviewPaneProps {
  readonly workspaceId: string
}

/**
 * Severity sort order: critical = 0, warning = 1, info = 2.
 * Lower number = higher priority = sorted first.
 */
const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

/**
 * Sort findings by severity: critical first, then warning, then info.
 */
function sortFindingsBySeverity(
  findings: readonly ReviewFinding[]
): readonly ReviewFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}

/**
 * Check whether a finding has a specific reaction type.
 */
function hasReaction(
  reactions: readonly PrCommentReaction[],
  content: string
): boolean {
  return reactions.some((r) => r.content === content)
}

function upsertReaction(
  reactions: readonly PrCommentReaction[],
  reaction: PrCommentReaction
): readonly PrCommentReaction[] {
  const withoutMatchingReaction = reactions.filter(
    (existingReaction) => existingReaction.content !== reaction.content
  )

  return [...withoutMatchingReaction, reaction]
}

type ReactionOverride =
  | {
      readonly type: 'remove'
    }
  | {
      readonly reaction: PrCommentReaction
      readonly type: 'upsert'
    }

function applyRocketReactionOverride(
  reactions: readonly PrCommentReaction[],
  override: ReactionOverride | undefined
): readonly PrCommentReaction[] {
  if (!override) {
    return reactions
  }

  if (override.type === 'remove') {
    return reactions.filter((reaction) => reaction.content !== 'rocket')
  }

  return upsertReaction(reactions, override.reaction)
}

/**
 * Whether a finding is "resolved" — has a thumbs_up (fixed) or confused
 * (won't-fix) reaction. Resolved findings are visually dimmed.
 */
function isResolved(reactions: readonly PrCommentReaction[]): boolean {
  return (
    hasReaction(reactions, 'thumbs_up') || hasReaction(reactions, 'confused')
  )
}

/**
 * Format a timestamp string into a short human-readable format.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Map error codes from the server to actionable guidance for the user.
 * Returns null if no specific guidance is available.
 */
function getErrorGuidance(errorCode: string | null): string | null {
  switch (errorCode) {
    case 'GH_AUTH_FAILED':
      return "Run 'gh auth login' in your terminal to authenticate with GitHub."
    case 'GH_RATE_LIMITED':
      return 'GitHub API rate limit exceeded. Wait a few minutes and try again.'
    case 'GH_COMMAND_FAILED':
      return "Ensure the GitHub CLI (gh) is installed and authenticated. Run 'gh auth login' if needed."
    default:
      return null
  }
}

/**
 * Renders a severity badge with appropriate color styling.
 * Colors match brrr's convention: red for critical, yellow for warning,
 * blue for info.
 */
function SeverityBadge({ severity }: { readonly severity: ReviewSeverity }) {
  const config: Record<ReviewSeverity, { label: string; className: string }> = {
    critical: {
      label: 'critical',
      className:
        'bg-red-500/10 text-red-600 dark:bg-red-500/20 dark:text-red-400',
    },
    warning: {
      label: 'warning',
      className:
        'bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400',
    },
    info: {
      label: 'info',
      className:
        'bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400',
    },
  }

  const { label, className } = config[severity]

  return (
    <Badge
      className={cn('border-0', className)}
      data-severity={severity}
      variant="outline"
    >
      {label}
    </Badge>
  )
}

/**
 * Renders reaction state indicators (rocket, thumbs-up, confused) for a finding.
 * Shows which findings are queued, fixed, or won't-fix.
 */
function ReactionIndicators({
  reactions,
}: {
  readonly reactions: readonly PrCommentReaction[]
}) {
  const queued = hasReaction(reactions, 'rocket')
  const fixed = hasReaction(reactions, 'thumbs_up')
  const wontFix = hasReaction(reactions, 'confused')

  if (!(queued || fixed || wontFix)) {
    return null
  }

  return (
    <div className="flex items-center gap-1" data-testid="reaction-indicators">
      {queued && (
        <span
          className="flex items-center gap-0.5 rounded bg-orange-500/10 px-1 py-0.5 text-orange-600 text-xs dark:bg-orange-500/20 dark:text-orange-400"
          data-testid="reaction-rocket"
          title="Queued for fix"
        >
          <Rocket className="size-3" />
        </span>
      )}
      {fixed && (
        <span
          className="flex items-center gap-0.5 rounded bg-green-500/10 px-1 py-0.5 text-green-600 text-xs dark:bg-green-500/20 dark:text-green-400"
          data-testid="reaction-thumbs-up"
          title="Fixed"
        >
          <ThumbsUp className="size-3" />
        </span>
      )}
      {wontFix && (
        <span
          className="flex items-center gap-0.5 rounded bg-gray-500/10 px-1 py-0.5 text-gray-500 text-xs dark:bg-gray-500/20 dark:text-gray-400"
          data-testid="reaction-confused"
          title="Won't fix"
        >
          😕
        </span>
      )}
    </div>
  )
}

/**
 * Renders a structured finding card with severity badge, file:line,
 * category tag, description, collapsible suggested fixes, checkbox for
 * triage selection, reaction state indicators, and an optional "Unqueue"
 * button for findings with a rocket reaction.
 */
function FindingCard({
  finding,
  isUnqueuing,
  onOpenFile,
  onToggleSelection,
  onUnqueue,
  selected,
}: {
  readonly finding: ReviewFinding
  readonly isUnqueuing?: boolean
  readonly onOpenFile: (filePath: string, line: number | null) => void
  readonly onToggleSelection: (finding: ReviewFinding) => void | Promise<void>
  readonly onUnqueue?: (finding: ReviewFinding) => void
  readonly selected: boolean
}) {
  const [fixesOpen, setFixesOpen] = useState(false)
  const hasSuggestedFixes = finding.suggestedFixes.length > 0
  const resolved = isResolved(finding.reactions)

  return (
    <div
      className={cn(
        'border-b px-3 py-2.5 last:border-b-0',
        selected && 'bg-accent/50',
        resolved && 'opacity-50'
      )}
      data-resolved={resolved || undefined}
      data-selected={selected || undefined}
      data-testid="finding-card"
    >
      <div className="flex items-start gap-2">
        <Checkbox
          aria-label={`Select finding: ${finding.id}`}
          checked={selected}
          className="mt-0.5 shrink-0"
          data-testid="finding-checkbox"
          onCheckedChange={() => {
            onToggleSelection(finding)
          }}
        />
        <div className="min-w-0 flex-1">
          {/* Top row: severity badge + category tag + reaction indicators */}
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={finding.severity} />
            {finding.category !== null && (
              <Badge className="border-0" variant="secondary">
                {finding.category}
              </Badge>
            )}
            <ReactionIndicators reactions={finding.reactions} />
            {/* Unqueue button for findings with rocket reaction */}
            {onUnqueue && hasReaction(finding.reactions, 'rocket') && (
              <Button
                aria-label={`Unqueue finding: ${finding.id}`}
                className="ml-auto h-5 gap-0.5 px-1.5 text-xs"
                data-testid="unqueue-button"
                disabled={isUnqueuing}
                onClick={() => onUnqueue(finding)}
                size="sm"
                variant="ghost"
              >
                <X className="size-3" />
                Unqueue
              </Button>
            )}
          </div>

          {/* File:line reference — clickable to open in editor */}
          <button
            className="mt-1 flex items-center gap-1 rounded text-muted-foreground text-xs underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="file-line-link"
            onClick={() => onOpenFile(finding.file, finding.line)}
            title={`Open ${finding.file}:${finding.line} in editor`}
            type="button"
          >
            <FileCode className="size-3 shrink-0" />
            <span className="truncate">
              {finding.file}:{finding.line}
            </span>
          </button>

          {/* Description */}
          <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed">
            {finding.description}
          </p>

          {/* Collapsible suggested fixes */}
          {hasSuggestedFixes && (
            <Collapsible onOpenChange={setFixesOpen} open={fixesOpen}>
              <CollapsibleTrigger
                className="mt-1.5 flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="suggested-fixes-trigger"
              >
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform duration-200',
                    fixesOpen && 'rotate-90'
                  )}
                />
                <span>
                  Suggested{' '}
                  {finding.suggestedFixes.length === 1 ? 'fix' : 'fixes'} (
                  {finding.suggestedFixes.length})
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200">
                <ul className="mt-1 ml-3 list-disc space-y-1 pl-2 text-xs leading-relaxed">
                  {finding.suggestedFixes.map((fix) => (
                    <li key={fix}>{fix}</li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Renders a single PR comment card with author info, body, and optional
 * file:line reference for inline review comments.
 */
function CommentCard({
  comment,
  onOpenFile,
}: {
  readonly comment: PrComment
  readonly onOpenFile: (filePath: string, line: number | null) => void
}) {
  const fileRef =
    comment.filePath !== null
      ? `${comment.filePath}${comment.line !== null ? `:${comment.line}` : ''}`
      : null

  return (
    <div className="border-b px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <Avatar size="sm">
          <AvatarImage
            alt={comment.authorLogin}
            src={comment.authorAvatarUrl}
          />
          <AvatarFallback>
            {comment.authorLogin.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-xs">{comment.authorLogin}</span>
            <span className="text-muted-foreground text-xs">
              {formatTimestamp(comment.createdAt)}
            </span>
          </div>
          {comment.filePath !== null && (
            <button
              className="mt-0.5 flex items-center gap-1 rounded text-muted-foreground text-xs underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="file-line-link"
              onClick={() =>
                onOpenFile(comment.filePath as string, comment.line)
              }
              title={`Open ${fileRef} in editor`}
              type="button"
            >
              <FileCode className="size-3 shrink-0" />
              <span className="truncate">{fileRef}</span>
            </button>
          )}
          <Markdown className="mt-1 text-xs leading-relaxed">
            {comment.body}
          </Markdown>
        </div>
      </div>
    </div>
  )
}

/**
 * A collapsible section with heading, count badge, and icon.
 */
function ReviewSection({
  children,
  count,
  defaultOpen = true,
  icon: Icon,
  title,
}: {
  readonly children: React.ReactNode
  readonly count: number
  readonly defaultOpen?: boolean
  readonly icon: React.ComponentType<{ className?: string }>
  readonly title: string
}) {
  const [expanded, setExpanded] = useState(defaultOpen)

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`section-trigger-${title.toLowerCase()}`}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-xs">{title}</span>
        <Badge className="ml-auto border-0" variant="secondary">
          {count}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Inner component that performs the RPC query and renders the result.
 * Must be wrapped in Suspense.
 *
 * Polls the server every 30 seconds via `useEffect` + `setInterval` calling
 * `useAtomRefresh`. The manual refresh button resets the polling timer so
 * that the next automatic poll is always 30s after the last fetch.
 */
function ReviewPaneContent({ workspaceId }: { readonly workspaceId: string }) {
  const reviewComments$ = useMemo(
    () => LaborerClient.query('review.fetchComments', { workspaceId }),
    [workspaceId]
  )
  const result = useAtomValue(reviewComments$)
  const refresh = useAtomRefresh(reviewComments$)

  // Ref to hold the interval ID so manual refresh can reset the timer.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** Start (or restart) the polling interval. */
  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
    }
    intervalRef.current = setInterval(refresh, POLL_INTERVAL_MS)
  }, [refresh])

  // Set up polling on mount, tear down on unmount.
  useEffect(() => {
    startPolling()
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [startPolling])

  /** Manual refresh: trigger an immediate fetch and reset the polling timer. */
  const handleManualRefresh = useCallback(() => {
    refresh()
    startPolling()
  }, [refresh, startPolling])
  // -----------------------------------------------------------------------
  // Selection state — local to this pane instance, not persisted.
  // Tracks commentIds of selected findings. Hooks must be called before
  // any early returns to satisfy the Rules of Hooks.
  // -----------------------------------------------------------------------
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set()
  )
  const [reactionOverrides, setReactionOverrides] = useState<
    ReadonlyMap<number, ReactionOverride>
  >(() => new Map())

  /** Toggle a single finding's selection state. */
  const handleToggleSelection = useCallback((commentId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(commentId)) {
        next.delete(commentId)
      } else {
        next.add(commentId)
      }
      return next
    })
  }, [])

  // Extract findings for select-all (empty array when no data yet).
  const findings =
    result._tag === 'Success' ? result.value.findings : ([] as const)
  const displayedFindings = useMemo(
    () =>
      findings.map((finding) => ({
        ...finding,
        reactions: applyRocketReactionOverride(
          finding.reactions,
          reactionOverrides.get(finding.commentId)
        ),
      })),
    [findings, reactionOverrides]
  )

  /** Select all findings. */
  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(findings.map((f) => f.commentId)))
  }, [findings])

  /** Deselect all findings. */
  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const selectedCount = selectedIds.size
  const allSelected = findings.length > 0 && selectedCount === findings.length

  // -----------------------------------------------------------------------
  // Mutation hooks for rocket reactions, brrr fix, and editor open.
  // -----------------------------------------------------------------------
  const addReaction = useAtomSet(addReactionMutation, { mode: 'promise' })
  const removeReaction = useAtomSet(removeReactionMutation, { mode: 'promise' })
  const fixFindings = useAtomSet(fixFindingsMutation, { mode: 'promise' })
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })
  const panelActions = usePanelActions()
  const scrollDiffToFile = useDiffScrollDispatch()

  // Ref to avoid stale closures in the onOpenFile callback passed to cards.
  const openEditorRef = useRef(openEditor)
  openEditorRef.current = openEditor

  const [isFixing, setIsFixing] = useState(false)
  const [unqueuingCommentId, setUnqueuingCommentId] = useState<number | null>(
    null
  )

  /**
   * Fix Selected: ensure selected findings are queued, then kick off `brrr fix`.
   */
  const handleFixSelected = useCallback(async () => {
    setIsFixing(true)
    try {
      const unqueuedSelectedFindings = displayedFindings.filter(
        (finding) =>
          selectedIds.has(finding.commentId) &&
          !hasReaction(finding.reactions, 'rocket')
      )

      await Promise.all(
        unqueuedSelectedFindings.map((finding) =>
          addReaction({
            payload: {
              workspaceId,
              commentId: finding.commentId,
              content: 'rocket',
            },
          })
        )
      )

      const result = await fixFindings({
        payload: { workspaceId },
      })
      toast.success('Fix started')
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId)
      }

      // Clear selection and refresh to show updated reaction state
      setSelectedIds(new Set())
      refresh()
      startPolling()
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      const code = extractErrorCode(error)
      const guidance = getErrorGuidance(code ?? null)
      toast.error('Failed to start fix', {
        description: guidance ?? message,
      })
    } finally {
      setIsFixing(false)
    }
  }, [
    addReaction,
    displayedFindings,
    fixFindings,
    panelActions,
    refresh,
    selectedIds,
    startPolling,
    workspaceId,
  ])

  const handleQueueFinding = useCallback(
    async (finding: ReviewFinding) => {
      const temporaryReaction: PrCommentReaction = {
        id: -finding.commentId,
        content: 'rocket',
        userId: 0,
      }

      setSelectedIds((prev) => new Set(prev).add(finding.commentId))
      setReactionOverrides((prev) => {
        const next = new Map(prev)
        next.set(finding.commentId, {
          type: 'upsert',
          reaction: temporaryReaction,
        })
        return next
      })

      try {
        const createdReaction = await addReaction({
          payload: {
            workspaceId,
            commentId: finding.commentId,
            content: 'rocket',
          },
        })

        setReactionOverrides((prev) => {
          const next = new Map(prev)
          next.set(finding.commentId, {
            type: 'upsert',
            reaction: createdReaction,
          })
          return next
        })
      } catch (error: unknown) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.delete(finding.commentId)
          return next
        })
        setReactionOverrides((prev) => {
          const next = new Map(prev)
          next.delete(finding.commentId)
          return next
        })

        const message = extractErrorMessage(error)
        const code = extractErrorCode(error)
        const guidance = getErrorGuidance(code ?? null)
        toast.error('Failed to queue finding', {
          description: guidance ?? message,
        })
      }
    },
    [addReaction, workspaceId]
  )

  const handleToggleFindingSelection = useCallback(
    async (finding: ReviewFinding) => {
      if (selectedIds.has(finding.commentId)) {
        handleToggleSelection(finding.commentId)
        return
      }

      if (hasReaction(finding.reactions, 'rocket')) {
        handleToggleSelection(finding.commentId)
        return
      }

      await handleQueueFinding(finding)
    },
    [handleQueueFinding, handleToggleSelection, selectedIds]
  )

  /**
   * Unqueue: remove the rocket reaction from a single finding.
   */
  const handleUnqueue = useCallback(
    async (finding: ReviewFinding) => {
      const rocketReaction = finding.reactions.find(
        (r) => r.content === 'rocket'
      )
      if (!rocketReaction) {
        return
      }

      setUnqueuingCommentId(finding.commentId)
      setReactionOverrides((prev) => {
        const next = new Map(prev)
        next.set(finding.commentId, { type: 'remove' })
        return next
      })
      try {
        await removeReaction({
          payload: {
            workspaceId,
            commentId: finding.commentId,
            reactionId: rocketReaction.id,
          },
        })
        toast.success('Finding unqueued')
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.delete(finding.commentId)
          return next
        })
        refresh()
        startPolling()
      } catch (error: unknown) {
        setReactionOverrides((prev) => {
          const next = new Map(prev)
          next.set(finding.commentId, {
            type: 'upsert',
            reaction: rocketReaction,
          })
          return next
        })
        const message = extractErrorMessage(error)
        const code = extractErrorCode(error)
        const guidance = getErrorGuidance(code ?? null)
        toast.error('Failed to unqueue', {
          description: guidance ?? message,
        })
      } finally {
        setUnqueuingCommentId(null)
      }
    },
    [refresh, removeReaction, startPolling, workspaceId]
  )

  /**
   * Open a file in the user's configured editor via the `editor.open` RPC,
   * and dispatch a cross-pane scroll event to any open diff pane for the
   * same workspace so it scrolls to the matching file and line.
   */
  const handleOpenFile = useCallback(
    async (filePath: string, line: number | null) => {
      // Dispatch scroll event to any open diff pane for this workspace
      if (line !== null) {
        scrollDiffToFile(workspaceId, filePath, line)
      }

      try {
        await openEditorRef.current({
          payload: { workspaceId, filePath },
        })
        toast.success(`Opened ${filePath} in editor`)
      } catch (error: unknown) {
        toast.error(`Failed to open file: ${extractErrorMessage(error)}`)
      }
    },
    [scrollDiffToFile, workspaceId]
  )

  // Determine whether we're in the initial loading state (no data yet)
  // vs. a background refresh (has data, `waiting` is true).
  const isInitialLoading =
    result._tag === 'Initial' || (result._tag !== 'Success' && result.waiting)
  const isRefreshing = result._tag === 'Success' && result.waiting

  // Initial loading state — full-screen spinner, no data yet
  if (isInitialLoading) {
    return (
      <>
        <ReviewPaneHeader
          isRefreshing={false}
          onRefresh={handleManualRefresh}
        />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Spinner className="size-5" />
            <span className="text-xs">Loading comments...</span>
          </div>
        </div>
      </>
    )
  }

  // Error state
  if (result._tag === 'Failure') {
    const errorCode = extractErrorCode(result.cause)
    const errorMessage = extractErrorMessage(result.cause)

    // No PR exists for this workspace
    if (errorCode === 'PR_NOT_FOUND') {
      return (
        <>
          <ReviewPaneHeader
            isRefreshing={false}
            onRefresh={handleManualRefresh}
          />
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia>
                <GitPullRequestClosed className="size-8 opacity-50" />
              </EmptyMedia>
              <EmptyTitle>No pull request</EmptyTitle>
              <EmptyDescription>
                No pull request was found for this workspace's branch. Create a
                PR to see review findings and comments.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      )
    }

    // Actionable error guidance based on error code
    const errorGuidance = getErrorGuidance(errorCode ?? null)

    // Other errors
    return (
      <>
        <ReviewPaneHeader
          isRefreshing={false}
          onRefresh={handleManualRefresh}
        />
        <div className="p-3">
          <Alert variant="destructive">
            <AlertTriangle className="size-3.5" />
            <AlertTitle>Failed to load comments</AlertTitle>
            <AlertDescription>
              <p>{errorMessage}</p>
              {errorGuidance && (
                <p className="mt-1 font-medium text-xs">{errorGuidance}</p>
              )}
            </AlertDescription>
          </Alert>
        </div>
      </>
    )
  }

  const { comments } = result.value

  // Empty state — PR exists but has no comments or findings
  if (comments.length === 0 && findings.length === 0) {
    return (
      <>
        <ReviewPaneHeader
          isRefreshing={isRefreshing}
          onRefresh={handleManualRefresh}
        />
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia>
              <ClipboardCheck className="size-8 opacity-50" />
            </EmptyMedia>
            <EmptyTitle>No comments yet</EmptyTitle>
            <EmptyDescription>
              This pull request has no review comments or findings. Run a review
              or wait for collaborators to leave feedback.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const sortedFindings = sortFindingsBySeverity(displayedFindings)

  return (
    <>
      <ReviewPaneHeader
        isRefreshing={isRefreshing}
        onRefresh={handleManualRefresh}
      />
      {findings.length > 0 && (
        <ReviewActionsBar
          allSelected={allSelected}
          findingsCount={findings.length}
          isFixing={isFixing}
          onDeselectAll={handleDeselectAll}
          {...(findings.length > 0 ? { onFixSelected: handleFixSelected } : {})}
          onSelectAll={handleSelectAll}
          selectedCount={selectedCount}
        />
      )}
      <ScrollArea className="flex-1">
        {/* Findings section */}
        {findings.length > 0 && (
          <ReviewSection count={findings.length} icon={Search} title="Findings">
            {sortedFindings.map((finding) => (
              <FindingCard
                finding={finding}
                isUnqueuing={unqueuingCommentId === finding.commentId}
                key={finding.commentId}
                onOpenFile={handleOpenFile}
                onToggleSelection={handleToggleFindingSelection}
                onUnqueue={handleUnqueue}
                selected={selectedIds.has(finding.commentId)}
              />
            ))}
          </ReviewSection>
        )}

        {/* Comments section */}
        {comments.length > 0 && (
          <ReviewSection
            count={comments.length}
            icon={MessageSquare}
            title="Comments"
          >
            {comments.map((comment) => (
              <CommentCard
                comment={comment}
                key={comment.id}
                onOpenFile={handleOpenFile}
              />
            ))}
          </ReviewSection>
        )}
      </ScrollArea>
    </>
  )
}

/**
 * The review pane header — combines the "Review" title with refresh controls.
 * Replaces the old static header + separate ReviewHeaderBar refresh row.
 */
function ReviewPaneHeader({
  isRefreshing,
  onRefresh,
}: {
  readonly isRefreshing: boolean
  readonly onRefresh: () => void
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3">
      <ClipboardCheck className="size-3.5 text-muted-foreground" />
      <span className="font-medium text-muted-foreground text-xs">Review</span>
      <div className="ml-auto flex items-center gap-1">
        {isRefreshing && (
          <div
            className="flex items-center gap-1 text-muted-foreground text-xs"
            data-testid="refresh-indicator"
          >
            <RefreshCw className="size-3 animate-spin" />
            <span>Refreshing...</span>
          </div>
        )}
        <Button
          aria-label="Refresh comments"
          className="size-6"
          data-testid="refresh-button"
          onClick={onRefresh}
          size="icon"
          variant="ghost"
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>
    </div>
  )
}

/**
 * Selection/actions bar for findings. Only rendered when there are findings
 * with selection controls.
 */
function ReviewActionsBar({
  allSelected = false,
  findingsCount = 0,
  isFixing = false,
  onDeselectAll,
  onFixSelected,
  onSelectAll,
  selectedCount,
}: {
  readonly allSelected?: boolean
  readonly findingsCount?: number
  readonly isFixing?: boolean
  readonly onDeselectAll?: () => void
  readonly onFixSelected?: () => void | Promise<void>
  readonly onSelectAll?: () => void
  readonly selectedCount: number
}) {
  return (
    <div className="flex h-8 shrink-0 items-center border-b bg-muted/30 px-3">
      <div className="flex flex-1 items-center gap-1.5">
        {/* Selected count + select all/deselect all */}
        {findingsCount > 0 && onSelectAll && onDeselectAll && (
          <div
            className="flex items-center gap-1.5"
            data-testid="selection-controls"
          >
            <Button
              className="h-5 px-1.5 text-xs"
              data-testid="select-toggle-button"
              onClick={allSelected ? onDeselectAll : onSelectAll}
              size="sm"
              variant="ghost"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </Button>
            {selectedCount > 0 && (
              <span
                className="text-muted-foreground text-xs"
                data-testid="selected-count"
              >
                {selectedCount} selected
              </span>
            )}
          </div>
        )}
        {/* Show selected count even when no select all/deselect all controls */}
        {(findingsCount === 0 || !onSelectAll) && selectedCount > 0 && (
          <span
            className="text-muted-foreground text-xs"
            data-testid="selected-count"
          >
            {selectedCount} selected
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {/* Fix Selected button */}
        {onFixSelected && (
          <Button
            aria-label={`Fix ${selectedCount} selected finding${selectedCount === 1 ? '' : 's'}`}
            className="h-5 gap-1 px-1.5 text-xs"
            data-testid="fix-selected-button"
            disabled={selectedCount === 0 || isFixing}
            onClick={onFixSelected}
            size="sm"
            variant="ghost"
          >
            <Wrench className="size-3" />
            Fix{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
        )}
      </div>
    </div>
  )
}

function ReviewPane({ workspaceId }: ReviewPaneProps) {
  return (
    <div className="flex h-full w-full flex-col">
      <Suspense
        fallback={
          <>
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3">
              <ClipboardCheck className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-muted-foreground text-xs">
                Review
              </span>
            </div>
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Spinner className="size-5" />
                <span className="text-xs">Loading comments...</span>
              </div>
            </div>
          </>
        }
      >
        <ReviewPaneContent workspaceId={workspaceId} />
      </Suspense>
    </div>
  )
}

export { ReviewPane }
