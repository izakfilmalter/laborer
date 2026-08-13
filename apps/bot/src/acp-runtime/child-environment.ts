import { Array as EffectArray, pipe, Record } from 'effect'
import { isSensitiveCredentialEnvironmentName } from '../adapters/sensitive-environment.ts'

const REQUIRED_RUNTIME_VARIABLES = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const

/** Build the minimal ACP child environment plus explicit application opt-ins. */
export const environmentForAcpConversation = (
  inherited: NodeJS.ProcessEnv,
  optedInNames: readonly string[] = []
): NodeJS.ProcessEnv => {
  const inheritedRecord: Readonly<Record<string, string | undefined>> =
    inherited
  const allowedNames = pipe(
    REQUIRED_RUNTIME_VARIABLES,
    EffectArray.appendAll(optedInNames),
    EffectArray.filter((name) => !isSensitiveCredentialEnvironmentName(name))
  )
  return Record.filter(
    inheritedRecord,
    (value, name) =>
      value !== undefined && EffectArray.contains(allowedNames, name)
  )
}
