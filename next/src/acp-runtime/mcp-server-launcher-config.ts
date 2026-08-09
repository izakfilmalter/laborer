import { fileURLToPath } from "node:url";

export type LaborerMcpServerKind = "action" | "memory";

export const LABORER_MCP_SERVER_LAUNCHER_PATH = fileURLToPath(
  new URL("./mcp-server-launcher.ts", import.meta.url)
);

export const laborerMcpServerLauncherArgs = (
  kind: LaborerMcpServerKind
): readonly string[] => [LABORER_MCP_SERVER_LAUNCHER_PATH, kind];

const SYSTEM_ENVIRONMENT_NAMES = new Set([
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING",
]);

const KIND_ENVIRONMENT_NAMES: Readonly<
  Record<LaborerMcpServerKind, ReadonlySet<string>>
> = {
  action: new Set([
    "LABORER_ACTION_BOOTSTRAP_PATH",
    "LABORER_ACTION_CONTROL_URL",
    "LABORER_ACTION_SERVER_GENERATION",
    "LABORER_ACTION_SERVER_NAME",
  ]),
  memory: new Set([
    "LABORER_MEMORY_AUTHORITY_GUARD",
    "LABORER_MEMORY_CONFIG_ROOT",
    "LABORER_MEMORY_READY_PATH",
    "LABORER_MEMORY_REGISTRATION_NONCE",
    "LABORER_MEMORY_ROOT",
    "LABORER_MEMORY_SERVER_NAME",
    "LABORER_MEMORY_STATE_ROOT",
    "LABORER_MEMORY_WORKSPACE_ID",
  ]),
};

const OPTIONAL_KIND_ENVIRONMENT_NAMES: Readonly<
  Record<LaborerMcpServerKind, ReadonlySet<string>>
> = {
  action: new Set(["LABORER_ACTION_CATALOG_PATH"]),
  memory: new Set(),
};

export const laborerMcpEnvironmentIsScrubbed = (
  kind: LaborerMcpServerKind,
  names: readonly string[]
): boolean => {
  const required = KIND_ENVIRONMENT_NAMES[kind];
  const optional = OPTIONAL_KIND_ENVIRONMENT_NAMES[kind];
  const observed = new Set(names);
  return (
    names.length === observed.size &&
    [...required].every((name) => observed.has(name)) &&
    names.every(
      (name) =>
        required.has(name) ||
        optional.has(name) ||
        SYSTEM_ENVIRONMENT_NAMES.has(name)
    )
  );
};
