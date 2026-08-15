import { describe, expect, it } from 'vitest'
import { AgentStatusFactProjector } from '../src/daemon-agent-status.js'

const terminal = (
  status: 'working' | 'needs_input' | 'idle' | null,
  agent = true
) => ({
  agentStatus:
    status === null
      ? null
      : {
          status,
        },
  foregroundProcess: null,
  id: 'terminal-1',
  processChain: agent
    ? [{ category: 'agent', label: 'Claude', rawName: 'claude' }]
    : [],
  workspaceId: 'workspace-1',
})

describe('AgentStatusFactProjector', () => {
  it('keeps one agent identity across status transitions', () => {
    const projector = new AgentStatusFactProjector()
    const working = projector.project(terminal('working'))
    const waiting = projector.project(terminal('needs_input'))

    expect(waiting.agentId).toBe(working.agentId)
    expect(waiting).toMatchObject({
      agentName: 'Claude',
      status: 'needs_input',
      workspaceId: 'workspace-1',
    })
  })

  it('starts a new identity when an agent exits and another appears', () => {
    const projector = new AgentStatusFactProjector()
    const first = projector.project(terminal('working'))
    projector.project(terminal('idle', false))
    const replacement = projector.project(terminal('working'))

    expect(replacement.agentId).not.toBe(first.agentId)
  })

  it('starts a new identity after a detector clears the previous agent', () => {
    const projector = new AgentStatusFactProjector()
    const first = projector.project(terminal('working'))
    projector.project(terminal(null, false))
    const replacement = projector.project(terminal('working'))

    expect(replacement.agentId).not.toBe(first.agentId)
  })

  it('clears terminals absent from a reconnect snapshot', () => {
    const projector = new AgentStatusFactProjector()
    projector.project(terminal('working'))

    expect(projector.reconcile([])).toEqual([
      expect.objectContaining({ status: null, terminalId: 'terminal-1' }),
    ])
    expect(projector.reconcile([])).toEqual([])
  })

  it('clears notification state when a terminal is removed', () => {
    const projector = new AgentStatusFactProjector()
    projector.project(terminal('working'))

    expect(projector.remove('terminal-1')).toMatchObject({
      status: null,
      terminalId: 'terminal-1',
    })
  })
})
