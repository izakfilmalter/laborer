import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import {
  type PrototypeState,
  PublicReplyProtocolRecord,
  ReplyId,
} from "../src/prototype/domain.ts";
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

describe("durable completion reaction lifecycle", () => {
  it.live(
    "retries a persisted completion reaction after restart interrupts an ambiguous call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-completion-reaction-recovery-"
          );
          const snapshotPath = join(root, "snapshot.json");
          const reactionCalls: string[] = [];

          yield* Effect.scoped(
            Effect.gen(function* () {
              let markReactionStarted = (): void => undefined;
              const reactionStarted = new Promise<void>((resolveStarted) => {
                markReactionStarted = resolveStarted;
              });
              const firstHarness = yield* makePrototypeHarness({
                completionReactor: {
                  react: ({ channelId, rootTs }) =>
                    Effect.sync(() => {
                      reactionCalls.push(`first:${channelId}:${rootTs}`);
                      markReactionStarted();
                    }).pipe(Effect.andThen(Effect.never)),
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

              yield* firstHarness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CRECOVERCOMPLETION",
                  eventId: "event:recover-completion",
                  messageTs: "5.0",
                  text: `<@${LABORER_SLACK_ID}> complete before crashing`,
                })
              );
              yield* Effect.promise(() => reactionStarted);

              const persisted = yield* firstHarness.store.snapshot;
              assert.strictEqual(
                persisted.threads[0]?.turns[0]?.status,
                "completed"
              );
              assert.strictEqual(
                persisted.threads[0]?.turns[0]?.outcome?.kind,
                "success"
              );
              assert.strictEqual(
                persisted.completionReactions[0]?.status,
                "add_pending"
              );
              assert.strictEqual(persisted.completionReactions[0]?.attempts, 0);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const recoveredHarness = yield* makePrototypeHarness({
                completionReactor: {
                  react: ({ channelId, rootTs }) =>
                    Effect.sync(() => {
                      reactionCalls.push(`retry:${channelId}:${rootTs}`);
                    }),
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

              const deadline = Date.now() + 5000;
              let recovered = yield* recoveredHarness.store.snapshot;
              while (
                recovered.completionReactions.length > 0 &&
                Date.now() < deadline
              ) {
                yield* Effect.sleep("10 millis");
                recovered = yield* recoveredHarness.store.snapshot;
              }

              assert.deepStrictEqual(reactionCalls, [
                "first:CRECOVERCOMPLETION:5.0",
                "retry:CRECOVERCOMPLETION:5.0",
              ]);
              assert.deepStrictEqual(recovered.completionReactions, []);
              assert.strictEqual(
                recovered.threads[0]?.turns[0]?.status,
                "completed"
              );
              assert.deepStrictEqual(recovered.threads[0]?.outbox, []);
            })
          );
        })
      ),
    10_000
  );

  it.live(
    "keeps permanent completion reaction errors observable without blocking later turns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let handlerAttempts = 0;
          let reactionAttempts = 0;
          const harness = yield* makePrototypeHarness({
            completionReactor: {
              react: () => {
                reactionAttempts += 1;
                return reactionAttempts === 1
                  ? DeliveryError.make({
                      category: "missing_scope",
                      disposition: "destination-permanent",
                      retryAfterMillis: 0,
                    })
                  : Effect.void;
              },
            },
            handler: {
              invoke: () =>
                Effect.sync(() => {
                  handlerAttempts += 1;
                }),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CPERMANENTCOMPLETION",
              eventId: "event:permanent-completion",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> complete despite reaction failure`,
            })
          );

          const failureDeadline = Date.now() + 5000;
          let state = yield* harness.store.snapshot;
          while (
            state.completionReactions[0]?.status !== "permanent_failure" &&
            Date.now() < failureDeadline
          ) {
            yield* Effect.sleep("10 millis");
            state = yield* harness.store.snapshot;
          }

          const firstTurn = state.threads[0]?.turns[0];
          assert.strictEqual(firstTurn?.outcome?.kind, "success");
          assert.strictEqual(firstTurn?.status, "completed");
          assert.strictEqual(
            state.completionReactions[0]?.status,
            "permanent_failure"
          );
          assert.strictEqual(
            state.completionReactions[0]?.lastErrorCategory,
            "missing_scope"
          );

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CPERMANENTCOMPLETION",
              eventId: "event:after-permanent-completion",
              messageTs: "2.0",
              text: "run a later turn",
              threadTs: "1.0",
            })
          );

          const continuationDeadline = Date.now() + 5000;
          state = yield* harness.store.snapshot;
          while (
            (reactionAttempts < 2 || state.completionReactions.length !== 1) &&
            Date.now() < continuationDeadline
          ) {
            yield* Effect.sleep("10 millis");
            state = yield* harness.store.snapshot;
          }

          assert.strictEqual(handlerAttempts, 2);
          assert.strictEqual(reactionAttempts, 2);
          assert.strictEqual(state.completionReactions.length, 1);
          assert.strictEqual(
            state.completionReactions[0]?.status,
            "permanent_failure"
          );
          assert.strictEqual(
            state.completionReactions[0]?.lastErrorCategory,
            "missing_scope"
          );
          assert.strictEqual(state.completionReactions[0]?.attempts, 1);
          assert.strictEqual(state.completionReactions[0]?.retryAtMillis, null);
          assert.deepStrictEqual(
            state.threads[0]?.turns.map((turn) => ({
              outcome: turn.outcome?.kind,
              status: turn.status,
            })),
            [
              { outcome: "success", status: "completed" },
              { outcome: "success", status: "completed" },
            ]
          );
          assert.deepStrictEqual(state.threads[0]?.outbox, []);
          assert.deepStrictEqual(state.threads[0]?.unassigned, []);
        })
      ),
    10_000
  );

  it.live(
    "persists and retries a transient zero-reply completion reaction failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let reactionAttempts = 0;
          const retryAfterMillis = 1200;
          const firstAttemptAt = Date.now();
          const harness = yield* makePrototypeHarness({
            completionReactor: {
              react: () => {
                reactionAttempts += 1;
                return reactionAttempts === 1
                  ? DeliveryError.make({
                      category: "ratelimited",
                      disposition: "transient",
                      retryAfterMillis,
                    })
                  : Effect.void;
              },
            },
            handler: { invoke: () => Effect.void },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CRETRYCOMPLETION",
              eventId: "event:retry-completion",
              messageTs: "4.0",
              text: `<@${LABORER_SLACK_ID}> complete silently after retry`,
            })
          );

          const persistenceDeadline = Date.now() + 5000;
          let persistedReaction = (yield* harness.store.snapshot)
            .completionReactions[0];
          while (
            persistedReaction?.attempts !== 1 &&
            Date.now() < persistenceDeadline
          ) {
            yield* Effect.sleep("10 millis");
            persistedReaction = (yield* harness.store.snapshot)
              .completionReactions[0];
          }

          assert.strictEqual(reactionAttempts, 1);
          assert.strictEqual(persistedReaction?.status, "add_pending");
          assert.strictEqual(persistedReaction?.attempts, 1);
          assert.strictEqual(
            persistedReaction?.lastErrorCategory,
            "ratelimited"
          );
          assert.ok(
            (persistedReaction?.retryAtMillis ?? 0) >=
              firstAttemptAt + retryAfterMillis
          );

          const completionDeadline = Date.now() + 5000;
          let finalState = yield* harness.store.snapshot;
          while (
            finalState.completionReactions.length > 0 &&
            Date.now() < completionDeadline
          ) {
            yield* Effect.sleep("10 millis");
            finalState = yield* harness.store.snapshot;
          }

          assert.strictEqual(reactionAttempts, 2);
          assert.ok(Date.now() - firstAttemptAt >= retryAfterMillis - 100);
          assert.deepStrictEqual(finalState.completionReactions, []);
          assert.strictEqual(
            finalState.threads[0]?.turns[0]?.status,
            "completed"
          );
          assert.strictEqual(
            finalState.threads[0]?.turns[0]?.outcome?.kind,
            "success"
          );
          assert.deepStrictEqual(finalState.threads[0]?.outbox, []);
        })
      ),
    10_000
  );

  it.live(
    "reacts to the canonical root only after every deliberate reply is delivered, including zero replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: string[] = [];
          const reactions = {
            add: (request: {
              readonly channel: string;
              readonly name: string;
              readonly timestamp: string;
            }): Promise<void> => {
              lifecycle.push(
                `reaction:${request.channel}:${request.timestamp}:${request.name}`
              );
              return Promise.resolve();
            },
          };
          const harness = yield* makePrototypeHarness({
            completionReactor: {
              react: ({ channelId, rootTs }) =>
                Effect.promise(() =>
                  reactions.add({
                    channel: channelId,
                    name: "white_check_mark",
                    timestamp: rootTs,
                  })
                ),
            },
            handler: {
              invoke: (turn, acceptReply) =>
                turn.messages[0]?.text.includes("with replies")
                  ? acceptReply(
                      PublicReplyProtocolRecord.make({
                        protocolVersion: 1,
                        replyId: ReplyId.make("completion-first"),
                        text: "first deliberate reply",
                        type: "public_reply",
                      })
                    ).pipe(
                      Effect.andThen(
                        acceptReply(
                          PublicReplyProtocolRecord.make({
                            protocolVersion: 1,
                            replyId: ReplyId.make("completion-second"),
                            text: "second deliberate reply",
                            type: "public_reply",
                          })
                        )
                      )
                    )
                  : Effect.void,
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  lifecycle.push(`reply:${text}`);
                  return { ts: `delivered:${lifecycle.length}` };
                }),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCOMPLETION",
              eventId: "event:completion-with-replies",
              messageTs: "2.0",
              text: `<@${LABORER_SLACK_ID}> complete with replies`,
              threadTs: "1.0",
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CZERO",
              eventId: "event:completion-zero-replies",
              messageTs: "3.0",
              text: `<@${LABORER_SLACK_ID}> complete silently`,
            })
          );

          const deadline = Date.now() + 5000;
          while (
            lifecycle.filter((event) => event.startsWith("reaction:")).length <
              2 &&
            Date.now() < deadline
          ) {
            yield* Effect.sleep("10 millis");
          }

          assert.deepStrictEqual(lifecycle, [
            "reply:first deliberate reply",
            "reply:second deliberate reply",
            "reaction:CCOMPLETION:1.0:white_check_mark",
            "reaction:CZERO:3.0:white_check_mark",
          ]);
        })
      ),
    10_000
  );
});
