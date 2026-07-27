import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DurableRuntimeError,
  ExecutionEvent,
  ExecutionSnapshot,
  RootDurableRuntime,
  RuntimeConversationId,
  RuntimeEventId,
  RuntimeExecutionId,
  StartExecutionRequest,
} from "./root-runtime.ts";

export const ROOT_RUNTIME_PROTOCOL_VERSION = 1;

const ProtocolVersion = Schema.Literal(ROOT_RUNTIME_PROTOCOL_VERSION);

export const StartExecutionRpc = Rpc.make("RootRuntime.StartExecution", {
  error: DurableRuntimeError,
  payload: Schema.Struct({
    ...StartExecutionRequest.fields,
    protocolVersion: ProtocolVersion,
  }),
  success: ExecutionSnapshot,
});

export const GetExecutionRpc = Rpc.make("RootRuntime.GetExecution", {
  error: DurableRuntimeError,
  payload: {
    executionId: RuntimeExecutionId,
    protocolVersion: ProtocolVersion,
  },
  success: ExecutionSnapshot,
});

export const PendingExecutionEventsRpc = Rpc.make(
  "RootRuntime.PendingExecutionEvents",
  {
    error: DurableRuntimeError,
    payload: {
      conversationId: RuntimeConversationId,
      limit: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(128)
      ),
      protocolVersion: ProtocolVersion,
    },
    success: Schema.Array(ExecutionEvent),
  }
);

export const AcknowledgeExecutionEventRpc = Rpc.make(
  "RootRuntime.AcknowledgeExecutionEvent",
  {
    error: DurableRuntimeError,
    payload: {
      eventId: RuntimeEventId,
      protocolVersion: ProtocolVersion,
    },
    success: Schema.Void,
  }
);

export const RootRuntimeRpcs = RpcGroup.make(
  StartExecutionRpc,
  GetExecutionRpc,
  PendingExecutionEventsRpc,
  AcknowledgeExecutionEventRpc
);

export const rootRuntimeRpcHandlers = RootRuntimeRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* RootDurableRuntime;
    return {
      "RootRuntime.AcknowledgeExecutionEvent": ({ eventId }) =>
        runtime.acknowledgeEvent(eventId),
      "RootRuntime.GetExecution": ({ executionId }) =>
        runtime.getExecution(executionId),
      "RootRuntime.PendingExecutionEvents": ({ conversationId, limit }) =>
        runtime.pendingEvents(conversationId, limit),
      "RootRuntime.StartExecution": (request) =>
        runtime.startExecution({
          actionName: request.actionName,
          conversationId: request.conversationId,
          input: request.input,
          invocationId: request.invocationId,
          rootIdentity: request.rootIdentity,
        }),
    };
  })
);
