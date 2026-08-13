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

import type { AgentStatusSnapshot } from '@/hooks/use-terminal-list'
import {
  type AgentDisplayStatus,
  rollupWorkspaceAgentStatus,
} from '@/lib/agent-attention-projection'

/**
 * Derive the aggregate agent status for a workspace from its terminals.
 *
 * Priority: `needs_input` > `done` > `working` > `idle` > `unknown` > `null`
 *
 * - Returns `'needs_input'` if any terminal's agent needs input
 * - Returns `'done'` for an unseen completion unless another agent needs input
 * - Returns `'working'` if any terminal has a working agent but none need attention
 * - Returns `null` if no agents are detected
 */
function deriveWorkspaceAgentStatus(
  terminals: ReadonlyArray<{
    readonly agentStatus: AgentStatusSnapshot | null
  }>
): AgentDisplayStatus | null {
  return rollupWorkspaceAgentStatus(terminals)
}

export { deriveWorkspaceAgentStatus }
