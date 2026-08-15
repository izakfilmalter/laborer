import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEV_TERMINAL_XDG_STATE_HOME = 'LABORER_DEV_TERMINAL_XDG_STATE_HOME'

const userStateHome = (inherited: NodeJS.ProcessEnv): string | undefined => {
  const configured = inherited[DEV_TERMINAL_XDG_STATE_HOME]
  if (configured !== undefined) {
    return configured
  }
  return inherited.LABORER_DEV_WATCH === '1'
    ? join(inherited.HOME ?? homedir(), '.local', 'state')
    : undefined
}

/**
 * Build the environment sent to a user-owned terminal process.
 *
 * Development isolates Laborer's own durable state with XDG_STATE_HOME, but
 * user tools launched inside a terminal must retain their normal state home.
 * In particular, OpenCode discovers its shared background service there.
 * Workspace environment values remain authoritative.
 */
export const terminalSpawnEnvironment = (
  inherited: NodeJS.ProcessEnv,
  workspace: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>
): Record<string, string | undefined> => ({
  ...inherited,
  ...(userStateHome(inherited) === undefined
    ? {}
    : { XDG_STATE_HOME: userStateHome(inherited) }),
  ...workspace,
  ...extra,
})
