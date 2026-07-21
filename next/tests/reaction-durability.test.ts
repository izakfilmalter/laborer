import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import type { PrototypeState } from "../src/prototype/domain.ts";
import { DeliveryError, type StoreError } from "../src/prototype/errors.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const slack = {
  postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
  readActivationContext: () => Effect.succeed([]),
};

const activation = normalizedEvent({
  authorSlackId: "UHUMAN",
  channelId: "CREACTION",
  eventId: "event:reaction",
  messageTs: "1.0",
  text: `<@${LABORER_SLACK_ID}> react`,
});

const waitForAcknowledgementsToClear = Effect.fnUntraced(function* (
  snapshot: Effect.Effect<PrototypeState, StoreError>
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((yield* snapshot).acknowledgements.length === 0) {
      return;
    }
    yield* Effect.sleep("25 millis");
  }
  assert.fail(
    `acknowledgement cleanup timed out: ${JSON.stringify((yield* snapshot).acknowledgements)}`
  );
});

const waitForAcknowledgementStatus = Effect.fnUntraced(function* (
  snapshot: Effect.Effect<PrototypeState, StoreError>,
  status: PrototypeState["acknowledgements"][number]["status"]
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const acknowledgement = (yield* snapshot).acknowledgements[0];
    if (acknowledgement?.status === status) {
      return acknowledgement;
    }
    yield* Effect.sleep("25 millis");
  }
  assert.fail(
    `acknowledgement did not reach ${status}: ${JSON.stringify((yield* snapshot).acknowledgements)}`
  );
});

const activationWithEventId = (eventId: string) =>
  normalizedEvent({
    authorSlackId: "UHUMAN",
    channelId: "CREACTION",
    eventId,
    messageTs: "1.0",
    text: `<@${LABORER_SLACK_ID}> react`,
  });

