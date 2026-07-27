import { useSyncExternalStore } from "react";
import type { OperatorStatusView } from "../../operator-status/client.ts";

let currentStatus: OperatorStatusView = {
  state: "connecting",
  uptimeSeconds: null,
  version: null,
};
const listeners = new Set<() => void>();
let bridgeCleanup: (() => void) | null = null;

export const initializeStatusStore = (): void => {
  if (bridgeCleanup !== null) {
    return;
  }
  bridgeCleanup = window.laborerCompanion.subscribeStatus((status) => {
    currentStatus = status;
    for (const listener of listeners) {
      listener();
    }
  });
};

export const useOperatorStatus = (): OperatorStatusView =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentStatus,
    () => currentStatus
  );
