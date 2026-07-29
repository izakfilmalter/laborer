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

const isWorkspaceBinding = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, ["detail", "id", "label", "readiness", "teamId"])
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
        bindingDetails.includes(
          binding.detail as (typeof bindingDetails)[number]
        ))
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
  if (typeof binding.id !== "string" || typeof binding.label !== "string") {
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
      candidate.workspaces.every(isWorkspaceBinding)
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
