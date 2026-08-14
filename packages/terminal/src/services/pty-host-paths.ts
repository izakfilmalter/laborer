import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const PTY_HOST_PROTOCOL_VERSION = '1'
export const PTY_HOST_REGISTRATION_FILE = 'pty-host.json'
export const PTY_HOST_SOCKET_FILE = 'pty-host.sock'

export const resolveLaborerStateRoot = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.XDG_STATE_HOME?.trim()
  const stateHome =
    configured !== undefined && isAbsolute(configured)
      ? configured
      : join(homedir(), '.local', 'state')
  return resolve(stateHome, 'laborer')
}

export const resolvePtyHostPaths = (
  environment: NodeJS.ProcessEnv = process.env
) => {
  const stateDir = join(resolveLaborerStateRoot(environment), 'pty-host')
  return {
    registrationPath: join(stateDir, PTY_HOST_REGISTRATION_FILE),
    socketPath: join(stateDir, PTY_HOST_SOCKET_FILE),
    stateDir,
  }
}
