/**
 * Workspace-level agent status derivation.
 *
 * Given a list of terminals for a workspace, derives a single aggregate
 * agent status. Used by the sidebar workspace card and panel header to
 * show attention indicators when an agent needs user input.
 *
 * @see apps/web/src/components/workspace-list.tsx — WorkspaceItem
 * @see apps/web/src/components/workspace-frame-header.tsx — panel header
 */

import type {
  AgentStatus,
  AgentStatusSnapshot,
} from '@/hooks/use-terminal-list'

/**
 * Derive the aggregate agent status for a workspace from its terminals.
 *
 * Priority: `needs_input` > `working` > `idle` > `unknown` > `null`
 *
 * - Returns `'needs_input'` if any terminal's agent needs input
 * - Returns `'working'` if any terminal has a working agent but none need input
 * - Returns `null` if no agents are detected
 */
function deriveWorkspaceAgentStatus(
  terminals: ReadonlyArray<{
    readonly agentStatus: AgentStatusSnapshot | null
  }>
): AgentStatus | null {
  let best: AgentStatus | null = null
  const priority: Record<AgentStatus, number> = {
    needs_input: 4,
    working: 3,
    idle: 2,
    unknown: 1,
  }

  for (const terminal of terminals) {
    const status = terminal.agentStatus?.status
    if (
      status !== undefined &&
      (best === null || priority[status] > priority[best])
    ) {
      best = status
    }
  }

  return best
}

export { deriveWorkspaceAgentStatus }
