/**
 * Go back to the Slack thread a piece of work came from.
 *
 * Work that started in Slack keeps its thread as the place the conversation
 * still happens, so every surface showing that work — the board card, the
 * sidebar's workspace card, and the open workspace's frame header — offers the
 * same one-click way back. Tasks with no Slack origin render nothing rather
 * than a dead control.
 *
 * `SlackThreadButton` is the control itself, for callers already holding the
 * permalink. `OpenSlackThreadButton` resolves it from the task backing a
 * workspace, which shares the workspace's id.
 */

import { Button } from '@laborer/ui/components/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { Slack } from 'lucide-react'
import { taskCollection } from '@/db/shared-state'
import { localApi } from '@/lib/local-api'

function SlackThreadButton({
  iconClassName = 'text-muted-foreground',
  size = 'icon-xs',
  slackPermalink,
}: {
  /** Icon tint, matched to the surrounding control cluster. */
  readonly iconClassName?: string | undefined
  /** Button size, matched to the surrounding control cluster. */
  readonly size?: 'icon-xs' | 'icon-sm' | undefined
  readonly slackPermalink: string | null | undefined
}) {
  if (!slackPermalink) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open Slack thread"
            onClick={(event) => {
              // Cards activate on body click; this control is not that.
              event.stopPropagation()
              localApi.openExternal(slackPermalink)
            }}
            size={size}
            variant="ghost"
          />
        }
      >
        <Slack className={cn('size-3.5', iconClassName)} />
      </TooltipTrigger>
      <TooltipContent>Open Slack thread</TooltipContent>
    </Tooltip>
  )
}

function OpenSlackThreadButton({
  iconClassName,
  size,
  workspaceId,
}: {
  readonly iconClassName?: string | undefined
  readonly size?: 'icon-xs' | 'icon-sm' | undefined
  readonly workspaceId: string
}) {
  const { data: taskRows } = useLiveQuery(
    (query) =>
      query
        .from({ tasks: taskCollection })
        .where(({ tasks }) => eq(tasks.id, workspaceId)),
    [workspaceId]
  )

  return (
    <SlackThreadButton
      iconClassName={iconClassName}
      size={size}
      slackPermalink={taskRows[0]?.slackPermalink}
    />
  )
}

export { OpenSlackThreadButton, SlackThreadButton }
