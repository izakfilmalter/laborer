/**
 * Edit the card a workspace is doing the work of.
 *
 * A non-root workspace is projected from the task that owns its worktree, so
 * the two share an id and the card is one lookup away. Every surface that
 * shows a workspace — the sidebar card and the open workspace's frame header —
 * reaches the same description editor through this button, so "edit the card"
 * means one thing wherever it is clicked.
 *
 * Renders nothing when no task backs the workspace, which is the case for a
 * root workspace: a checkout is not a piece of work and has no card to name.
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
import { Pencil } from 'lucide-react'
import { boardTaskFromSharedRow } from '@/components/kanban/board-data'
import { useTaskEditor } from '@/components/kanban/task-editor'
import { taskCollection } from '@/db/shared-state'

function EditTaskCardButton({
  branchName,
  iconClassName = 'text-muted-foreground',
  size = 'icon-xs',
  workspaceId,
}: {
  readonly branchName: string
  /** Icon tint, matched to the surrounding control cluster. */
  readonly iconClassName?: string
  /** Button size, matched to the surrounding control cluster. */
  readonly size?: 'icon-xs' | 'icon-sm'
  readonly workspaceId: string
}) {
  const { data: taskRows } = useLiveQuery(
    (query) =>
      query
        .from({ tasks: taskCollection })
        .where(({ tasks }) => eq(tasks.id, workspaceId)),
    [workspaceId]
  )
  const taskRow = taskRows[0]
  const task = taskRow === undefined ? null : boardTaskFromSharedRow(taskRow)
  const { openTaskEditor, taskEditor } = useTaskEditor(task ? [task] : [])

  if (task === null) {
    return null
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Edit card for ${branchName}`}
              onClick={() => openTaskEditor(task)}
              size={size}
              variant="ghost"
            />
          }
        >
          <Pencil className={cn('size-3.5', iconClassName)} />
        </TooltipTrigger>
        <TooltipContent>Edit card</TooltipContent>
      </Tooltip>
      {taskEditor}
    </>
  )
}

export { EditTaskCardButton }
