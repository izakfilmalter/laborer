/**
 * useWorkspaceAgentStatus — aggregate agent status for one workspace.
 *
 * The workspace frame and its header both answer "what is this workspace's
 * agent doing?" — the frame to outline itself, the header to badge itself.
 * Asking here rather than in each component is what keeps an outlined frame
 * and its header from disagreeing about the same workspace.
 *
 * @see apps/web/src/lib/workspace-agent-status.ts — the rollup itself
 * @see apps/web/src/lib/agent-status-presentation.ts — how it is drawn
 */

import { useMemo } from 'react'
import { useTerminalList } from '@/hooks/use-terminal-list'
import type { AgentDisplayStatus } from '@/lib/agent-attention-projection'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'

/**
 * The aggregate agent status for `workspaceId`, or `null` when no workspace
 * is bound or none of its terminals is running an agent.
 */
function useWorkspaceAgentStatus(
  workspaceId: string | undefined
): AgentDisplayStatus | null {
  const { terminals } = useTerminalList()

  return useMemo(() => {
    if (!workspaceId) {
      return null
    }

    return deriveWorkspaceAgentStatus(
      terminals.filter((terminal) => terminal.workspaceId === workspaceId)
    )
  }, [terminals, workspaceId])
}

export { useWorkspaceAgentStatus }
