/** THROWAWAY ISSUE #217 CANARY — typed conversation/execution boundary. */

import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Workflow } from "effect/unstable/workflow";

export const ActionStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export class ActionSnapshot extends Schema.Class<ActionSnapshot>(
  "ActionSnapshot"
)({
  result: Schema.NullOr(Schema.String),
  status: ActionStatus,
}) {}

export class StartActionResult extends Schema.Class<StartActionResult>(
  "StartActionResult"
)({
  status: Schema.Literal("queued"),
}) {}

export const StartCanaryAction = Rpc.make("StartCanaryAction", {
  payload: {
    requestId: Schema.String,
    threadId: Schema.String,
  },
  success: StartActionResult,
});

export const GetCurrentAction = Rpc.make("GetCurrentAction", {
  payload: { threadId: Schema.String },
  success: ActionSnapshot,
});

export const ExecutionRpcs = RpcGroup.make(StartCanaryAction, GetCurrentAction);

export const CanaryActionWorkflow = Workflow.make(
  "ConversationExecutionLiveCanary/Action",
  {
    payload: {
      requestId: Schema.String,
      threadId: Schema.String,
    },
    success: Schema.String,
    idempotencyKey: ({ requestId }) => requestId,
  }
);
