import { describe, expect, it } from 'vitest'
import { withInitialAgentPrompt } from '../src/services/agent-launch-command.js'

describe('withInitialAgentPrompt', () => {
  it('passes an OpenCode prompt through the environment', () => {
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
