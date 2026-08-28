import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import {
  BrowserContextItem,
  BrowserControlOperation,
} from './browser-control.js'

const WorkspaceId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1)
)
const BoundedId = WorkspaceId.check(Schema.isMaxLength(128))

/** Daemon RPC subset used by the workspace-scoped browser MCP adapter. */
export class BrowserAgentRpcs extends RpcGroup.make(
  Rpc.make('browserControl.invoke', {
    success: Schema.Unknown,
    error: Schema.Unknown,
    payload: {
      workspaceId: WorkspaceId,
      controllerId: BoundedId,
      tabId: Schema.optional(BoundedId),
      operation: BrowserControlOperation,
      input: Schema.Unknown,
      timeoutMs: Schema.optional(Schema.Int),
    },
  }),
  Rpc.make('browserContext.list', {
    success: Schema.Array(BrowserContextItem),
    error: Schema.Unknown,
    payload: {
      workspaceId: WorkspaceId,
      includeConsumed: Schema.optional(Schema.Boolean),
    },
  }),
  Rpc.make('browserContext.consume', {
    success: BrowserContextItem,
    error: Schema.Unknown,
    payload: { workspaceId: WorkspaceId, id: BoundedId },
  })
) {}
