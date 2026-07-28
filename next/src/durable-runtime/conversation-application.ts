import { Effect } from "effect";
import type {
  AcceptApplicationEvent,
  ApplicationPublicOutput,
  ApplicationShape,
} from "../application.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  DurableRuntimeError,
  RootDurableRuntimeShape,
} from "./root-runtime.ts";
import {
  ROOT_RUNTIME_PROTOCOL_VERSION,
  runConversationRpcLocally,
} from "./rpc.ts";

const runtimeFailure = (_error: DurableRuntimeError): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "durable Conversation runtime unavailable",
  });

const unavailableEventAcceptance: AcceptApplicationEvent = () =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "durable external-event acceptance unavailable",
  });

/**
 * Routes participant turns through the root owner while retaining the existing
 * Runner as the only publisher. Execution events remain on their current seam
 * until their dedicated cutover slice.
 */
export const applicationThroughRootConversationRuntime = Effect.fn(
  "applicationThroughRootConversationRuntime"
)(function* (options: {
  readonly application: ApplicationShape;
  readonly rootIdentity: string;
  readonly runtime: RootDurableRuntimeShape;
  readonly workspaceId: string;
}) {
  const eventAcceptors = new Map<string, AcceptApplicationEvent>();
  yield* options.runtime
    .registerConversationHandler(options.workspaceId, {
      handle: (event) =>
        Effect.gen(function* () {
          const outputs: ApplicationPublicOutput[] = [];
          yield* options.application.handle(
            event,
            (output) =>
              Effect.sync(() => {
                outputs.push(output);
              }),
            eventAcceptors.get(event.turnId) ?? unavailableEventAcceptance
          );
          return outputs;
        }),
    })
    .pipe(Effect.mapError(runtimeFailure));

  return {
    ...(options.application.decideConversationRecovery === undefined
      ? {}
      : {
          decideConversationRecovery:
            options.application.decideConversationRecovery,
        }),
    handle: (event, publish, acceptEvent) => {
      if (event._tag !== "ParticipantInput") {
        return options.application.handle(event, publish, acceptEvent);
      }
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          eventAcceptors.set(event.turnId, acceptEvent);
        }),
        () =>
          runConversationRpcLocally(options.runtime, {
            event,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            rootIdentity: options.rootIdentity,
            workspaceId: options.workspaceId,
          }).pipe(
            Effect.mapError(runtimeFailure),
            Effect.flatMap((receipt) =>
              Effect.forEach(receipt.outputs, publish, { discard: true })
            )
          ),
        () =>
          Effect.sync(() => {
            eventAcceptors.delete(event.turnId);
          })
      );
    },
    ...(options.application.recover === undefined
      ? {}
      : { recover: options.application.recover }),
    ...(options.application.unresolvedConversationForOwner === undefined
      ? {}
      : {
          unresolvedConversationForOwner:
            options.application.unresolvedConversationForOwner,
        }),
    ...(options.application.unresolvedConversations === undefined
      ? {}
      : {
          unresolvedConversations: options.application.unresolvedConversations,
        }),
  } satisfies ApplicationShape;
});
