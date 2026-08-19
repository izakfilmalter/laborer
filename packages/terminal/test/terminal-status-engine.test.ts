import { describe, expect, it } from 'vitest'
import { TerminalStatusEngine } from '../src/services/terminal-status-engine.js'

/**
 * An agent Laborer ships no status hook for, so process presence is the only
 * available evidence and implies `working`.
 */
const agent = (pid = 42) => [{ pid, rawName: 'codex' }]

/** An agent whose lifecycle a Laborer hook reports. */
const hookedAgent = (...pids: number[]) =>
  (pids.length > 0 ? pids : [42]).map((pid) => ({ pid, rawName: 'opencode' }))

describe('TerminalStatusEngine', () => {
  it('classifies a one-shot agent run as working then idle', () => {
    const engine = new TerminalStatusEngine()

    expect(engine.sample({ agentProcesses: agent(), sampledAt: 0 })).toEqual({
      status: 'working',
      source: 'ps',
      changedAt: 0,
      stale: false,
      seen: true,
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

  it('does not call a hook-backed agent working on process presence alone', () => {
    const engine = new TerminalStatusEngine()

    // An OpenCode TUI parked on its session picker is indistinguishable from
    // one mid-turn by process inspection, and reports nothing until a session
    // runs. Presence must not stand in for the absent hook evidence.
    expect(
      engine.sample({ agentProcesses: hookedAgent(), sampledAt: 0 })
    ).toMatchObject({ status: 'unknown', source: 'ps' })
  })

  it('still infers working from presence when any agent has no hook', () => {
    const engine = new TerminalStatusEngine()

    expect(
      engine.sample({
        agentProcesses: [...hookedAgent(42), ...agent(43)],
        sampledAt: 0,
      })
    ).toMatchObject({ status: 'working', source: 'ps' })
  })

  it('keeps hook authority across churn in the agent process set', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: hookedAgent(42, 43), sampledAt: 0 })
    engine.report({ status: 'idle', sequence: 1 }, 10)

    // Agents fork helpers and daemons mid-run, so the PID set churns. An
    // overlapping set is the same generation and must not revoke the hook.
    expect(
      engine.sample({ agentProcesses: hookedAgent(43, 44), sampledAt: 20 })
    ).toMatchObject({ status: 'idle', source: 'hook', seen: false })
  })

  it('revokes hook authority when the agent generation is replaced', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: hookedAgent(42), sampledAt: 0 })
    engine.report({ status: 'needs_input', sequence: 1 }, 10)

    expect(
      engine.sample({ agentProcesses: hookedAgent(99), sampledAt: 20 })
    ).toMatchObject({ status: 'unknown', source: 'ps' })
  })

  it('rejects reports arriving after a successful no-agent sample', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: [], sampledAt: 0 })
    expect(engine.report({ status: 'needs_input', sequence: 1 }, 10)).toBeNull()
  })

  it('leaves an unwatched completion unseen until its workspace is observed', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })

    expect(engine.processExited(100)?.seen).toBe(false)
    expect(engine.setObserved(true)).toMatchObject({
      status: 'idle',
      seen: true,
      changedAt: 100,
    })
  })

  it('keeps a completion seen while its workspace is observed', () => {
    const engine = new TerminalStatusEngine()
    engine.setObserved(true)
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })

    expect(engine.processExited(100)?.seen).toBe(true)
  })

  it('preserves unseen across an idle provenance change', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })
    engine.report({ status: 'idle', sequence: 1 }, 100)
    expect(engine.current?.seen).toBe(false)

    engine.sample({ agentProcesses: [], sampledAt: 200 })
    engine.sample({ agentProcesses: [], sampledAt: 400 })
    expect(engine.sample({ agentProcesses: [], sampledAt: 600 })?.seen).toBe(
      false
    )
  })

  it('marks every non-idle lifecycle status seen', () => {
    const engine = new TerminalStatusEngine()
    engine.sample({ agentProcesses: agent(), sampledAt: 0 })
    engine.processExited(100)
    expect(engine.current?.seen).toBe(false)

    engine.sample({ agentProcesses: agent(), sampledAt: 150 })
    engine.report({ status: 'needs_input', sequence: 1 }, 200)
    expect(engine.current?.seen).toBe(true)
  })
})
