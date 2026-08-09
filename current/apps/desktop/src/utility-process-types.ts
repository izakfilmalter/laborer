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
  | TerminalAgentStatusMessage

/** Ephemeral per-terminal agent fact forwarded to the main coordinator. */
export interface TerminalAgentStatusMessage {
  readonly agentId: string
  readonly agentName: string
  readonly status: import('@laborer/shared/rpc').AgentStatus | null
  readonly terminalId: string
  readonly type: 'terminal-agent-status'
  readonly workspaceId: string
}

const AGENT_STATUSES = new Set(['working', 'needs_input', 'idle', 'unknown'])

/** Decode the child-process boundary before notification facts reach policy. */
export function isUtilityProcessBootstrapMessage(
  value: unknown
): value is UtilityProcessBootstrapMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  if (value.type === 'ready' || value.type === 'heartbeat') {
    return true
  }
  if (value.type === 'error') {
    return (
      'message' in value &&
      typeof value.message === 'string' &&
      value.message.length <= 10_000
    )
  }
  if (value.type !== 'terminal-agent-status') {
    return false
  }
  return (
    'agentId' in value &&
    typeof value.agentId === 'string' &&
    value.agentId.length > 0 &&
    value.agentId.length <= 1000 &&
    'agentName' in value &&
    typeof value.agentName === 'string' &&
    value.agentName.length > 0 &&
    value.agentName.length <= 200 &&
    'status' in value &&
    (value.status === null ||
      (typeof value.status === 'string' && AGENT_STATUSES.has(value.status))) &&
    'terminalId' in value &&
    typeof value.terminalId === 'string' &&
    value.terminalId.length > 0 &&
    value.terminalId.length <= 1000 &&
    'workspaceId' in value &&
    typeof value.workspaceId === 'string' &&
    value.workspaceId.length <= 1000
  )
}

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

/**
 * Sent by the main process to transfer a MessagePort for file-watcher RPC
 * to the server utility process. The actual MessagePort is in the
 * `ports` array of the MessageEvent.
 *
 * The server utility process uses this port as an RPC client to call
 * `FileWatcherRpcs` on the file-watcher utility process, replacing the
 * HTTP-based `createSidecarRpcClient(FileWatcherRpcs, url)`.
 *
 * @see Issue #14: File-watcher as utility process
 */
export interface FileWatcherRpcPortMessage {
  readonly type: 'file-watcher-rpc-port'
}

/**
 * Sent by the main process to transfer a per-terminal data channel
 * MessagePort to the server utility process for Daytona PTY sessions.
 * The actual MessagePort is in the `ports` array of the MessageEvent.
 *
 * Daytona PTY sessions are managed by the server utility process (not
 * the terminal utility process) because the Daytona SDK WebSocket
 * connection lives in the server. Terminal IDs with the `daytona:`
 * prefix are routed here instead of to the terminal utility process.
 *
 * @see Issue #17: Daytona PTY — bridge to xterm.js terminal component
 */
export interface DaytonaTerminalDataPortMessage {
  readonly terminalId: string
  readonly type: 'daytona-terminal-data-port'
}

/** Focused-and-visible workspace facts owned by Electron main. */
export interface WorkspacePresenceMessage {
  readonly type: 'workspace-presence'
  readonly workspaceIds: readonly string[]
}

/** All messages the main process can send to a utility process. */
export type UtilityProcessParentMessage =
  | PortTransferMessage
  | TerminalDataPortMessage
  | SyncPortMessage
  | TerminalRpcPortMessage
  | FileWatcherRpcPortMessage
  | DaytonaTerminalDataPortMessage
  | WorkspacePresenceMessage
