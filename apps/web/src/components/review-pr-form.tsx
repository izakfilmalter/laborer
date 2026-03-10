/**
 * Review PR button component.
 *
 * A button that triggers a PR review in the workspace. The server
 * auto-detects the PR number for the workspace's branch using `gh pr view`.
 * If no PR exists for the branch, the server returns an error which is
 * displayed via a toast.
 *
 * On success, the spawned terminal is auto-assigned to a panel pane so the
 * user immediately sees the rlph TUI output in xterm.js.
 *
 * @see Issue #97: "Review PR" button + PR number input
 * @see Issue #96: rlph.review RPC handler
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { Eye } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'

const reviewPrMutation = LaborerClient.mutation('rlph.review')

interface ReviewPrFormProps {
  readonly onTerminalSpawned?: () => void
  readonly workspaceId: string
}

function ReviewPrForm({ workspaceId, onTerminalSpawned }: ReviewPrFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const reviewPr = useAtomSet(reviewPrMutation, { mode: 'promise' })
  const panelActions = usePanelActions()

  const handleClick = useCallback(async () => {
    setIsSubmitting(true)
    try {
      const result = await reviewPr({
        payload: { workspaceId },
      })
      toast.success('Review started')
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId)
      }
      onTerminalSpawned?.()
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(`Failed to start PR review: ${message}`)
    } finally {
      setIsSubmitting(false)
    }
  }, [workspaceId, reviewPr, panelActions, onTerminalSpawned])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Review PR"
            disabled={isSubmitting}
            onClick={handleClick}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Eye className="size-3.5 text-chart-4" />
      </TooltipTrigger>
      <TooltipContent>Review PR</TooltipContent>
    </Tooltip>
  )
}

export { ReviewPrForm }
