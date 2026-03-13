/**
 * Fix Findings button component.
 *
 * A button that triggers fixing review findings on a pull request in a
 * workspace. The server auto-detects the PR number for the workspace's
 * branch using `gh pr view`. If no PR exists for the branch, the server
 * returns an error which is displayed via a toast.
 *
 * On success, the spawned terminal is auto-assigned to a panel pane so the
 * user immediately sees the brrr TUI output in xterm.js.
 *
 * @see Issue #99: "Fix Findings" button + PR number input
 * @see Issue #98: brrr.fix RPC handler
 */

import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Wrench } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'

const fixFindingsMutation = LaborerClient.mutation('brrr.fix')

interface FixFindingsFormProps {
  /** Disable the button (e.g., when no PR exists for the branch). */
  readonly disabled?: boolean
  readonly onTerminalSpawned?: () => void
  readonly projectId: string
  readonly workspaceId: string
}

function FixFindingsForm({
  projectId,
  workspaceId,
  onTerminalSpawned,
  disabled,
}: FixFindingsFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fixFindings = useAtomSet(fixFindingsMutation, { mode: 'promise' })
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
      const result = await fixFindings({
        payload: { workspaceId },
      })
      toast.success('Fix started')
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId, undefined, {
          autoOpenDevServer,
        })
      }
      onTerminalSpawned?.()
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(`Failed to start fix: ${message}`)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    autoOpenDevServer,
    workspaceId,
    fixFindings,
    panelActions,
    onTerminalSpawned,
  ])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Fix Findings"
            disabled={disabled || isSubmitting}
            onClick={handleClick}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Wrench className="size-3.5 text-warning" />
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? 'No PR found for this branch' : 'Fix Findings'}
      </TooltipContent>
    </Tooltip>
  )
}

export { FixFindingsForm }
