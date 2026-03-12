/**
 * Unit tests for buildWorkspaceStatusMap — groups terminals by workspace
 * and derives per-workspace aggregate agent status.
 *
 * @see apps/web/src/hooks/use-agent-notifications.ts
 */

import { describe, expect, it } from 'vitest'
import { buildWorkspaceStatusMap } from '../src/hooks/use-agent-notifications'
import type { TerminalInfo } from '../src/hooks/use-terminal-list'

/** Minimal terminal fixture with just the fields buildWorkspaceStatusMap needs. */
function makeTerminal(
  overrides: Partial<TerminalInfo> & { workspaceId: string }
): TerminalInfo {
  return {
    agentStatus: null,
    args: [],
    command: '/bin/zsh',
    cwd: '/tmp',
    foregroundProcess: null,
    hasChildProcess: false,
    id: `term-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    ...overrides,
  }
}

describe('buildWorkspaceStatusMap', () => {
  it('returns empty map when no terminals exist', () => {
    const result = buildWorkspaceStatusMap([])
    expect(result.size).toBe(0)
  })

  it('derives active status for workspace with active agent', () => {
    const terminals = [
      makeTerminal({ workspaceId: 'ws-1', agentStatus: 'active' }),
    ]
    const result = buildWorkspaceStatusMap(terminals)
    expect(result.get('ws-1')).toBe('active')
  })

  it('derives waiting_for_input when any terminal in workspace is waiting', () => {
    const terminals = [
      makeTerminal({ workspaceId: 'ws-1', agentStatus: 'active' }),
      makeTerminal({ workspaceId: 'ws-1', agentStatus: 'waiting_for_input' }),
    ]
    const result = buildWorkspaceStatusMap(terminals)
    expect(result.get('ws-1')).toBe('waiting_for_input')
  })

  it('omits workspaces where all terminals have null agent status', () => {
    const terminals = [
      makeTerminal({ workspaceId: 'ws-1', agentStatus: null }),
      makeTerminal({ workspaceId: 'ws-1', agentStatus: null }),
    ]
    const result = buildWorkspaceStatusMap(terminals)
    expect(result.has('ws-1')).toBe(false)
  })

  it('handles multiple workspaces independently', () => {
    const terminals = [
      makeTerminal({ workspaceId: 'ws-1', agentStatus: 'active' }),
      makeTerminal({ workspaceId: 'ws-2', agentStatus: 'waiting_for_input' }),
      makeTerminal({ workspaceId: 'ws-3', agentStatus: null }),
    ]
    const result = buildWorkspaceStatusMap(terminals)
    expect(result.get('ws-1')).toBe('active')
    expect(result.get('ws-2')).toBe('waiting_for_input')
    expect(result.has('ws-3')).toBe(false)
  })
})
