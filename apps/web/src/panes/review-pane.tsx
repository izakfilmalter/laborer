/**
 * Review pane — displays PR review findings and comments from GitHub.
 *
 * Fetches comments via the `review.fetchComments` RPC on mount and renders
 * them as a flat list. Each comment shows author avatar, login, body, and
 * file:line for inline review comments. Handles loading, empty (no PR),
 * and error states.
 *
 * @see docs/review-findings-panel/PRD-review-findings-panel.md
 * @see Issue #3: Review pane renders fetched comments
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { PrComment } from '@laborer/shared/rpc'
import {
  AlertTriangle,
  ClipboardCheck,
  FileCode,
  GitPullRequestClosed,
} from 'lucide-react'
import { Suspense, useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { extractErrorCode, extractErrorMessage } from '@/lib/utils'

interface ReviewPaneProps {
  readonly workspaceId: string
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
  const allComments = comments

  // Empty state — PR exists but has no comments or findings
  if (allComments.length === 0 && findings.length === 0) {
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

  return (
    <ScrollArea className="flex-1">
      {allComments.map((comment) => (
        <CommentCard comment={comment} key={comment.id} />
      ))}
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
