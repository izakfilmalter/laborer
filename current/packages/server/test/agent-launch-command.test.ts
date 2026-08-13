import { describe, expect, it } from 'vitest'
import {
  withInitialAgentPrompt,
  withPrestartedSession,
} from '../src/services/agent-launch-command.js'
import { buildOpenCodeSpawnCommand } from '../src/services/terminal-client.js'

describe('withInitialAgentPrompt', () => {
  it('preserves a historical OpenCode launch and passes its prompt safely', () => {
    const initialPrompt = 'Fix the bug described by "Slack" and $HOME.'

    expect(withInitialAgentPrompt('opencode', initialPrompt)).toEqual({
      command: 'opencode --prompt "$LABORER_OPENCODE_INITIAL_PROMPT"',
      extraEnv: { LABORER_OPENCODE_INITIAL_PROMPT: initialPrompt },
    })
  })

  it('passes an OpenCode 2 prompt through the environment', () => {
    const initialPrompt = 'Investigate the Slack report.'

    expect(withInitialAgentPrompt('opencode2', initialPrompt)).toEqual({
      command: 'opencode2 --prompt "$LABORER_OPENCODE_INITIAL_PROMPT"',
      extraEnv: { LABORER_OPENCODE_INITIAL_PROMPT: initialPrompt },
    })
  })

  it('does not modify commands that do not support prompt preloading', () => {
    expect(withInitialAgentPrompt('claude', 'Investigate the bug')).toEqual({
      command: 'claude',
      extraEnv: {},
    })
  })
})

describe('withPrestartedSession', () => {
  it('attaches OpenCode 2 to the session that already holds the prompt', () => {
    expect(
      withPrestartedSession('opencode2', 'ses_006bb764affeIlL3Pp2gLYz4nE')
    ).toEqual({
      command: 'opencode2 --session ses_006bb764affeIlL3Pp2gLYz4nE',
      extraEnv: {},
    })
  })

  it('keeps a session id that could reach a shell out of the command', () => {
    expect(withPrestartedSession('opencode2', 'ses_abc; rm -rf /')).toEqual({
      command: 'opencode2',
      extraEnv: {},
    })
  })

  it('does not offer sessions to agents that cannot attach to one', () => {
    expect(withPrestartedSession('claude', 'ses_abc123')).toEqual({
      command: 'claude',
      extraEnv: {},
    })
  })
})

describe('buildOpenCodeSpawnCommand', () => {
  it('supplies lifecycle hooks and the initial prompt to the spawned process', () => {
    expect(
      buildOpenCodeSpawnCommand(
        'opencode2',
        'terminal-123',
        4321,
        'Investigate the bug'
      )
    ).toEqual({
      command: 'opencode2 --prompt "$LABORER_OPENCODE_INITIAL_PROMPT"',
      extraEnv: {
        LABORER_TERMINAL_ID: 'terminal-123',
        LABORER_HOOK_URL: 'http://localhost:4321/hook/agent-status',
        LABORER_OPENCODE_INITIAL_PROMPT: 'Investigate the bug',
      },
    })
  })

  it('attaches to a pre-started session instead of repeating its prompt', () => {
    expect(
      buildOpenCodeSpawnCommand(
        'opencode2',
        'terminal-123',
        4321,
        'Investigate the bug',
        'ses_006bb764affeIlL3Pp2gLYz4nE'
      )
    ).toEqual({
      command: 'opencode2 --session ses_006bb764affeIlL3Pp2gLYz4nE',
      extraEnv: {
        LABORER_TERMINAL_ID: 'terminal-123',
        LABORER_HOOK_URL: 'http://localhost:4321/hook/agent-status',
      },
    })
  })
})
