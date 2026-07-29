import type { OperatorStatusView } from "../operator-status/client.ts";

export type CompanionStatusView =
  | OperatorStatusView
  | {
      readonly state:
        | "service-denied"
        | "service-already-registered"
        | "service-registered"
        | "service-registering"
        | "service-requires-approval"
        | "service-unavailable"
        | "service-version-mismatch";
      readonly uptimeSeconds: null;
      readonly version: null;
    };

export const COMPANION_STATUS_CHANNEL = "companion:status";
export const COMPANION_RECONNECT_CHANNEL = "companion:reconnect";
export const COMPANION_QUIT_CHANNEL = "companion:quit";

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const bindingDetails = [
  "authentication-unavailable",
  "configuration-invalid",
  "health-unavailable",
  "identity-mismatch",
  "ownership-unavailable",
  "root-unavailable",
  "runtime-unavailable",
  "setup-required",
  "startup-stopped",
] as const;
const bindingIdPattern = /^binding:\d+$/;
const bindingLabelPattern = /^Workspace binding [1-9]\d*$/;
const teamIdPattern = /^T[A-Z0-9]+$/;
const threadIdPattern =
  /^workspace:T[A-Z0-9]+:[CG][A-Z0-9]+:\d{1,16}(?:\.\d{1,9})?$/;
const threadLabelPattern = /^(?:[CG][A-Z0-9]+|Slack) · \d{1,16}(?:\.\d{1,9})?$/;

const isWorkThread = (value: unknown, teamId: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "activity",
      "id",
      "label",
      "stateChangedAtUnixMs",
      "workspaceId",
    ])
  ) {
    return false;
  }
  const thread = value as Record<string, unknown>;
  return (
    ["in-progress", "needs-attention", "dormant"].includes(
      String(thread.activity)
    ) &&
    typeof thread.id === "string" &&
    thread.id.length > 0 &&
    thread.id.length <= 256 &&
    threadIdPattern.test(thread.id) &&
    typeof thread.label === "string" &&
    thread.label.length > 0 &&
    thread.label.length <= 80 &&
    threadLabelPattern.test(thread.label) &&
    Number.isSafeInteger(thread.stateChangedAtUnixMs) &&
    Number(thread.stateChangedAtUnixMs) >= 0 &&
    Number(thread.stateChangedAtUnixMs) <= 8_640_000_000_000_000 &&
    typeof teamId === "string" &&
    thread.workspaceId === teamId
  );
};

const isWorkspaceBinding = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "detail",
      "id",
      "label",
      "readiness",
      "teamId",
      "threads",
    ])
  ) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  if (
    !(
      [
        "pending",
        "ready",
        "setup-incomplete",
        "unavailable",
        "unknown",
      ].includes(String(binding.readiness)) &&
      (binding.detail === null ||
        bindingDetails.some((detail) => detail === binding.detail))
    )
  ) {
    return false;
  }
  if (
    (binding.readiness === "ready" || binding.readiness === "pending") !==
    (binding.detail === null)
  ) {
    return false;
  }
  if (
    typeof binding.id !== "string" ||
    binding.id.length > 64 ||
    typeof binding.label !== "string" ||
    binding.label.length > 64 ||
    !Array.isArray(binding.threads) ||
    binding.threads.length > 512 ||
    !binding.threads.every((thread) => isWorkThread(thread, binding.teamId)) ||
    new Set(
      binding.threads.map((thread) =>
        typeof thread === "object" && thread !== null && "id" in thread
          ? thread.id
          : null
      )
    ).size !== binding.threads.length ||
    binding.threads.filter(
      (thread) =>
        typeof thread === "object" &&
        thread !== null &&
        "activity" in thread &&
        thread.activity === "dormant"
    ).length > 4
  ) {
    return false;
  }
  if (binding.teamId === null) {
    return (
      bindingIdPattern.test(binding.id) &&
      bindingLabelPattern.test(binding.label)
    );
  }
  return (
    typeof binding.teamId === "string" &&
    teamIdPattern.test(binding.teamId) &&
    binding.teamId.length <= 58 &&
    (binding.id === `slack:${binding.teamId}` ||
      bindingIdPattern.test(binding.id)) &&
    binding.label === binding.teamId
  );
};

export const isOperatorStatusView = (
  value: unknown
): value is CompanionStatusView => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "running") {
    return (
      exactKeys(value, [
        "receiver",
        "state",
        "uptimeSeconds",
        "version",
        "workspaces",
      ]) &&
      ["connected", "connecting"].includes(String(candidate.receiver)) &&
      typeof candidate.version === "string" &&
      candidate.version.length > 0 &&
      candidate.version.length <= 64 &&
      typeof candidate.uptimeSeconds === "number" &&
      Number.isSafeInteger(candidate.uptimeSeconds) &&
      candidate.uptimeSeconds >= 0 &&
      Array.isArray(candidate.workspaces) &&
      candidate.workspaces.length <= 64 &&
      candidate.workspaces.every(isWorkspaceBinding) &&
      candidate.workspaces.reduce(
        (count, workspace) =>
          count +
          (typeof workspace === "object" &&
          workspace !== null &&
          "threads" in workspace &&
          Array.isArray(workspace.threads)
            ? workspace.threads.length
            : 0),
        0
      ) <= 512 &&
      new Set(
        candidate.workspaces.map((workspace) =>
          typeof workspace === "object" &&
          workspace !== null &&
          "id" in workspace
            ? workspace.id
            : null
        )
      ).size === candidate.workspaces.length
    );
  }
  return (
    exactKeys(value, ["state", "uptimeSeconds", "version"]) &&
    [
      "connecting",
      "incompatible",
      "reconnecting",
      "service-denied",
      "service-already-registered",
      "service-registered",
      "service-registering",
      "service-requires-approval",
      "service-unavailable",
      "service-version-mismatch",
      "unavailable",
      "version-mismatch",
    ].includes(String(candidate.state)) &&
    candidate.version === null &&
    candidate.uptimeSeconds === null
  );
};

export interface LaborerCompanionBridge {
  readonly quit: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly subscribeStatus: (
    listener: (view: CompanionStatusView) => void
  ) => () => void;
}
