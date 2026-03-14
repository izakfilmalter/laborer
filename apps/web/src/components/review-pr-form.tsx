/**
 * Review PR button component.
 *
 * A button that triggers a PR review in the workspace. The server
 * auto-detects the PR number for the workspace's branch using `gh pr view`.
 * If no PR exists for the branch, the server returns an error which is
 * displayed via a toast.
 *
 * On success, the spawned terminal is auto-assigned to a panel pane so the
 * user immediately sees the brrr TUI output in xterm.js.
 *
 * @see Issue #97: "Review PR" button + PR number input
 * @see Issue #96: brrr.review RPC handler
 */

import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Eye } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'

const reviewPrMutation = LaborerClient.mutation('brrr.review')

interface ReviewPrFormProps {
  /** Disable the button (e.g., when no PR exists for the branch). */
  readonly disabled?: boolean
  readonly onTerminalSpawned?: () => void
  readonly projectId: string
  readonly workspaceId: string
}

function ReviewPrForm({
  projectId,
  workspaceId,
  onTerminalSpawned,
  disabled,
}: ReviewPrFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const reviewPr = useAtomSet(reviewPrMutation, { mode: 'promise' })
  const panelActions = usePanelActions()
  const configGet$ = useMemo(
    () =>
      LaborerClient.query(
        'config.get',
        { projectId },
        { reactivityKeys: ConfigReactivityKeys }
      ),
    [projectId]
  )
  const configResult = useAtomValue(configGet$)
  const autoOpenDevServer =
    configResult._tag === 'Success'
      ? configResult.value.devServer.autoOpen.value
      : false

  const handleClick = useCallback(async () => {
    setIsSubmitting(true)
    try {
      const result = await reviewPr({
        payload: { workspaceId },
      })
      toast.success('Review started')
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId, undefined, {
          autoOpenDevServer,
        })
      }
      onTerminalSpawned?.()
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(`Failed to start PR review: ${message}`)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    autoOpenDevServer,
    workspaceId,
    reviewPr,
    panelActions,
    onTerminalSpawned,
  ])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Review PR"
            disabled={disabled || isSubmitting}
            onClick={handleClick}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Eye className="size-3.5 text-chart-4" />
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? 'No PR found for this branch' : 'Review PR'}
      </TooltipContent>
    </Tooltip>
  )
}

export { ReviewPrForm }
