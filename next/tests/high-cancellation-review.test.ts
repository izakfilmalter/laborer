import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Option, Ref } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/core/domain.ts";
import { HandlerFailure } from "../src/core/errors.ts";
import {
  ImplementationAgent,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";

const publishNothing = () => Effect.void;
const acceptEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

it.effect(
  "retains cancelling and fences late completion when remote interrupt fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseCompletion = yield* Deferred.make<void>();
        const completionReturned = yield* Deferred.make<void>();
        const cancellationFailures = yield* Ref.make(0);
        const observedStatuses = yield* Ref.make<readonly string[]>([]);
        const conversationId = ThreadId.make("CCANCELFAIL:1.0");
        const application = yield* makeReferenceCodingApplication({
          conversationAgent: {
            handle: (request) => {
              if (request.source === "inspect") {
                return Ref.set(
                  observedStatuses,
                  request.executions.map((execution) => execution.status)
                ).pipe(Effect.as([] as const));
              }
              if (request.source === "cancel") {
                const cancel = request.executionControls.find(
                  (control) => control.name === "cancel"
                );
                assert.ok(cancel);
                return Effect.result(
                  cancel.invoke({
                    control: "cancel",
                    executionId: "CCANCELFAIL:1.0:execution:1",
                  })
                ).pipe(
                  Effect.tap((result) =>
                    result._tag === "Failure"
                      ? Ref.update(cancellationFailures, (count) => count + 1)
                      : Effect.die(
                          new Error(
                            "remote cancellation unexpectedly succeeded"
                          )
                        )
                  ),
                  Effect.as([] as const)
                );
              }
              const action = request.actions.find(
                (candidate) => candidate.name === "create-feature"
              );
              assert.ok(action);
              return action
                .invoke({
                  prompt: "Finish despite a failed cancellation request.",
                  worktreeName: "failed-cancellation",
                })
                .pipe(Effect.as([] as const));
            },
          },
          implementationAgent: ImplementationAgent.of({
            start: (request) =>
              Effect.succeed({
                completion: Deferred.await(releaseCompletion).pipe(
                  Effect.andThen(
                    Deferred.succeed(completionReturned, undefined)
                  )
                ),
                control: () =>
                  HandlerFailure.make({
                    category: "exit",
                    safeDetail: "remote interrupt failed",
                  }),
                resume: () => Effect.void,
                sessionId: request.implementationSessionId,
              }),
          }),
          worktreeManager: WorktreeManager.of({
            create: () =>
              Effect.succeed({ workingDirectory: "/tmp/failed-cancellation" }),
          }),
        });
        const input = (eventId: string, source: string) =>
          ExternalInputEvent.make({
            conversationId,
            eventId,
            payload: {},
            source,
          });

        yield* application.handle(
          input("event:start", "start"),
          publishNothing,
          acceptEvent
        );
        yield* application.handle(
          input("event:cancel", "cancel"),
          publishNothing,
          acceptEvent
        );
        yield* Deferred.succeed(releaseCompletion, undefined);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.strictEqual(
          Option.isSome(yield* Deferred.poll(completionReturned)),
          true
        );
        yield* application.handle(
          input("event:inspect", "inspect"),
          publishNothing,
          acceptEvent
        );

        assert.strictEqual(yield* Ref.get(cancellationFailures), 1);
        assert.deepStrictEqual(yield* Ref.get(observedStatuses), [
          "cancelling",
        ]);
      })
    )
);
