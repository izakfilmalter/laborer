/**
 * Commits a manual project order from the sidebar tree or the kanban lanes.
 *
 * A move installs the optimistic ranks first — the list settles under the
 * pointer immediately — and then writes each one with the narrow revision-CAS
 * `project.move`. Because the rank lives on the project row, two windows
 * dragging different projects no longer collide at all; only a genuine
 * conflict on the same project fails, and that reverts with a toast rather
 * than leaving the list lying about where the project sits.
 *
 * Almost every drag plans a single write. A plan only grows when the
 * neighbours a project lands between hold the same rank and the whole list has
 * to be spaced out, which is why the writes are issued together and reverted
 * together.
 *
 * @see apps/web/src/atoms/project-order.ts — the ordering rules
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearProjectRankOverlaysAtom,
  installProjectRankOverlaysAtom,
  type ProjectRankAssignment,
  type ProjectRankOverlays,
  planProjectMove,
  planProjectNudge,
} from '@/atoms/project-order'
import { projectRowsAtom } from '@/atoms/shared-state'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

const moveProjectMutation = LaborerClient.mutation('project.move')

export interface ProjectReorder {
  /** Drops `movedProjectId` onto the slot held by `targetProjectId`. */
  readonly moveProject: (
    movedProjectId: string,
    targetProjectId: string
  ) => void
  /** Moves a project one slot up (-1) or down (+1) for keyboard reordering. */
  readonly nudgeProject: (projectId: string, delta: number) => void
  /** The project ids in their current order, top to bottom. */
  readonly projectIds: readonly string[]
}

export function useProjectReorder(): ProjectReorder {
  const projects = useAtomValue(projectRowsAtom)
  const moveProjectRank = useAtomSet(moveProjectMutation, { mode: 'promise' })
  const installOverlays = useAtomSet(installProjectRankOverlaysAtom)
  const clearOverlays = useAtomSet(clearProjectRankOverlaysAtom)

  const projectIds = projects.map(({ id }) => id)

  const commit = (plan: readonly ProjectRankAssignment[]) => {
    if (plan.length === 0) {
      return
    }
    const revisions = new Map(
      projects.map(({ id, revision }) => [id, revision])
    )
    const writes = plan.flatMap((assignment) => {
      const expectedRevision = revisions.get(assignment.projectId)
      return expectedRevision === undefined
        ? []
        : [{ ...assignment, expectedRevision }]
    })
    if (writes.length === 0) {
      return
    }

    const dragId = crypto.randomUUID()
    const overlays: ProjectRankOverlays = new Map(
      writes.map(({ expectedRevision, projectId, sortOrder }) => [
        projectId,
        { dragId, expectedRevision, sortOrder },
      ])
    )
    installOverlays(overlays)

    Promise.all(
      writes.map(({ expectedRevision, projectId, sortOrder }) =>
        moveProjectRank({
          payload: {
            expectedRevision,
            mutationId: crypto.randomUUID(),
            projectId,
            sortOrder,
          },
        })
      )
    ).catch((error: unknown) => {
      clearOverlays(dragId)
      toast.error('Could not save the project order', {
        description: extractErrorMessage(error),
      })
    })
  }

  return {
    moveProject: (movedProjectId, targetProjectId) => {
      commit(planProjectMove(projects, movedProjectId, targetProjectId))
    },
    nudgeProject: (projectId, delta) => {
      commit(planProjectNudge(projects, projectId, delta))
    },
    projectIds,
  }
}
