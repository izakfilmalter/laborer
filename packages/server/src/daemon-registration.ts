import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLaborerStateRoot } from '@laborer/terminal/services/pty-host-paths'

export const DAEMON_PROTOCOL_VERSION = '1'
export const DAEMON_REGISTRATION_FILE = 'daemon.json'

export const resolveDaemonVersion = (entryPath: string): string =>
  `${DAEMON_PROTOCOL_VERSION}-${createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 12)}`

export const resolveDaemonRegistrationPath = (
  environment: NodeJS.ProcessEnv = process.env
): string =>
  join(resolveLaborerStateRoot(environment), DAEMON_REGISTRATION_FILE)
