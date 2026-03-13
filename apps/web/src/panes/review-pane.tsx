/**
 * Review pane — displays PR review findings and comments from GitHub.
 *
 * This is currently a placeholder component that renders the workspace ID
 * and a "Review" heading. Data fetching and structured display will be
 * added in subsequent issues.
 *
 * @see docs/review-findings-panel/PRD-review-findings-panel.md
 * @see Issue #1: Review pane type + panel system wiring
 */

import { ClipboardCheck } from 'lucide-react'

interface ReviewPaneProps {
  readonly workspaceId: string
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
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center text-muted-foreground">
          <ClipboardCheck className="mx-auto mb-2 size-8 opacity-50" />
          <p className="font-medium text-sm">Review Findings</p>
          <p className="mt-1 text-xs opacity-70">Workspace: {workspaceId}</p>
        </div>
      </div>
    </div>
  )
}

export { ReviewPane }
