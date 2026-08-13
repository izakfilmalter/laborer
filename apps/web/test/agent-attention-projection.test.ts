import type { AgentStatusSnapshot } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  compareAgentAttention,
  deriveAgentDisplayStatus,
  rollupWorkspaceAgentStatus,
} from '@/lib/agent-attention-projection'

const snapshot = (
  status: AgentStatusSnapshot['status'],
  seen = true
): AgentStatusSnapshot => ({
  status,
  seen,
  source: 'ps',
  changedAt: 0,
  stale: false,
})

describe('agent attention projection', () => {
  it.each([
    ['idle', false, 'done'],
    ['idle', true, 'idle'],
    ['working', false, 'working'],
    ['needs_input', false, 'needs_input'],
    ['unknown', false, 'unknown'],
  ] as const)('projects %s (seen=%s) to %s', (status, seen, expected) => {
    expect(deriveAgentDisplayStatus(snapshot(status, seen))).toBe(expected)
  })

  it.each([
    ['needs_input', 'done'],
    ['done', 'working'],
    ['working', 'idle'],
    ['idle', 'unknown'],
  ] as const)('ranks %s above %s', (higher, lower) => {
    expect(compareAgentAttention(higher, lower)).toBeGreaterThan(0)
  })

  it.each([
    [[], null],
    [[snapshot('working')], 'working'],
    [[snapshot('working'), snapshot('idle', false)], 'done'],
    [[snapshot('idle', false), snapshot('needs_input')], 'needs_input'],
    [[snapshot('idle'), snapshot('unknown')], 'idle'],
  ] as const)('rolls up child statuses by urgency', (statuses, expected) => {
    expect(
      rollupWorkspaceAgentStatus(
        statuses.map((agentStatus) => ({ agentStatus }))
      )
    ).toBe(expected)
  })
})
