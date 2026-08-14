/**
 * Compatibility hook retained until legacy sidecar UI is removed. Recovery is
 * now represented by the daemon RPC supervisor and terminal-host RPC status.
 */
function useSidecarCrashListener(): void {
  // Intentionally empty: no Electron sidecar IPC channel remains.
}

export { useSidecarCrashListener }
