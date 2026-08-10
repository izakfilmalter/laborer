import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatusReport } from '@laborer/shared/rpc'
import { Effect, Exit, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AgentHookGateway,
  type AgentHookTerminal,
  startAgentHookServer,
} from '../src/services/terminal-client.js'

describe('agent hook server', () => {
  const receivedReports: Array<{ id: string; report: AgentStatusReport }> = []
  let terminals: AgentHookTerminal[] = []
  let scope: Scope.CloseableScope
  let port = 0
  let workspaceDir = ''
  let otherDir = ''

  const gateway: AgentHookGateway = {
    setAgentStatus: (input) =>
      Effect.sync(() => {
        receivedReports.push(input)
      }),
    listTerminals: () => Effect.sync(() => terminals),
  }

  const post = (body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/hook/agent-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'laborer-hook-ws-'))
    otherDir = mkdtempSync(join(tmpdir(), 'laborer-hook-other-'))
    scope = await Effect.runPromise(Scope.make())
    port = await Effect.runPromise(startAgentHookServer(gateway, scope))
  })

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    rmSync(workspaceDir, { force: true, recursive: true })
    rmSync(otherDir, { force: true, recursive: true })
  })

  it('forwards terminal-id reports directly', async () => {
    receivedReports.length = 0

    const response = await post({
      terminalId: 'terminal-1',
      status: 'needs_input',
      sequence: 10,
    })

    expect(response.status).toBe(200)
    expect(receivedReports).toEqual([
      { id: 'terminal-1', report: { status: 'needs_input', sequence: 10 } },
    ])
  })

  it('rejects stale sequences per terminal', async () => {
    receivedReports.length = 0

    await post({ terminalId: 'terminal-2', status: 'working', sequence: 7 })
    const stale = await post({
      terminalId: 'terminal-2',
      status: 'idle',
      sequence: 7,
    })

    expect(stale.status).toBe(202)
    expect(receivedReports.map(({ report }) => report.status)).toEqual([
      'working',
    ])
  })

  it('fans directory reports out to running terminals in that directory', async () => {
    receivedReports.length = 0
    terminals = [
      { id: 'agent-terminal', cwd: workspaceDir, status: 'running' },
      { id: 'stopped-terminal', cwd: workspaceDir, status: 'stopped' },
      { id: 'elsewhere-terminal', cwd: otherDir, status: 'running' },
    ]

    const response = await post({
      directory: workspaceDir,
      status: 'needs_input',
      sequence: 42,
    })

    expect(response.status).toBe(200)
    expect(receivedReports).toEqual([
      {
        id: 'agent-terminal',
        report: { status: 'needs_input', sequence: 42 },
      },
    ])
  })

  it('accepts and drops directory reports with no matching terminal', async () => {
    receivedReports.length = 0
    terminals = [{ id: 'elsewhere', cwd: otherDir, status: 'running' }]

    const response = await post({
      directory: workspaceDir,
      status: 'working',
      sequence: 43,
    })

    expect(response.status).toBe(202)
    expect(receivedReports).toEqual([])
  })

  it('rejects reports naming neither a terminal nor a directory', async () => {
    const response = await post({ status: 'working', sequence: 44 })
    expect(response.status).toBe(400)
  })

  it('rejects malformed bodies', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/hook/agent-status`, {
      method: 'POST',
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })
})
