import {
  type BoardTask,
  type BoardWorkspace,
  workspaceForTask,
} from '@/components/kanban/board-data'

interface ProvisionedTaskMove {
  readonly description: string | null
  readonly workspaceId: string | null
}

type OpenAgent = (
  workspaceId: string,
  options?: { readonly initialPrompt?: string | undefined }
) => void

/** Bridge a provisioning result into the existing deferred agent-launch seam. */
export const openProvisionedAgent = (
  result: ProvisionedTaskMove,
  openAgent: OpenAgent | undefined
): void => {
  if (typeof result.workspaceId !== 'string' || openAgent === undefined) {
    return
  }
  if (result.description === null) {
    openAgent(result.workspaceId)
    return
  }
  openAgent(result.workspaceId, { initialPrompt: result.description })
}

/**
 * What to do right now about a Slack card whose analysis and provisioning
 * were deferred to the server: keep waiting for its workspace, forget it, or
 * open its agent.
 */
export type PendingAgentOpenResolution =
  | { readonly _tag: 'wait' }
  | { readonly _tag: 'drop' }
  | {
      readonly _tag: 'open'
      readonly description: string | null
      readonly workspaceId: string
    }

/**
 * Resolve one deferred Slack provisioning against the board's current
 * projection. A card created straight into In Progress is planned and
 * provisioned by a detached server fiber, so the create response carries no
 * workspace id; the board watches its own task deltas and the LiveStore
 * workspace rows until the two agree that the work has a workspace.
 *
 * The card is forgotten when its analysis failed or when it left In Progress
 * (a failed provisioning bounces it back to Todo) — in both cases the retry
 * path is a fresh move, which launches the agent itself.
 */
export const resolvePendingAgentOpen = (
  task:
    | Pick<
        BoardTask,
        'description' | 'executionMirror' | 'status' | 'worktreePath'
      >
    | undefined,
  workspaces: readonly BoardWorkspace[]
): PendingAgentOpenResolution => {
  if (task === undefined) {
    // The creation delta may not have reached this board yet.
    return { _tag: 'wait' }
  }
  if (task.status !== 'in_progress' || task.executionMirror === 'failed') {
    return { _tag: 'drop' }
  }
  const workspace = workspaceForTask(task, workspaces)
  if (workspace === undefined) {
    return { _tag: 'wait' }
  }
  return {
    _tag: 'open',
    description: task.description,
    workspaceId: workspace.id,
  }
}
