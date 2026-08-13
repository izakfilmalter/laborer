import { isOpenCodeSessionId } from './opencode-session.js'

const OPENCODE_INITIAL_PROMPT_ENV = 'LABORER_OPENCODE_INITIAL_PROMPT'

interface AgentLaunchCommand {
  readonly command: string
  readonly extraEnv: Readonly<Record<string, string>>
}

/**
 * Add an initial prompt to a supported interactive agent command without
 * interpolating untrusted prompt text into a shell command.
 *
 * OpenCode v1 submits a `--prompt` on startup; OpenCode v2 only prefills it,
 * so for v2 this is the degraded fallback used when a session could not be
 * pre-started. The operator still gets the prompt, but has to press Enter.
 *
 * @see startOpenCodeSession
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

/**
 * Attach the agent to a session that already holds the prompt, so the
 * terminal opens onto work that is already running.
 *
 * The prompt is deliberately absent: passing `--prompt` alongside
 * `--session` makes the TUI submit the same text a second time.
 *
 * Ids that do not look like OpenCode session ids launch a plain agent rather
 * than reaching a shell.
 */
const withPrestartedSession = (
  agentCommand: string,
  sessionId: string
): AgentLaunchCommand => {
  if (agentCommand !== 'opencode2' || !isOpenCodeSessionId(sessionId)) {
    return { command: agentCommand, extraEnv: {} }
  }

  return { command: `${agentCommand} --session ${sessionId}`, extraEnv: {} }
}

export { withInitialAgentPrompt, withPrestartedSession }
