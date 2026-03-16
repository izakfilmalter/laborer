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

import type { AgentStatus } from '@/hooks/use-terminal-list'

/**
 * Derive the aggregate agent status for a workspace from its terminals.
 *
 * Priority: `waiting_for_input` > `active` > `null`
 *
 * - Returns `'waiting_for_input'` if any terminal's agent needs input
 * - Returns `'active'` if any terminal has an active agent but none waiting
 * - Returns `null` if no agents are detected
 */
function deriveWorkspaceAgentStatus(
  terminals: ReadonlyArray<{
    readonly agentStatus: AgentStatus | null
  }>
): AgentStatus | null {
  let hasActive = false

  for (const terminal of terminals) {
    if (terminal.agentStatus === 'waiting_for_input') {
      return 'waiting_for_input'
    }
    if (terminal.agentStatus === 'active') {
      hasActive = true
    }
  }

  return hasActive ? 'active' : null
}

export { deriveWorkspaceAgentStatus }
