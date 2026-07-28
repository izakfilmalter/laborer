import { Effect } from "effect";
import type {
  AcceptApplicationEvent,
  ApplicationPublicOutput,
  ApplicationShape,
  ConversationBlocked,
  PublishApplicationOutput,
} from "../application.ts";
import type { StoreError } from "../prototype/errors.ts";
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
  const failures = new Map<
    string,
    ConversationBlocked | HandlerFailure | StoreError
  >();
  const publishers = new Map<string, PublishApplicationOutput>();
  const handledEvents = new Set<string>();
  yield* options.runtime
    .registerConversationHandler(options.workspaceId, {
      handle: (event) =>
        Effect.gen(function* () {
          handledEvents.add(event.turnId);
          const outputs: ApplicationPublicOutput[] = [];
          yield* options.application
            .handle(
              event,
              (output) =>
                Effect.gen(function* () {
                  outputs.push(output);
                  const publish = publishers.get(event.turnId);
                  if (publish !== undefined) {
                    yield* publish(output);
                  }
                }),
              eventAcceptors.get(event.turnId) ?? unavailableEventAcceptance
            )
            .pipe(
              Effect.tapError((failure) =>
                Effect.sync(() => {
                  failures.set(event.turnId, failure);
                })
              )
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
          failures.delete(event.turnId);
          handledEvents.delete(event.turnId);
          publishers.set(event.turnId, publish);
        }),
        () =>
          runConversationRpcLocally(options.runtime, {
            event,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            rootIdentity: options.rootIdentity,
            workspaceId: options.workspaceId,
          }).pipe(
            Effect.catch((error) => {
              const failure = failures.get(event.turnId);
              return failure === undefined
                ? Effect.fail(runtimeFailure(error))
                : Effect.fail(failure);
            }),
            Effect.flatMap((receipt) =>
              handledEvents.has(event.turnId)
                ? Effect.void
                : Effect.forEach(receipt.outputs, publish, { discard: true })
            )
          ),
        () =>
          Effect.sync(() => {
            eventAcceptors.delete(event.turnId);
            failures.delete(event.turnId);
            handledEvents.delete(event.turnId);
            publishers.delete(event.turnId);
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
