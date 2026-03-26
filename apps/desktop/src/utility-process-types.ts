/**
 * Types for communication between the Electron main process and
 * utility processes via `process.parentPort` / `MessagePort`.
 *
 * These types define the bootstrap protocol — the messages exchanged
 * during utility process startup — and the port transfer protocol
 * used by the UtilityProcessManager.
 */

// ---------------------------------------------------------------------------
// Bootstrap messages (utility process -> parent)
// ---------------------------------------------------------------------------

/** Sent when the utility process has successfully loaded its service module. */
export interface UtilityProcessReadyMessage {
  readonly type: 'ready'
}

/** Sent when the utility process fails to load its service module. */
export interface UtilityProcessErrorMessage {
  readonly message: string
  readonly type: 'error'
}

/**
 * Periodic heartbeat sent by utility processes to indicate liveness.
 * The LifecycleMonitor uses these to detect unresponsive processes.
 *
 * @see VS Code's HeartbeatService at
 *   `.reference/vscode/src/vs/platform/terminal/node/heartbeatService.ts`
 */
export interface UtilityProcessHeartbeatMessage {
  readonly type: 'heartbeat'
}

/** All messages a utility process can send to the parent process. */
export type UtilityProcessBootstrapMessage =
  | UtilityProcessReadyMessage
  | UtilityProcessErrorMessage
  | UtilityProcessHeartbeatMessage

// ---------------------------------------------------------------------------
// Port transfer messages (parent -> utility process)
// ---------------------------------------------------------------------------

/**
 * Sent by the main process to transfer a MessagePort to the utility process.
 * The actual MessagePort is in the `ports` array of the MessageEvent.
 */
export interface PortTransferMessage {
  readonly type: 'port'
}

/**
 * Sent by the main process to transfer a per-terminal data channel
 * MessagePort to the terminal utility process. The actual MessagePort
 * is in the `ports` array of the MessageEvent.
 *
 * The terminal utility process uses this port for bidirectional
 * PTY I/O streaming (output from node-pty, input from the renderer)
 * instead of the WebSocket data channel.
 */
export interface TerminalDataPortMessage {
  readonly terminalId: string
  readonly type: 'terminal-data-port'
}

/** All messages the main process can send to a utility process. */
export type UtilityProcessParentMessage =
  | PortTransferMessage
  | TerminalDataPortMessage
