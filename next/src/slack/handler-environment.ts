import { Array as EffectArray, pipe, Record } from "effect";
import { isSensitiveCredentialEnvironmentName } from "./secret-environment.ts";

const REQUIRED_RUNTIME_VARIABLES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * Adapter and control-plane credentials must never cross a configured child
 * process boundary. Provider credentials remain explicit operator opt-ins.
 */
export const environmentForConfiguredHandler = (
  inherited: NodeJS.ProcessEnv,
  optedInNames: readonly string[] = []
): NodeJS.ProcessEnv => {
  const inheritedRecord: Readonly<Record<string, string | undefined>> =
    inherited;
  const allowedNames = pipe(
    REQUIRED_RUNTIME_VARIABLES,
    EffectArray.appendAll(optedInNames),
    EffectArray.filter((name) => !isSensitiveCredentialEnvironmentName(name))
  );
  return Record.filter(
    inheritedRecord,
    (value, name) =>
      value !== undefined && EffectArray.contains(allowedNames, name)
  );
};

/**
 * The production ACP child receives only runtime variables and names the
 * operator explicitly opted into for the reference application. Laborer-owned
 * authority material stays out even if a stale configuration names it.
 */
export const environmentForAcpConversation = (
  inherited: NodeJS.ProcessEnv,
  optedInNames: readonly string[] = []
): NodeJS.ProcessEnv =>
  environmentForConfiguredHandler(inherited, optedInNames);
