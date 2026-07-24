import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Application, ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure, StoreError } from "../src/prototype/errors.ts";
import { makePrototypeHarness, type Runner } from "../src/prototype/runtime.ts";
import { normalizedEvent } from "../src/prototype/scenario.ts";

const LABORER_ID = "ULABORER";
const THREAD_ID = ThreadId.make("CREVIEW:1.0");

const activateConversation = (runner: Runner) =>
  runner.inject(
    normalizedEvent({
      authorSlackId: "UHUMAN",
      channelId: "CREVIEW",
      eventId: "event:review:activation",
      messageTs: "1.0",
      text: `<@${LABORER_ID}> start`,
    })
  );

describe("Runner/store review regressions", () => {
  it.effect(
    "durably fails terminal external HandlerFailure with one sanitized notice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const posted: string[] = [];
          const application = Application.of({
            handle: (event) =>
              event._tag === "ExternalInput"
                ? HandlerFailure.make({
                    category: "exit",
                    safeDetail: "secret process detail",
                  })
                : Effect.void,
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_ID,
            slack: {
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  posted.push(text);
                  return { ts: `posted-${posted.length}` };
                }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* activateConversation(harness.runner);

          yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              conversationId: THREAD_ID,
              eventId: "external:terminal",
              payload: { value: 1 },
              source: "review-test",
            })
          );
          yield* harness.runner.drain(THREAD_ID);
          yield* harness.runner.drain(THREAD_ID);

          const thread = (yield* harness.store.snapshot).threads[0];
          assert.strictEqual(thread?.applicationEvents[0]?.status, "failed");
          assert.deepStrictEqual(
            thread?.outbox.map(({ kind, status, text }) => ({
              kind,
              status,
              text,
            })),
            [
              {
                kind: "operational_notice",
                status: "delivered",
                text: "Application event failed. See Runner logs.",
              },
            ]
          );
          assert.deepStrictEqual(posted, [
            "Application event failed. See Runner logs.",
          ]);
          assert.ok(!posted[0]?.includes("secret process detail"));
        })
      )
  );

  it.effect("keeps signal and timeout external failures replayable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attempts = new Map<string, number>();
        const application = Application.of({
          handle: (event) => {
            if (event._tag === "ParticipantInput") {
              return Effect.void;
            }
            const attempt = (attempts.get(event.eventId) ?? 0) + 1;
            attempts.set(event.eventId, attempt);
            if (attempt > 1) {
              return Effect.void;
            }
            return HandlerFailure.make({
              category: event.eventId.endsWith("signal") ? "signal" : "timeout",
              safeDetail: null,
            });
          },
        });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        yield* activateConversation(harness.runner);

        for (const category of ["signal", "timeout"] as const) {
          const eventId = `external:${category}`;
          yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              conversationId: THREAD_ID,
              eventId,
              payload: null,
              source: "review-test",
            })
          );
          while ((yield* harness.runner.lockCounts).drivers > 0) {
            yield* Effect.yieldNow;
          }

          const interrupted = (yield* harness.store
            .snapshot).threads[0]?.applicationEvents.find(
            (event) => event.eventId === eventId
          );
          assert.strictEqual(interrupted?.status, "running");
          assert.strictEqual(attempts.get(eventId), 1);

          yield* harness.runner.retryInterrupted(THREAD_ID);

          const replayed = (yield* harness.store
            .snapshot).threads[0]?.applicationEvents.find(
            (event) => event.eventId === eventId
          );
          assert.strictEqual(replayed?.status, "completed");
          assert.strictEqual(attempts.get(eventId), 2);
        }
      })
    )
  );

  it.effect("rejects cyclic and BigInt external payloads without defects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const application = Application.of({ handle: () => Effect.void });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        yield* activateConversation(harness.runner);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        for (const [eventId, payload] of [
          ["external:cyclic", cyclic],
          ["external:bigint", { value: 1n }],
        ] as const) {
          const result = yield* Effect.result(
            harness.runner.acceptApplicationEvent(
              ExternalInputEvent.make({
                conversationId: THREAD_ID,
                eventId,
                payload,
                source: "review-test",
              })
            )
          );
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure._tag, "HandlerFailure");
            if (result.failure._tag === "HandlerFailure") {
              assert.strictEqual(result.failure.category, "protocol");
            }
          }
        }

        assert.deepStrictEqual(
          (yield* harness.store.snapshot).threads[0]?.applicationEvents,
          []
        );
      })
    )
  );

  it.effect(
    "treats JSON payloads with different object key order as duplicates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let externalCalls = 0;
          const application = Application.of({
            handle: (event) =>
              Effect.sync(() => {
                if (event._tag === "ExternalInput") {
                  externalCalls += 1;
                }
              }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "unused" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* activateConversation(harness.runner);
          const base = {
            conversationId: THREAD_ID,
            eventId: "external:equivalent-json",
            source: "review-test",
          } as const;

          const first = yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              ...base,
              payload: { alpha: 1, nested: { x: 2, y: 3 } },
            })
          );
          while ((yield* harness.runner.lockCounts).drivers > 0) {
            yield* Effect.yieldNow;
          }
          const duplicate = yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              ...base,
              payload: { nested: { y: 3, x: 2 }, alpha: 1 },
            })
          );
          while ((yield* harness.runner.lockCounts).drivers > 0) {
            yield* Effect.yieldNow;
          }

          assert.strictEqual(first.decision._tag, "Accepted");
          assert.strictEqual(duplicate.decision._tag, "Duplicate");
          assert.strictEqual(externalCalls, 1);
          assert.strictEqual(
            (yield* harness.store.snapshot).threads[0]?.applicationEvents
              .length,
            1
          );
        })
      )
  );

  it.effect("propagates StoreError from an external application handler", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const application = Application.of({
          handle: (event) =>
            event._tag === "ExternalInput"
              ? StoreError.make({
                  operation: "external-handler",
                  reason: "injected",
                })
              : Effect.void,
        });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        yield* activateConversation(harness.runner);
        yield* harness.store.acceptApplicationEvent({
          conversationId: THREAD_ID,
          eventId: "external:store-error",
          payload: null,
          source: "review-test",
        });

        const result = yield* Effect.result(harness.runner.drain(THREAD_ID));

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "StoreError");
          if (result.failure._tag === "StoreError") {
            assert.strictEqual(result.failure.operation, "external-handler");
          }
        }
        const thread = (yield* harness.store.snapshot).threads[0];
        assert.strictEqual(thread?.applicationEvents[0]?.status, "running");
        assert.deepStrictEqual(thread?.outbox, []);
      })
    )
  );

  it.effect("replays the external head before later Conversation inputs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const observed: string[] = [];
        const attempts = new Map<string, number>();
        const application = Application.of({
          handle: (event) => {
            if (event._tag === "ParticipantInput") {
              return Effect.void;
            }
            return Effect.suspend(() => {
              const attempt = (attempts.get(event.eventId) ?? 0) + 1;
              attempts.set(event.eventId, attempt);
              observed.push(`${event.eventId}:${attempt}`);
              return event.eventId === "external:first" && attempt === 1
                ? HandlerFailure.make({
                    category: "signal",
                    safeDetail: null,
                  })
                : Effect.void;
            });
          },
        });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        yield* activateConversation(harness.runner);
        yield* harness.store.acceptApplicationEvent({
          conversationId: THREAD_ID,
          eventId: "external:first",
          payload: null,
          source: "review-test",
        });
        yield* harness.store.acceptApplicationEvent({
          conversationId: THREAD_ID,
          eventId: "external:second",
          payload: null,
          source: "review-test",
        });

        yield* harness.runner.drain(THREAD_ID);
        assert.deepStrictEqual(observed, ["external:first:1"]);

        yield* harness.runner.retryInterrupted(THREAD_ID);

        assert.deepStrictEqual(observed, [
          "external:first:1",
          "external:first:2",
          "external:second:1",
        ]);
        assert.deepStrictEqual(
          (yield* harness.store.snapshot).threads[0]?.applicationEvents.map(
            ({ eventId, status }) => ({ eventId, status })
          ),
          [
            { eventId: "external:first", status: "completed" },
            { eventId: "external:second", status: "completed" },
          ]
        );
      })
    )
  );
});
