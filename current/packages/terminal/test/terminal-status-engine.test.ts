import { describe, expect, it } from 'vitest'
import { TerminalStatusEngine } from '../src/services/terminal-status-engine.js'

const agent = (pid = 42) => [{ pid }]

describe('TerminalStatusEngine', () => {
  it('classifies a one-shot agent run as working then idle', () => {
    const engine = new TerminalStatusEngine()

    expect(engine.sample({ agentProcesses: agent(), sampledAt: 0 })).toEqual({
      status: 'working',
      source: 'ps',
      changedAt: 0,
      stale: false,
    })
    engine.sample({ agentProcesses: [], sampledAt: 200 })
    engine.sample({ agentProcesses: [], sampledAt: 400 })
    expect(engine.sample({ agentProcesses: [], sampledAt: 600 })?.status).toBe(
      'idle'
    )
  })

  it('publishes idle before an explicit one-shot process exit', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })

    expect(engine.processExited(100)).toMatchObject({
      status: 'idle',
      source: 'ps',
      changedAt: 100,
    })
  })

  it('does not treat one odd or unavailable sample as agent completion', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })

    expect(engine.sample({ agentProcesses: [], sampledAt: 200 })?.status).toBe(
      'working'
    )
    expect(engine.unavailable(400)?.status).toBe('working')
    expect(engine.sample({ agentProcesses: [], sampledAt: 600 })?.status).toBe(
      'working'
    )
  })

  it('clears agent status when a non-agent command takes over', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })
    engine.sample({
      agentProcesses: [],
      hasNonAgentProcess: true,
      sampledAt: 200,
    })
    engine.sample({
      agentProcesses: [],
      hasNonAgentProcess: true,
      sampledAt: 400,
    })

    expect(
      engine.sample({
        agentProcesses: [],
        hasNonAgentProcess: true,
        sampledAt: 600,
      })
    ).toBeNull()
  })

  it('marks sustained failure stale and clears staleness on recovery', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })

    expect(engine.unavailable(1000)?.stale).toBe(false)
    expect(engine.unavailable(11_000)).toMatchObject({
      status: 'working',
      changedAt: 0,
      stale: true,
    })
    expect(
      engine.sample({ agentProcesses: agent(), sampledAt: 11_200 })?.stale
    ).toBe(false)
  })

  it('guards hook sequence and scopes authority to the detected process', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(42), sampledAt: 0 })
    engine.report({ status: 'needs_input', sequence: 2 }, 10)

    expect(engine.report({ status: 'working', sequence: 1 }, 20)?.status).toBe(
      'needs_input'
    )
    expect(
      engine.sample({ agentProcesses: agent(42), sampledAt: 30 })?.source
    ).toBe('hook')

    expect(
      engine.sample({ agentProcesses: agent(99), sampledAt: 40 })
    ).toMatchObject({ status: 'working', source: 'ps' })
  })

  it('rejects reports arriving after a successful no-agent sample', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: [], sampledAt: 0 })
    expect(engine.report({ status: 'needs_input', sequence: 1 }, 10)).toBeNull()
  })
})
