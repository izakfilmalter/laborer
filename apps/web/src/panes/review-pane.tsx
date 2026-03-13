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
 * Handles loading, empty (no PR), and error states.
 *
 * @see docs/review-findings-panel/PRD-review-findings-panel.md
 * @see Issue #5: Grouped display with severity badges
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import type {
  PrComment,
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
  Search,
} from 'lucide-react'
import { Suspense, useMemo, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { cn, extractErrorCode, extractErrorMessage } from '@/lib/utils'

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
 * Renders a structured finding card with severity badge, file:line,
 * category tag, description, and collapsible suggested fixes.
 */
function FindingCard({ finding }: { readonly finding: ReviewFinding }) {
  const [fixesOpen, setFixesOpen] = useState(false)
  const hasSuggestedFixes = finding.suggestedFixes.length > 0

  return (
    <div
      className="border-b px-3 py-2.5 last:border-b-0"
      data-testid="finding-card"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Top row: severity badge + category tag */}
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={finding.severity} />
            {finding.category !== null && (
              <Badge className="border-0" variant="secondary">
                {finding.category}
              </Badge>
            )}
          </div>

          {/* File:line reference */}
          <div className="mt-1 flex items-center gap-1 text-muted-foreground text-xs">
            <FileCode className="size-3 shrink-0" />
            <span className="truncate">
              {finding.file}:{finding.line}
            </span>
          </div>

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
              <CollapsibleContent>
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
function CommentCard({ comment }: { readonly comment: PrComment }) {
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
            <div className="mt-0.5 flex items-center gap-1 text-muted-foreground text-xs">
              <FileCode className="size-3 shrink-0" />
              <span className="truncate">
                {comment.filePath}
                {comment.line !== null ? `:${comment.line}` : ''}
              </span>
            </div>
          )}
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
            {comment.body}
          </p>
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
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Inner component that performs the RPC query and renders the result.
 * Must be wrapped in Suspense.
 */
function ReviewPaneContent({ workspaceId }: { readonly workspaceId: string }) {
  const reviewComments$ = useMemo(
    () => LaborerClient.query('review.fetchComments', { workspaceId }),
    [workspaceId]
  )
  const result = useAtomValue(reviewComments$)

  // Loading state
  if (result._tag === 'Initial' || result.waiting) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Spinner className="size-5" />
          <span className="text-xs">Loading comments...</span>
        </div>
      </div>
    )
  }

  // Error state
  if (result._tag === 'Failure') {
    const errorCode = extractErrorCode(result.cause)
    const errorMessage = extractErrorMessage(result.cause)

    // No PR exists for this workspace
    if (errorCode === 'PR_NOT_FOUND') {
      return (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia>
              <GitPullRequestClosed className="size-8 opacity-50" />
            </EmptyMedia>
            <EmptyTitle>No pull request</EmptyTitle>
            <EmptyDescription>
              No pull request was found for this workspace's branch. Create a PR
              to see review findings and comments.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    }

    // Other errors
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <AlertTriangle className="size-3.5" />
          <AlertTitle>Failed to load comments</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const { comments, findings } = result.value

  // Empty state — PR exists but has no comments or findings
  if (comments.length === 0 && findings.length === 0) {
    return (
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
    )
  }

  const sortedFindings = sortFindingsBySeverity(findings)

  return (
    <ScrollArea className="flex-1">
      {/* Findings section */}
      {findings.length > 0 && (
        <ReviewSection count={findings.length} icon={Search} title="Findings">
          {sortedFindings.map((finding) => (
            <FindingCard finding={finding} key={finding.commentId} />
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
            <CommentCard comment={comment} key={comment.id} />
          ))}
        </ReviewSection>
      )}
    </ScrollArea>
  )
}

function ReviewPane({ workspaceId }: ReviewPaneProps) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3">
        <ClipboardCheck className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-muted-foreground text-xs">
          Review
        </span>
      </div>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Spinner className="size-5" />
              <span className="text-xs">Loading comments...</span>
            </div>
          </div>
        }
      >
        <ReviewPaneContent workspaceId={workspaceId} />
      </Suspense>
    </div>
  )
}

export { ReviewPane }
