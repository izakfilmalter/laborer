import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import type { TerminalLifecycleEvent } from './terminal-manager.js'

export type PtyHostMethod =
  | 'acknowledge'
  | 'attach'
  | 'health'
  | 'kill'
  | 'killAllForWorkspace'
  | 'listTerminals'
  | 'remove'
  | 'resize'
  | 'restart'
  | 'shutdown'
  | 'shutdownIfEmpty'
  | 'setAgentStatusFromHook'
  | 'setObservedWorkspaces'
  | 'setOutputCoalesceWindow'
  | 'reportWorkspacePresence'
  | 'spawn'
  | 'terminalExists'
  | 'transportMetrics'
  | 'unsubscribe'
  | 'write'

export interface PtyHostRequest {
  readonly args: readonly unknown[]
  readonly method: PtyHostMethod
  readonly requestId: string
  readonly type: 'request'
}

export type PtyHostClientMessage = PtyHostRequest

export type PtyHostServerMessage =
  | {
      readonly error?: { readonly code?: string; readonly message: string }
      readonly requestId: string
      readonly result?: unknown
      readonly type: 'response'
    }
  | {
      readonly event: TerminalAttachEvent
      readonly subscriberId: string
      readonly type: 'attach-event'
    }
  | {
      readonly event: TerminalLifecycleEvent
      readonly type: 'lifecycle-event'
    }
