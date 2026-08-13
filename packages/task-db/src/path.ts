import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const taskDatabasePath = (
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string => {
  const xdgStateHome = environment.XDG_STATE_HOME?.trim()
  const stateHome =
    xdgStateHome && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, '.local', 'state')
  return join(stateHome, 'laborer', 'laborer.sqlite')
}
