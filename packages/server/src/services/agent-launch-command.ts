const OPENCODE_INITIAL_PROMPT_ENV = 'LABORER_OPENCODE_INITIAL_PROMPT'

interface AgentLaunchCommand {
  readonly command: string
  readonly extraEnv: Readonly<Record<string, string>>
}

/**
 * Add an initial prompt to a supported interactive agent command without
 * interpolating untrusted prompt text into a shell command.
 *
 * The prompt is attached with `--prompt=<value>` rather than as a separate
 * argument. Both OpenCode CLIs read a separate argument that starts with `-`
 * as the next flag instead of as the prompt, so a prompt opening with a
 * markdown bullet (`- fix the thing`) leaves `--prompt` without a value: the
 * CLI prints its usage banner and exits, and the agent pane never starts an
 * agent. The `=` form binds the value to the flag regardless of its first
 * character.
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
    command: `${agentCommand} --prompt="$${OPENCODE_INITIAL_PROMPT_ENV}"`,
    extraEnv: { [OPENCODE_INITIAL_PROMPT_ENV]: initialPrompt },
  }
}

export { withInitialAgentPrompt }
