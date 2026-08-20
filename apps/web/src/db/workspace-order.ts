import type { WorkspaceView } from '@/db/shared-state'

/**
 * Sidebar presentation order: oldest Workspace at the top, newest at the
 * bottom. The Kanban board ranks cards by drag order (`sortOrder`), while the
 * sidebar tree stays a stable creation-ordered list rather than inheriting the
 * arrival order of the task collection. `createdAt` is a numeric epoch carried
 * as a string; ties fall back to the time-ordered task ULID.
 */
export const orderedWorkspaceViews = <
  W extends Pick<WorkspaceView, 'createdAt' | 'id'>,
>(
  workspaces: readonly W[]
): readonly W[] =>
  [...workspaces].sort((left, right) => {
    const leftCreatedAt = Number(left.createdAt)
    const rightCreatedAt = Number(right.createdAt)
    const byCreatedAt =
      Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)
        ? leftCreatedAt - rightCreatedAt
        : 0
    return byCreatedAt || left.id.localeCompare(right.id)
  })
