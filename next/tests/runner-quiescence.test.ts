import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const event = (eventId: string, messageTs: string, text: string) => ({
  authorKind: "human" as const,
  authorSlackId: "UHUMAN",
  channelId: "CQUIESCE",
  channelKind: "public" as const,
  eventId,
  messageTs,
  recordKind: "message" as const,
  text,
  threadTs: messageTs === "1.0" ? null : "1.0",
});

describe("Runner generation quiescence", () => {
  it.effect("persists later input without admitting a late driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const invocations = yield* Ref.make(0);
        const harness = yield* makePrototypeHarness({
          handler: {
            invoke: () =>
              Effect.gen(function* () {
                const invocation = yield* Ref.updateAndGet(
                  invocations,
                  (count) => count + 1
                );
                if (invocation === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                }
              }),
          },
          laborerSlackId: "ULABORER",
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });

        yield* harness.runner.accept(
          event("event:quiesce:first", "1.0", "<@ULABORER> begin")
        );
        yield* Deferred.await(firstStarted);
        const quiescence = yield* harness.runner.quiesce.pipe(
          Effect.forkScoped({ startImmediately: true })
        );
        const conversationId = (yield* harness.store.snapshot).threads[0]?.id;
        assert.ok(conversationId);
        const laterEvent = ExternalInputEvent.make({
          conversationId,
          eventId: "event:quiesce:second",
          payload: { status: "completed" },
          source: "fixture",
        });
        const deferred =
          yield* harness.runner.acceptApplicationEvent(laterEvent);

        assert.strictEqual(deferred.decision._tag, "Accepted");
        assert.strictEqual(deferred.scheduling, "Deferred");
        assert.strictEqual(yield* Ref.get(invocations), 1);
        assert.strictEqual(quiescence.pollUnsafe(), undefined);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(quiescence);
        assert.strictEqual(yield* Ref.get(invocations), 1);

        const duplicate =
          yield* harness.runner.acceptApplicationEvent(laterEvent);
        assert.strictEqual(duplicate.decision._tag, "Duplicate");
        assert.strictEqual(duplicate.scheduling, "Deferred");
        yield* harness.runner.quiesce;
      })
    )
  );

  it.effect("lets a replacement recover deferred work exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-quiescence-");
        const statePath = join(root, "runner.json");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstStore = makeFileStoreLayer(
          "ULABORER",
          statePath,
          root,
          undefined,
          { initializeNewThreads: false }
        );
        let durableConversationId:
          | (typeof ExternalInputEvent.Type)["conversationId"]
          | null = null;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makePrototypeHarness({
              handler: {
                invoke: () =>
                  Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirst))
                  ),
              },
              laborerSlackId: "ULABORER",
              slack: {
                postThreadMessage: () => Effect.succeed({ ts: "unused" }),
                readActivationContext: () => Effect.succeed([]),
              },
              storeLayer: firstStore,
            });
            yield* harness.runner.accept(
              event("event:restart:first", "1.0", "<@ULABORER> begin")
            );
            yield* Deferred.await(firstStarted);
            const quiescence = yield* harness.runner.quiesce.pipe(
              Effect.forkScoped({ startImmediately: true })
            );
            const conversationId = (yield* harness.store.snapshot).threads[0]
              ?.id;
            assert.ok(conversationId);
            durableConversationId = conversationId;
            const accepted = yield* harness.runner.acceptApplicationEvent(
              ExternalInputEvent.make({
                conversationId,
                eventId: "event:restart:deferred",
                payload: { value: 1 },
                source: "fixture",
              })
            );
            assert.strictEqual(accepted.scheduling, "Deferred");
            yield* Deferred.succeed(releaseFirst, undefined);
            yield* Fiber.join(quiescence);
          })
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makePrototypeHarness({
              handler: {
                invoke: () => Effect.void,
              },
              laborerSlackId: "ULABORER",
              slack: {
                postThreadMessage: () => Effect.succeed({ ts: "unused" }),
                readActivationContext: () => Effect.succeed([]),
              },
              storeLayer: makeFileStoreLayer(
                "ULABORER",
                statePath,
                root,
                undefined,
                { initializeNewThreads: false }
              ),
            });
            assert.ok(durableConversationId);
            yield* harness.runner.drain(durableConversationId);
            const snapshot = yield* harness.store.snapshot;
            const applicationEvents = snapshot.threads[0]?.applicationEvents;
            assert.ok(applicationEvents);
            assert.strictEqual(applicationEvents?.length, 1);
            assert.notStrictEqual(applicationEvents[0]?.status, "pending");
          })
        );
      })
    )
  );
});
