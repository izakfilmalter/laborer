import { Array as EffectArray, pipe, Record } from "effect";
import { isSlackTokenEnvironmentName } from "./secret-environment.ts";

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
 * Slack credentials belong to the adapter and must never cross the generic
 * configured-handler process boundary.
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
    EffectArray.filter((name) => !isSlackTokenEnvironmentName(name))
  );
  return Record.filter(
    inheritedRecord,
    (value, name) =>
      value !== undefined && EffectArray.contains(allowedNames, name)
  );
};
