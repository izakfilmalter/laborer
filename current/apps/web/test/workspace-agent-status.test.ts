/**
 * Unit tests for deriveWorkspaceAgentStatus — a pure function that
 * determines whether any terminal in a workspace needs user attention
 * based on agent status.
 *
 * @see apps/web/src/lib/workspace-agent-status.ts
 */

import { describe, expect, it } from 'vitest'
import { deriveWorkspaceAgentStatus } from '../src/lib/workspace-agent-status'

const status = (value: 'working' | 'needs_input' | 'idle' | 'unknown') => ({
  status: value,
  source: 'ps' as const,
  changedAt: 0,
  stale: false,
})

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

  it('returns "needs_input" when any terminal has that status', () => {
    const terminals = [
      { agentStatus: null, workspaceId: 'ws-1' },
      { agentStatus: status('needs_input'), workspaceId: 'ws-1' },
      { agentStatus: status('working'), workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('needs_input')
  })

  it('returns "active" when agents are running but none waiting', () => {
    const terminals = [
      { agentStatus: status('working'), workspaceId: 'ws-1' },
      { agentStatus: null, workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('working')
  })

  it('prioritizes needs_input over active', () => {
    const terminals = [
      { agentStatus: status('working'), workspaceId: 'ws-1' },
      { agentStatus: status('needs_input'), workspaceId: 'ws-1' },
    ]
    expect(deriveWorkspaceAgentStatus(terminals)).toBe('needs_input')
  })
})
