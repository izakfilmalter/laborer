/**
 * Unit tests for deriveWorkspaceAgentStatus — a pure function that
 * determines whether any terminal in a workspace needs user attention
 * based on agent status.
 *
 * @see apps/web/src/lib/workspace-agent-status.ts
 */

import { describe, expect, it } from 'vitest'
import { deriveWorkspaceAgentStatus } from '../src/lib/workspace-agent-status'

describe('deriveWorkspaceAgentStatus', () => {
  it('returns null when no terminals are provided', () => {
    expect(deriveWorkspaceAgentStatus([])).toBeNull()
  })

  it('returns null when no terminals have an agent status', () => {
    const terminals = [
      { agentStatus: null, workspaceId: 'ws-1' },
      { agentStatus: null, workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBeNull()
  })

  it('returns "waiting_for_input" when any terminal has that status', () => {
    const terminals = [
      { agentStatus: null, workspaceId: 'ws-1' },
      { agentStatus: 'waiting_for_input' as const, workspaceId: 'ws-1' },
      { agentStatus: 'active' as const, workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('waiting_for_input')
  })

  it('returns "active" when agents are running but none waiting', () => {
    const terminals = [
      { agentStatus: 'active' as const, workspaceId: 'ws-1' },
      { agentStatus: null, workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('active')
  })

  it('prioritizes waiting_for_input over active', () => {
    const terminals = [
      { agentStatus: 'active' as const, workspaceId: 'ws-1' },
      { agentStatus: 'waiting_for_input' as const, workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('waiting_for_input')
  })
})
