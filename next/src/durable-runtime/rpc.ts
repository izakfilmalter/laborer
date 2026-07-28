import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ConversationReceipt,
  DurableRuntimeError,
  ExecutionEvent,
  ExecutionSnapshot,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
  RunConversationRequest,
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

export const RunConversationRpcRequest = Schema.Struct({
  ...RunConversationRequest.fields,
  protocolVersion: ProtocolVersion,
});

export const RunConversationRpc = Rpc.make("RootRuntime.RunConversation", {
  error: DurableRuntimeError,
  payload: RunConversationRpcRequest,
  success: ConversationReceipt,
});

export const runConversationRpcLocally = Effect.fn("runConversationRpcLocally")(
  function* (runtime: RootDurableRuntimeShape, untrustedRequest: unknown) {
    const request = yield* Schema.decodeUnknownEffect(
      RunConversationRpcRequest,
      { onExcessProperty: "error" }
    )(untrustedRequest).pipe(
      Effect.mapError(() =>
        DurableRuntimeError.make({ reason: "invalid-payload" })
      )
    );
    const receipt = yield* runtime.runConversation({
      event: request.event,
      rootIdentity: request.rootIdentity,
      workspaceId: request.workspaceId,
    });
    return yield* Schema.decodeUnknownEffect(ConversationReceipt, {
      onExcessProperty: "error",
    })(receipt).pipe(
      Effect.mapError(() =>
        DurableRuntimeError.make({ reason: "storage-failure" })
      )
    );
  }
);

export const GetExecutionRpc = Rpc.make("RootRuntime.GetExecution", {
  error: DurableRuntimeError,
  payload: {
    executionId: RuntimeExecutionId,
    conversationId: RuntimeConversationId,
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
      conversationId: RuntimeConversationId,
      eventId: RuntimeEventId,
      protocolVersion: ProtocolVersion,
    },
    success: Schema.Void,
  }
);

export const RootRuntimeRpcs = RpcGroup.make(
  RunConversationRpc,
  StartExecutionRpc,
  GetExecutionRpc,
  PendingExecutionEventsRpc,
  AcknowledgeExecutionEventRpc
);

export const rootRuntimeRpcHandlers = RootRuntimeRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* RootDurableRuntime;
    return {
      "RootRuntime.AcknowledgeExecutionEvent": ({ conversationId, eventId }) =>
        runtime.acknowledgeEvent(eventId, conversationId),
      "RootRuntime.GetExecution": ({ conversationId, executionId }) =>
        runtime.getExecution(executionId, conversationId),
      "RootRuntime.PendingExecutionEvents": ({ conversationId, limit }) =>
        runtime.pendingEvents(conversationId, limit),
      "RootRuntime.RunConversation": (request) =>
        runtime.runConversation({
          event: request.event,
          rootIdentity: request.rootIdentity,
          workspaceId: request.workspaceId,
        }),
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
