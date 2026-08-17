/**
 * Commits a manual project order from the sidebar tree or the kanban lanes.
 *
 * A move installs the optimistic ranks first — the list settles under the
 * pointer immediately — and then writes all assignments with one atomic
 * revision-CAS `project.reorder`. A genuine conflict rolls the whole plan back
 * with a toast rather than leaving a partially durable order.
 *
 * Almost every drag plans a single write. A plan only grows when the
 * neighbours a project lands between hold the same rank and the whole list has
 * to be spaced out, which is why the writes are issued together and reverted
 * together.
 *
 * @see apps/web/src/atoms/project-order.ts — the ordering rules
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { useLiveQuery } from '@tanstack/react-db'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  type ProjectRankAssignment,
  planProjectMove,
  planProjectNudge,
} from '@/atoms/project-order'
import { reorderProjects as reorderProjectsOptimistically } from '@/db/shared-mutations'
import { orderedProjectsFromRows, projectCollection } from '@/db/shared-state'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

const reorderProjectsMutation = LaborerClient.mutation('project.reorder')

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
  const { data: projectRows } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const projects = orderedProjectsFromRows(projectRows)
  const reorderProjects = useAtomSet(reorderProjectsMutation, {
    mode: 'promise',
  })

  const projectIds = projects.map(({ id }) => id)

  const commit = (plan: readonly ProjectRankAssignment[]) => {
    if (plan.length === 0) {
      return
    }
    reorderProjectsOptimistically({
      assignments: plan,
      operationId: crypto.randomUUID(),
      send: (payload) => reorderProjects({ payload }),
    }).catch((error: unknown) => {
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
