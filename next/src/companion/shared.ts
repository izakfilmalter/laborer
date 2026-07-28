import type { OperatorStatusView } from "../operator-status/client.ts";

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

export const isOperatorStatusView = (
  value: unknown
): value is OperatorStatusView => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const expectedKeys = ["state", "uptimeSeconds", "version"];
  if (!exactKeys(value, expectedKeys)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "running") {
    return (
      typeof candidate.version === "string" &&
      candidate.version.length > 0 &&
      candidate.version.length <= 64 &&
      typeof candidate.uptimeSeconds === "number" &&
      Number.isSafeInteger(candidate.uptimeSeconds) &&
      candidate.uptimeSeconds >= 0
    );
  }
  return (
    ["connecting", "reconnecting", "unavailable", "incompatible"].includes(
      String(candidate.state)
    ) &&
    candidate.version === null &&
    candidate.uptimeSeconds === null
  );
};

export interface LaborerCompanionBridge {
  readonly quit: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly subscribeStatus: (
    listener: (view: OperatorStatusView) => void
  ) => () => void;
}
