import { describe, expect, it } from 'vitest'
import { isUtilityProcessBootstrapMessage } from '../src/utility-process-types.js'

describe('isUtilityProcessBootstrapMessage', () => {
  it('accepts a bounded semantic agent-status fact', () => {
    expect(
      isUtilityProcessBootstrapMessage({
        agentId: 'terminal-1:42',
        agentName: 'Claude',
        status: 'needs_input',
        terminalId: 'terminal-1',
        type: 'terminal-agent-status',
        workspaceId: 'workspace-1',
      })
    ).toBe(true)
  })

  it('rejects malformed and unknown child-process messages', () => {
    expect(
      isUtilityProcessBootstrapMessage({
        agentId: 'terminal-1:42',
        agentName: 'Claude',
        status: 'finished',
        terminalId: 'terminal-1',
        type: 'terminal-agent-status',
        workspaceId: 'workspace-1',
      })
    ).toBe(false)
    expect(isUtilityProcessBootstrapMessage({ type: 'surprise' })).toBe(false)
  })
})
