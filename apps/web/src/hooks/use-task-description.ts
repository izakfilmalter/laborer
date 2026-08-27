/**
 * The description of the card a workspace is doing the work of.
 *
 * A non-root workspace is projected from the task that owns its worktree, so
 * the two share an id and the description is one lookup away — the same lookup
 * the edit button makes to open the editor. Null covers a root workspace,
 * which is a checkout rather than a piece of work and has no card to describe.
 */

import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { taskCollection } from '@/db/shared-state'

function useTaskDescription(workspaceId: string): string | null {
  const { data: taskRows } = useLiveQuery(
    (query) =>
      query
        .from({ tasks: taskCollection })
        .where(({ tasks }) => eq(tasks.id, workspaceId)),
    [workspaceId]
  )

  return taskRows[0]?.description ?? null
}

export { useTaskDescription }