describe("durable activation reaction lifecycle", () => {
  it.live("retries transient add and remove failures before completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* Ref.make<readonly string[]>([]);
        let addAttempts = 0;
        let removeAttempts = 0;
        const harness = yield* makePrototypeHarness({
          activationAcknowledger: {
            acknowledge: () => {
              addAttempts += 1;
              return Ref.update(lifecycle, (events) => [
                ...events,
                `add:${addAttempts}`,
              ]).pipe(
                Effect.andThen(
                  addAttempts < 3
                    ? DeliveryError.make({
                        category: "ratelimited",
                        disposition: "transient",
                        retryAfterMillis: 1,
                      })
                    : Effect.void
                )
              );
            },
            complete: () => {
              removeAttempts += 1;
              return Ref.update(lifecycle, (events) => [
                ...events,
                `remove:${removeAttempts}`,
              ]).pipe(
                Effect.andThen(
                  removeAttempts < 2
                    ? DeliveryError.make({
                        category: "request_error",
                        disposition: "transient",
                        retryAfterMillis: 1,
                      })
                    : Effect.void
                )
              );
            },
          },
          handler: {
            invoke: () =>
              Ref.update(lifecycle, (events) => [...events, "handler"]),
          },
          laborerSlackId: LABORER_SLACK_ID,
          slack,
        });
        yield* harness.runner.inject(activation);
        yield* waitForAcknowledgementsToClear(harness.store.snapshot);
        const events = yield* Ref.get(lifecycle);
        assert.ok(events.includes("handler"));
        assert.deepStrictEqual(
          events.filter((event) => event.startsWith("add:")),
          ["add:1", "add:2", "add:3"]
        );
        assert.deepStrictEqual(events.slice(-2), ["remove:1", "remove:2"]);
        assert.deepStrictEqual(
          (yield* harness.store.snapshot).acknowledgements,
          []
        );
      })
    )
  );

  it.effect(
    "keeps permanent reaction errors observable without blocking work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let handlerRan = false;
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: {
              acknowledge: () =>
                DeliveryError.make({
                  category: "missing_scope",
                  disposition: "destination-permanent",
                  retryAfterMillis: 0,
                }),
              complete: () => Effect.void,
            },
            handler: {
              invoke: () =>
                Effect.sync(() => {
                  handlerRan = true;
                }),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          yield* harness.runner.inject(activation);
          const acknowledgement = yield* waitForAcknowledgementStatus(
            harness.store.snapshot,
            "permanent_failure"
          );
          assert.strictEqual(handlerRan, true);
          assert.strictEqual(acknowledgement?.status, "permanent_failure");
          assert.strictEqual(
            acknowledgement?.lastErrorCategory,
            "missing_scope"
          );
        })
      )
  );

  it.live(
    "serializes a late first add through cleanup without leaving an orphan",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: string[] = [];
          let addAttempts = 0;
          let handlerCompleted = false;
          let inFlight = 0;
          let maximumInFlight = 0;
          let reactionPresent = false;
          let completeFirstAdd = (): void => {
            assert.fail("first add resolver was not initialized");
          };
          const firstAdd = new Promise<void>((resolveFirstAdd) => {
            completeFirstAdd = resolveFirstAdd;
          });
          const beginOperation = (): void => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
          };
          const endOperation = (): void => {
            inFlight -= 1;
          };
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: {
              acknowledge: () =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolveAdd) => {
                      addAttempts += 1;
                      const attempt = addAttempts;
                      beginOperation();
                      lifecycle.push(`add:${attempt}:started`);
                      const finishAdd = (): void => {
                        reactionPresent = true;
                        lifecycle.push(`add:${attempt}:completed`);
                        endOperation();
                        resolveAdd();
                      };
                      if (attempt === 1) {
                        firstAdd.then(finishAdd);
                      } else {
                        finishAdd();
                      }
                    })
                ),
              complete: () =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolveRemove) => {
                      beginOperation();
                      lifecycle.push("remove:started");
                      reactionPresent = false;
                      lifecycle.push("remove:completed");
                      endOperation();
                      resolveRemove();
                    })
                ),
            },
            handler: {
              invoke: () =>
                Effect.sync(() => {
                  handlerCompleted = true;
                  lifecycle.push("handler:completed");
                }),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });

          yield* harness.runner.inject(
            activationWithEventId("event:late-reaction-add")
          );
          assert.strictEqual(handlerCompleted, true);
          assert.strictEqual(reactionPresent, false);
          yield* Effect.sleep("300 millis");
          assert.strictEqual(addAttempts, 1);
          assert.strictEqual(maximumInFlight, 1);
          completeFirstAdd();
          yield* waitForAcknowledgementsToClear(harness.store.snapshot);
          yield* Effect.sleep("25 millis");

          assert.strictEqual(addAttempts, 1);
          assert.strictEqual(maximumInFlight, 1);
          assert.strictEqual(inFlight, 0);
          assert.strictEqual(reactionPresent, false);
          assert.ok(
            lifecycle.indexOf("handler:completed") <
              lifecycle.indexOf("add:1:completed")
          );
          assert.ok(
            lifecycle.indexOf("add:1:completed") <
              lifecycle.indexOf("remove:started")
          );
        })
      ),
    10_000
  );

  it.live("removes a precise closed-owner active-reaction crash snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-reaction-recovery-"
        );
        const snapshotPath = join(temporaryRoot, "snapshot.json");
        const closedOwnerSnapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            let markHandlerStarted = (): void => undefined;
            const handlerStarted = new Promise<void>((resolveStarted) => {
              markHandlerStarted = resolveStarted;
            });
            const firstHarness = yield* makePrototypeHarness({
              activationAcknowledger: {
                acknowledge: () => Effect.void,
                complete: () => Effect.void,
              },
              handler: {
                invoke: () =>
                  Effect.sync(markHandlerStarted).pipe(
                    Effect.andThen(Effect.never)
                  ),
              },
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                snapshotPath,
                temporaryRoot
              ),
            });
            const interruptedProcess = yield* Effect.forkChild(
              firstHarness.runner.inject(activation)
            );
            yield* Effect.promise(() => handlerStarted);
            const snapshot = yield* firstHarness.store.snapshot;
            assert.strictEqual(snapshot.acknowledgements[0]?.status, "active");
            yield* Fiber.interrupt(interruptedProcess);
            return snapshot;
          })
        );
        yield* Effect.promise(() =>
          writeFile(snapshotPath, JSON.stringify(closedOwnerSnapshot), "utf8")
        );

        let staleReactionRemoved = false;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const recoveredHarness = yield* makePrototypeHarness({
              activationAcknowledger: {
                acknowledge: () => Effect.void,
                complete: () =>
                  Effect.sync(() => {
                    staleReactionRemoved = true;
                  }),
              },
              handler: { invoke: () => Effect.void },
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                snapshotPath,
                temporaryRoot
              ),
            });
            yield* waitForAcknowledgementsToClear(
              recoveredHarness.store.snapshot
            );
            assert.deepStrictEqual(
              (yield* recoveredHarness.store.snapshot).acknowledgements,
              []
            );
          })
        );
        assert.strictEqual(staleReactionRemoved, true);
      })
    )
  );

  it.live("honors a retry beyond one second and clears the hourglass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let removeAttempts = 0;
        const startedAt = Date.now();
        const harness = yield* makePrototypeHarness({
          activationAcknowledger: {
            acknowledge: () => Effect.void,
            complete: () => {
              removeAttempts += 1;
              return removeAttempts === 1
                ? DeliveryError.make({
                    category: "ratelimited",
                    disposition: "transient",
                    retryAfterMillis: 1200,
                  })
                : Effect.void;
            },
          },
          handler: { invoke: () => Effect.void },
          laborerSlackId: LABORER_SLACK_ID,
          slack,
        });
        yield* harness.runner.inject(activationWithEventId("event:long-retry"));
        yield* waitForAcknowledgementsToClear(harness.store.snapshot);
        assert.strictEqual(removeAttempts, 2);
        assert.ok(Date.now() - startedAt >= 1100);
      })
    )
  );

  it.live("keeps retrying repeated transient removes until success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let removeAttempts = 0;
        const harness = yield* makePrototypeHarness({
          activationAcknowledger: {
            acknowledge: () => Effect.void,
            complete: () => {
              removeAttempts += 1;
              return removeAttempts < 6
                ? DeliveryError.make({
                    category: "request_error",
                    disposition: "transient",
                    retryAfterMillis: 5,
                  })
                : Effect.void;
            },
          },
          handler: { invoke: () => Effect.void },
          laborerSlackId: LABORER_SLACK_ID,
          slack,
        });
        yield* harness.runner.inject(
          activationWithEventId("event:repeated-remove")
        );
        yield* waitForAcknowledgementsToClear(harness.store.snapshot);
        assert.strictEqual(removeAttempts, 6);
      })
    )
  );

  it.live(
    "recovers add_pending by idempotently adding before removal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-add-pending-recovery-"
          );
          const snapshotPath = join(root, "snapshot.json");
          yield* Effect.scoped(
            Effect.gen(function* () {
              let markAddStarted = (): void => undefined;
              const addStarted = new Promise<void>((resolveStarted) => {
                markAddStarted = resolveStarted;
              });
              const harness = yield* makePrototypeHarness({
                activationAcknowledger: {
                  acknowledge: () =>
                    Effect.sync(markAddStarted).pipe(
                      Effect.andThen(Effect.never)
                    ),
                  complete: () => Effect.void,
                },
                handler: { invoke: () => Effect.void },
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  root
                ),
              });
              const interrupted = yield* Effect.forkChild(
                harness.runner.inject(
                  activationWithEventId("event:add-pending-recovery")
                )
              );
              yield* Effect.promise(() => addStarted);
              assert.strictEqual(
                (yield* harness.store.snapshot).acknowledgements[0]?.status,
                "add_pending"
              );
              yield* Fiber.interrupt(interrupted);
            })
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const lifecycle: string[] = [];
              const harness = yield* makePrototypeHarness({
                activationAcknowledger: {
                  acknowledge: () =>
                    Effect.sync(() => lifecycle.push("add-idempotently")),
                  complete: () => Effect.sync(() => lifecycle.push("remove")),
                },
                handler: { invoke: () => Effect.void },
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  root
                ),
              });
              yield* waitForAcknowledgementsToClear(harness.store.snapshot);
              assert.deepStrictEqual(lifecycle, ["add-idempotently", "remove"]);
            })
          );
        })
      ),
    10_000
  );
});
