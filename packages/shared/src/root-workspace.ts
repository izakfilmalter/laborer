/**
 * Root workspace identity — the project's main git checkout as a workspace.
 *
 * The main checkout is deliberately never a task row: the worktree
 * reconciler skips `isMain` worktrees so the board never grows a card for
 * it. The UI still presents it as a workspace — pinned to the top of the
 * sidebar — so both sides synthesize it from the project row instead.
 *
 * This module owns the id convention that lets the renderer and the server
 * agree on which workspace ids are synthetic roots. Project ids are UUIDs
 * and task ids are Crockford-base32 ULIDs, so the `root-` prefix can never
 * collide with a task-backed workspace id.
 */

const ROOT_WORKSPACE_ID_PREFIX = 'root-'

/**
 * Display label for the root workspace where a branch name is expected.
 * The actual checked-out branch is not tracked in the shared database.
 */
export const ROOT_WORKSPACE_BRANCH_LABEL = 'root'

/** The stable, synthetic workspace id for a project's main checkout. */
export const rootWorkspaceId = (projectId: string): string =>
  `${ROOT_WORKSPACE_ID_PREFIX}${projectId}`

/** Whether a workspace id names a synthetic root workspace. */
export const isRootWorkspaceId = (workspaceId: string): boolean =>
  workspaceId.startsWith(ROOT_WORKSPACE_ID_PREFIX)

/**
 * The owning project id of a synthetic root workspace id, or null when the
 * id belongs to a task-backed workspace.
 */
export const projectIdFromRootWorkspaceId = (
  workspaceId: string
): string | null =>
  isRootWorkspaceId(workspaceId)
    ? workspaceId.slice(ROOT_WORKSPACE_ID_PREFIX.length)
    : null
