const OPENCODE_INITIAL_PROMPT_ENV = 'LABORER_OPENCODE_INITIAL_PROMPT'

interface AgentLaunchCommand {
  readonly command: string
  readonly extraEnv: Readonly<Record<string, string>>
}

/**
 * Add an initial prompt to a supported interactive agent command without
 * interpolating untrusted prompt text into a shell command.
 */
const withInitialAgentPrompt = (
  agentCommand: string,
  initialPrompt?: string
): AgentLaunchCommand => {
  if (
    (agentCommand !== 'opencode' && agentCommand !== 'opencode2') ||
    initialPrompt === undefined
  ) {
    return { command: agentCommand, extraEnv: {} }
  }

  return {
    command: `${agentCommand} --prompt "$${OPENCODE_INITIAL_PROMPT_ENV}"`,
    extraEnv: { [OPENCODE_INITIAL_PROMPT_ENV]: initialPrompt },
  }
}

export { withInitialAgentPrompt }
