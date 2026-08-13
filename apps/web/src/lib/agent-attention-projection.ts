import type {
  AgentStatus,
  AgentStatusSnapshot,
} from '@/hooks/use-terminal-list'

type AgentDisplayStatus = AgentStatus | 'done'

const ATTENTION_RANK: Record<AgentDisplayStatus, number> = {
  needs_input: 5,
  done: 4,
  working: 3,
  idle: 2,
  unknown: 1,
}

/** Done is display-only: lifecycle idle plus an unacknowledged Seen bit. */
function deriveAgentDisplayStatus(
  snapshot: AgentStatusSnapshot
): AgentDisplayStatus {
  return snapshot.status === 'idle' && !snapshot.seen ? 'done' : snapshot.status
}

function compareAgentAttention(
  left: AgentDisplayStatus,
  right: AgentDisplayStatus
): number {
  return ATTENTION_RANK[left] - ATTENTION_RANK[right]
}

function rollupWorkspaceAgentStatus(
  terminals: ReadonlyArray<{
    readonly agentStatus: AgentStatusSnapshot | null
  }>
): AgentDisplayStatus | null {
  let best: AgentDisplayStatus | null = null
  for (const terminal of terminals) {
    if (terminal.agentStatus === null) {
      continue
    }
    const projected = deriveAgentDisplayStatus(terminal.agentStatus)
    if (best === null || compareAgentAttention(projected, best) > 0) {
      best = projected
    }
  }
  return best
}

export {
  compareAgentAttention,
  deriveAgentDisplayStatus,
  rollupWorkspaceAgentStatus,
}
export type { AgentDisplayStatus }
