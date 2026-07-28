import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  CancelExecutionRequest,
  ConversationClientCompatibility,
  ConversationReceipt,
  DurableRuntimeError,
  ExecutionControlReceipt,
  ExecutionEvent,
  ExecutionSnapshot,
  FollowUpExecutionRequest,
  InspectExecutionRequest,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
  RunConversationRequest,
  RuntimeConversationId,
  RuntimeEventId,
  RuntimeExecutionId,
  RuntimeWorkspaceId,
  StartExecutionRequest,
} from "./root-runtime.ts";

export const ROOT_RUNTIME_PROTOCOL_VERSION = 4;

const ProtocolVersion = Schema.Literal(ROOT_RUNTIME_PROTOCOL_VERSION);

export const AttachConversationClientRpcRequest = Schema.Struct({
  compatibility: ConversationClientCompatibility,
  protocolVersion: ProtocolVersion,
  workspaceId: RuntimeWorkspaceId,
});

export const NegotiateConversationClientRpc = Rpc.make(
  "RootRuntime.NegotiateConversationClient",
  {
    error: DurableRuntimeError,
    payload: AttachConversationClientRpcRequest,
    success: Schema.Void,
  }
);

/**
 * Establishes the scoped, process-local delivery half of the versioned RPC
 * boundary. The callback is deliberately not an RPC payload; remote transports
 * negotiate this request first and then bind their connection-owned handler.
 */
export const attachConversationClientLocally = Effect.fn(
  "attachConversationClientLocally"
)(function* (
  runtime: RootDurableRuntimeShape,
  untrustedRequest: unknown,
  handler: Parameters<RootDurableRuntimeShape["attachConversationClient"]>[2]
) {
  const request = yield* Schema.decodeUnknownEffect(
    AttachConversationClientRpcRequest,
    { onExcessProperty: "error" }
  )(untrustedRequest).pipe(
    Effect.mapError(() =>
      DurableRuntimeError.make({ reason: "incompatible-client" })
    )
  );
  if (request.protocolVersion !== ROOT_RUNTIME_PROTOCOL_VERSION) {
    return yield* DurableRuntimeError.make({ reason: "incompatible-client" });
  }
  yield* runtime.attachConversationClient(
    request.compatibility,
    request.workspaceId,
    handler
  );
});

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
    workspaceId: RuntimeWorkspaceId,
  },
  success: ExecutionSnapshot,
});

export const InspectExecutionRpc = Rpc.make("RootRuntime.InspectExecution", {
  error: DurableRuntimeError,
  payload: Schema.Struct({
    ...InspectExecutionRequest.fields,
    protocolVersion: ProtocolVersion,
  }),
  success: ExecutionControlReceipt,
});

export const FollowUpExecutionRpc = Rpc.make("RootRuntime.FollowUpExecution", {
  error: DurableRuntimeError,
  payload: Schema.Struct({
    ...FollowUpExecutionRequest.fields,
    protocolVersion: ProtocolVersion,
  }),
  success: ExecutionControlReceipt,
});

export const CancelExecutionRpc = Rpc.make("RootRuntime.CancelExecution", {
  error: DurableRuntimeError,
  payload: Schema.Struct({
    ...CancelExecutionRequest.fields,
    protocolVersion: ProtocolVersion,
  }),
  success: ExecutionControlReceipt,
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
      workspaceId: RuntimeWorkspaceId,
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
      workspaceId: RuntimeWorkspaceId,
    },
    success: Schema.Void,
  }
);

export const RootRuntimeRpcs = RpcGroup.make(
  NegotiateConversationClientRpc,
  RunConversationRpc,
  StartExecutionRpc,
  GetExecutionRpc,
  InspectExecutionRpc,
  FollowUpExecutionRpc,
  CancelExecutionRpc,
  PendingExecutionEventsRpc,
  AcknowledgeExecutionEventRpc
);

export const rootRuntimeRpcHandlers = RootRuntimeRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* RootDurableRuntime;
    return {
      "RootRuntime.AcknowledgeExecutionEvent": ({
        conversationId,
        eventId,
        workspaceId,
      }) => runtime.acknowledgeEvent(eventId, conversationId, workspaceId),
      "RootRuntime.GetExecution": ({
        conversationId,
        executionId,
        workspaceId,
      }) => runtime.getExecution(executionId, conversationId, workspaceId),
      "RootRuntime.InspectExecution": ({
        controlId,
        conversationId,
        executionId,
        workspaceId,
      }) =>
        runtime.inspectExecution({
          controlId,
          conversationId,
          executionId,
          workspaceId,
        }),
      "RootRuntime.NegotiateConversationClient": ({ compatibility }) =>
        runtime.checkConversationClientCompatibility(compatibility),
      "RootRuntime.FollowUpExecution": ({
        content,
        controlId,
        conversationId,
        executionId,
        workspaceId,
      }) =>
        runtime.followUpExecution({
          content,
          controlId,
          conversationId,
          executionId,
          workspaceId,
        }),
      "RootRuntime.CancelExecution": ({
        controlId,
        conversationId,
        executionId,
        workspaceId,
      }) =>
        runtime.cancelExecution({
          controlId,
          conversationId,
          executionId,
          workspaceId,
        }),
      "RootRuntime.PendingExecutionEvents": ({
        conversationId,
        limit,
        workspaceId,
      }) => runtime.pendingEvents(conversationId, workspaceId, limit),
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
          workspaceId: request.workspaceId,
        }),
    };
  })
);
