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

/**
 * Sent by the main process to transfer a dedicated LiveStore sync
 * MessagePort to the server utility process. The actual MessagePort
 * is in the `ports` array of the MessageEvent.
 *
 * The server utility process serves `SyncWsRpc` (Pull/Push) handlers
 * over this port, enabling the renderer's LiveStore worker to sync
 * events without WebSocket.
 *
 * @see Issue #11: LiveStore sync over MessagePort
 */
export interface SyncPortMessage {
  readonly type: 'sync-port'
}

/**
 * Sent by the main process to transfer a MessagePort for terminal RPC
 * to the server utility process. The actual MessagePort is in the
 * `ports` array of the MessageEvent.
 *
 * The server utility process uses this port as an RPC client to call
 * `TerminalRpcs` on the terminal utility process, replacing the
 * HTTP-based `createSidecarRpcClient(TerminalRpcs, url)`.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */
export interface TerminalRpcPortMessage {
  readonly type: 'terminal-rpc-port'
}

/** All messages the main process can send to a utility process. */
export type UtilityProcessParentMessage =
  | PortTransferMessage
  | TerminalDataPortMessage
  | SyncPortMessage
  | TerminalRpcPortMessage
