import { assert, describe, it } from "@effect/vitest";
import { type FetchFunction, WebClient } from "@slack/web-api";
import { Cause, Deferred, Effect, Fiber, Ref } from "effect";
import {
  ApplicationConversationMessageChunk,
  type ApplicationShape,
} from "../src/application.ts";
import { makeSlackGateway } from "../src/prototype/emulated-slack.ts";
import { DeliveryError, HandlerFailure } from "../src/prototype/errors.ts";
import type { SlackGatewayShape } from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  makeSlackNativeStreamCapability,
  type SlackNativeStreamWebApiClient,
  splitSlackMarkdown,
} from "../src/slack/native-stream.ts";
import { slackWebApiRequestPolicy } from "../src/slack/web-api-request-policy.ts";

describe("native Slack stream gateway", () => {
  it("bounds production HTTP attempts and exposes rate limits without SDK retries", () => {
    assert.deepStrictEqual(slackWebApiRequestPolicy, {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 10_000,
    });
  });

  it.effect(
    "performs exactly one bounded Web API request for each native operation",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          readonly method:
            | "chat.appendStream"
            | "chat.startStream"
            | "chat.stopStream";
          readonly body: unknown;
        }> = [];
        const client: SlackNativeStreamWebApiClient = {
          appendStream: (body) => {
            requests.push({ method: "chat.appendStream", body });
            return Promise.resolve({ ok: true, ts: body.ts });
          },
          startStream: (body) => {
            requests.push({ method: "chat.startStream", body });
            return Promise.resolve({ ok: true, ts: "stream-1" });
          },
          stopStream: (body) => {
            requests.push({ method: "chat.stopStream", body });
            return Promise.resolve({ ok: true, ts: body.ts });
          },
        };
        const stream = makeSlackNativeStreamCapability({
          client,
          markdownTextLimit: 4,
          recipientTeamId: "TRECIPIENT",
        });

        const started = yield* stream.start({
          channelId: "CWORK",
          recipientUserId: "UASKER",
          rootTs: "1700000000.000001",
          text: "ab😀c",
        });
        yield* stream.append({
          channelId: "CWORK",
          streamTs: started.ts,
          text: "gh😀i",
        });
        yield* stream.stop({
          channelId: "CWORK",
          streamTs: started.ts,
        });

        assert.deepStrictEqual(requests, [
          {
            method: "chat.startStream",
            body: {
              channel: "CWORK",
              markdown_text: "ab😀c",
              recipient_team_id: "TRECIPIENT",
              recipient_user_id: "UASKER",
              thread_ts: "1700000000.000001",
            },
          },
          {
            method: "chat.appendStream",
            body: {
              channel: "CWORK",
              markdown_text: "gh😀i",
              ts: "stream-1",
            },
          },
          {
            method: "chat.stopStream",
            body: {
              channel: "CWORK",
              ts: "stream-1",
            },
          },
        ]);
      })
  );

  it("splits without breaking surrogate pairs or changing reconstructed text", () => {
    const text = "abc😀def😀ghi";

    const segments = splitSlackMarkdown(text, 4);

    assert.deepStrictEqual(segments, ["abc😀", "def😀", "ghi"]);
    assert.strictEqual(segments.join(""), text);
    for (const segment of segments) {
      assert.ok([...segment].length <= 4);
    }
  });

  it.live(
    "projects fallback Markdown through the actual WebClient gateway as markdown_text only",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          readonly method: string;
          readonly parameters: URLSearchParams;
        }> = [];
        const fetch: FetchFunction = (input, init) => {
          const method =
            new URL(String(input)).pathname.split("/").at(-1) ?? "";
          const body = typeof init?.body === "string" ? init.body : "";
          requests.push({ method, parameters: new URLSearchParams(body) });
          return Promise.resolve(
            Response.json({
              channel: "CWORK",
              ok: true,
              ts: method === "chat.postMessage" ? "message-1" : undefined,
            })
          );
        };
        const gateway = makeSlackGateway({
          botClient: new WebClient("test-token", {
            fetch,
            retryConfig: { retries: 0 },
            slackApiUrl: "https://slack.invalid/api/",
          }),
          pageSize: 2,
        });
        const markdown = `**heading**\n${"😀".repeat(5000)}`;

        const posted = yield* gateway.postThreadMessage({
          channelId: "CWORK",
          rootTs: "1.0",
          text: markdown,
        });
        const updateThreadMessage = gateway.updateThreadMessage;
        assert.ok(updateThreadMessage !== undefined);
        yield* updateThreadMessage({
          channelId: "CWORK",
          messageTs: posted.ts,
          text: markdown,
        });

        assert.strictEqual(requests.length, 2);
        assert.deepStrictEqual(
          requests.map(({ method, parameters }) => ({
            hasText: parameters.has("text"),
            markdownText: parameters.get("markdown_text"),
            method,
          })),
          [
            {
              hasText: false,
              markdownText: markdown,
              method: "chat.postMessage",
            },
            {
              hasText: false,
              markdownText: markdown,
              method: "chat.update",
            },
          ]
        );
      })
  );

  it.effect("rejects ok:false responses for every native stream method", () =>
    Effect.gen(function* () {
      const failedResponse = {
        error: "invalid_auth",
        ok: false,
        ts: "untrusted-ts",
      } as const;
      const client: SlackNativeStreamWebApiClient = {
        appendStream: () => Promise.resolve(failedResponse),
        startStream: () => Promise.resolve(failedResponse),
        stopStream: () => Promise.resolve(failedResponse),
      };
      const stream = makeSlackNativeStreamCapability({
        client,
        recipientTeamId: "TRECIPIENT",
      });

      const start = yield* Effect.result(
        stream.start({
          channelId: "CWORK",
          recipientUserId: "UASKER",
          rootTs: "1700000000.000001",
          text: "start",
        })
      );
      const append = yield* Effect.result(
        stream.append({
          channelId: "CWORK",
          streamTs: "stream-1",
          text: "append",
        })
      );
      const stop = yield* Effect.result(
        stream.stop({ channelId: "CWORK", streamTs: "stream-1" })
      );

      assert.deepStrictEqual(
        [start._tag, append._tag, stop._tag],
        ["Failure", "Failure", "Failure"]
      );
    })
  );

  it.effect("rejects ok:true responses that omit the required stream ts", () =>
    Effect.gen(function* () {
      const client: SlackNativeStreamWebApiClient = {
        appendStream: () => Promise.resolve({ ok: true }),
        startStream: () => Promise.resolve({ ok: true }),
        stopStream: () => Promise.resolve({ ok: true }),
      };
      const stream = makeSlackNativeStreamCapability({
        client,
        recipientTeamId: "TRECIPIENT",
      });

      const start = yield* Effect.result(
        stream.start({
          channelId: "CWORK",
          recipientUserId: "UASKER",
          rootTs: "1700000000.000001",
          text: "start",
        })
      );
      const append = yield* Effect.result(
        stream.append({
          channelId: "CWORK",
          streamTs: "stream-1",
          text: "append",
        })
      );
      const stop = yield* Effect.result(
        stream.stop({ channelId: "CWORK", streamTs: "stream-1" })
      );

      assert.deepStrictEqual(
        [start._tag, append._tag, stop._tag],
        ["Failure", "Failure", "Failure"]
      );
    })
  );

  it.effect(
    "rejects an oversized operation before making any hidden requests",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client: SlackNativeStreamWebApiClient = {
          appendStream: (body) => {
            calls.push(`append:${body.markdown_text}`);
            return Promise.resolve({ error: "invalid_arguments", ok: false });
          },
          startStream: (body) => {
            calls.push(`start:${body.markdown_text}`);
            return Promise.resolve({ ok: true, ts: "stream-1" });
          },
          stopStream: (body) => {
            calls.push(`stop:${body.ts}`);
            return Promise.resolve({ ok: true, ts: body.ts });
          },
        };
        const stream = makeSlackNativeStreamCapability({
          client,
          markdownTextLimit: 3,
          recipientTeamId: "TRECIPIENT",
        });

        const result = yield* Effect.result(
          stream.start({
            channelId: "CWORK",
            recipientUserId: "UASKER",
            rootTs: "1700000000.000001",
            text: "abcdef",
          })
        );

        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(calls, []);
      })
  );

  it.effect(
    "creates one ordered native stream per ACP message and appends only deltas before finalizing every stream",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Array<
            | {
                readonly method: "append";
                readonly streamTs: string;
                readonly text: string;
              }
            | {
                readonly method: "start";
                readonly recipientUserId: string;
                readonly streamTs: string;
                readonly text: string;
              }
            | { readonly method: "stop"; readonly streamTs: string }
          > = [];
          let nextStream = 0;
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: ({ streamTs, text }) =>
                Effect.sync(() => {
                  calls.push({ method: "append", streamTs, text });
                }),
              start: ({ recipientUserId, text }) =>
                Effect.sync(() => {
                  nextStream += 1;
                  const streamTs = `stream-${nextStream}`;
                  calls.push({
                    method: "start",
                    recipientUserId,
                    streamTs,
                    text,
                  });
                  return { ts: streamTs };
                }),
              stop: ({ streamTs }) =>
                Effect.sync(() => {
                  calls.push({ method: "stop", streamTs });
                }),
            },
            postThreadMessage: () =>
              Effect.die(
                new Error("native ACP publishing must not use postMessage")
              ),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              Effect.gen(function* () {
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "empty",
                    text: "",
                  })
                );
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "message-one",
                    text: "first ",
                  })
                );
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "message-one",
                    text: "delta",
                  })
                );
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "message-two",
                    text: "second",
                  })
                );
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "message-one",
                    text: " tail",
                  })
                );
              }),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:native-stream",
              messageTs: "1700000000.000001",
              text: `<@${LABORER_SLACK_ID}> stream`,
            })
          );

          assert.deepStrictEqual(calls, [
            {
              method: "start",
              recipientUserId: "UASKER",
              streamTs: "stream-1",
              text: "first ",
            },
            { method: "append", streamTs: "stream-1", text: "delta" },
            {
              method: "start",
              recipientUserId: "UASKER",
              streamTs: "stream-2",
              text: "second",
            },
            { method: "append", streamTs: "stream-1", text: " tail" },
            { method: "stop", streamTs: "stream-1" },
            { method: "stop", streamTs: "stream-2" },
          ]);
        })
      )
  );

  it.live(
    "serializes overlapping ACP publication through the official-client capability",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{
            readonly method: "append" | "start" | "stop";
            readonly text?: string | undefined;
            readonly ts?: string;
          }> = [];
          let nextStream = 0;
          const client: SlackNativeStreamWebApiClient = {
            appendStream: (body) => {
              requests.push({
                method: "append",
                text: body.markdown_text,
                ts: body.ts,
              });
              return Promise.resolve({ ok: true, ts: body.ts });
            },
            startStream: (body) => {
              nextStream += 1;
              const streamTs = `stream-${nextStream}`;
              requests.push({
                method: "start",
                text: body.markdown_text,
                ts: streamTs,
              });
              return new Promise((resolveStart) => {
                setTimeout(() => {
                  resolveStart({ ok: true, ts: streamTs });
                }, 10);
              });
            },
            stopStream: (body) => {
              requests.push({ method: "stop", ts: body.ts });
              return Promise.resolve({ ok: true, ts: body.ts });
            },
          };
          const gateway: SlackGatewayShape = {
            nativeStreaming: makeSlackNativeStreamCapability({
              client,
              recipientTeamId: "TWORK",
            }),
            postThreadMessage: () =>
              Effect.die(new Error("native capability must remain selected")),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              Effect.all(
                [
                  publish(
                    ApplicationConversationMessageChunk.make({
                      messageId: "overlap-one",
                      text: "first",
                    })
                  ),
                  publish(
                    ApplicationConversationMessageChunk.make({
                      messageId: "overlap-one",
                      text: "-delta",
                    })
                  ),
                  publish(
                    ApplicationConversationMessageChunk.make({
                      messageId: "overlap-two",
                      text: "second",
                    })
                  ),
                ],
                { concurrency: "unbounded", discard: true }
              ),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:overlapping-native-stream",
              messageTs: "1700000000.000002",
              text: `<@${LABORER_SLACK_ID}> overlap`,
            })
          );

          assert.deepStrictEqual(requests, [
            { method: "start", text: "first", ts: "stream-1" },
            { method: "append", text: "-delta", ts: "stream-1" },
            { method: "start", text: "second", ts: "stream-2" },
            { method: "stop", ts: "stream-1" },
            { method: "stop", ts: "stream-2" },
          ]);
        })
      )
  );

  it.effect(
    "finalizes partial native content before publishing a separate failure notice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: ({ text }) =>
                Effect.sync(() => {
                  calls.push(`start:${text}`);
                  return { ts: "partial-stream" };
                }),
              stop: ({ streamTs }) =>
                Effect.sync(() => {
                  calls.push(`stop:${streamTs}`);
                }),
            },
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`notice:${text}`);
                return { ts: "notice" };
              }),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              Effect.gen(function* () {
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "partial",
                    text: "Partial answer stays.",
                  })
                );
                return yield* HandlerFailure.make({
                  category: "protocol",
                  noticeStyle: "generic",
                  safeDetail: "original ACP failure",
                });
              }),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:partial-native-stream",
              messageTs: "1700000001.000001",
              text: `<@${LABORER_SLACK_ID}> stream then fail`,
            })
          );

          assert.deepStrictEqual(calls, [
            "start:Partial answer stays.",
            "stop:partial-stream",
            "notice:This conversation turn could not be completed. Please try again.",
          ]);
        })
      )
  );

  it.effect(
    "attempts every stop and preserves the original ACP failure when a stop also fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          let nextStream = 0;
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: ({ text }) =>
                Effect.sync(() => {
                  nextStream += 1;
                  calls.push(`start:${text}`);
                  return { ts: `stream-${nextStream}` };
                }),
              stop: ({ streamTs }) => {
                calls.push(`stop:${streamTs}`);
                return streamTs === "stream-1"
                  ? DeliveryError.make({
                      category: "stop-failed",
                      disposition: "item-permanent",
                      retryAfterMillis: 0,
                    })
                  : Effect.void;
              },
            },
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`notice:${text}`);
                return { ts: "notice" };
              }),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              Effect.gen(function* () {
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "first-partial",
                    text: "First partial",
                  })
                );
                yield* publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: "second-partial",
                    text: "Second partial",
                  })
                );
                return yield* HandlerFailure.make({
                  category: "exit",
                  safeDetail: "original ACP process failure",
                });
              }),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:native-stop-failure",
              messageTs: "1700000002.000001",
              text: `<@${LABORER_SLACK_ID}> fail twice`,
            })
          );

          assert.deepStrictEqual(calls, [
            "start:First partial",
            "start:Second partial",
            "stop:stream-1",
            "stop:stream-2",
            "notice:Turn turn:CWORK:1700000002.000001 failed (exit: original ACP process failure). See Runner logs.",
          ]);
          const state = yield* harness.store.snapshot;
          assert.deepStrictEqual(
            { ...state.threads[0]?.turns[0]?.outcome },
            {
              category: "exit",
              kind: "failure",
              safeDetail: "original ACP process failure",
            }
          );
        })
      )
  );

  it.effect(
    "turns a stop failure after successful ACP work into a sanitized delivery failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const notices: string[] = [];
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () => Effect.succeed({ ts: "stream-1" }),
              stop: () =>
                DeliveryError.make({
                  category: "stop-failed",
                  disposition: "item-permanent",
                  retryAfterMillis: 0,
                }),
            },
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                notices.push(text);
                return { ts: "notice" };
              }),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              publish(
                ApplicationConversationMessageChunk.make({
                  messageId: "answer",
                  text: "Answer",
                })
              ),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:successful-native-stop-failure",
              messageTs: "1700000003.000001",
              text: `<@${LABORER_SLACK_ID}> answer`,
            })
          );

          assert.deepStrictEqual(notices, [
            "This conversation turn could not be completed. Please try again.",
          ]);
          const state = yield* harness.store.snapshot;
          assert.deepStrictEqual(
            { ...state.threads[0]?.turns[0]?.outcome },
            {
              category: "protocol",
              kind: "failure",
              safeDetail: "Conversation message delivery failed",
            }
          );
        })
      )
  );

  it.effect(
    "fails before starting a native stream when the turn has no human participant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const notices = yield* Ref.make<readonly string[]>([]);
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () =>
                Ref.update(starts, (count) => count + 1).pipe(
                  Effect.as({ ts: "must-not-start" })
                ),
              stop: () => Effect.void,
            },
            postThreadMessage: ({ text }) =>
              Ref.update(notices, (current) => [...current, text]).pipe(
                Effect.as({ ts: "notice" })
              ),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              publish(
                ApplicationConversationMessageChunk.make({
                  messageId: "bot-request-answer",
                  text: "Answer for bot-only turn",
                })
              ),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorKind: "externalBot",
              authorSlackId: "BEXTERNAL",
              channelId: "CWORK",
              eventId: "event:bot-only-native-stream",
              messageTs: "1700000003.000002",
              text: `<@${LABORER_SLACK_ID}> bot request`,
            })
          );

          assert.strictEqual(yield* Ref.get(starts), 0);
          assert.deepStrictEqual(yield* Ref.get(notices), [
            "This conversation turn could not be completed. Please try again.",
          ]);
        })
      )
  );

  it.effect(
    "selects the latest human when a batched turn ends with an external bot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const contextRequested = yield* Deferred.make<void>();
          const releaseContext = yield* Deferred.make<void>();
          const selectedRecipient = yield* Deferred.make<string>();
          const stopped = yield* Deferred.make<void>();
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: ({ recipientUserId }) =>
                Deferred.succeed(selectedRecipient, recipientUserId).pipe(
                  Effect.as({ ts: "batched-stream" })
                ),
              stop: () => Deferred.succeed(stopped, undefined),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () =>
              Deferred.succeed(contextRequested, undefined).pipe(
                Effect.andThen(Deferred.await(releaseContext)),
                Effect.as([])
              ),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              publish(
                ApplicationConversationMessageChunk.make({
                  messageId: "batched-answer",
                  text: "Batched answer",
                })
              ),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          const rootTs = "1700000003.000003";
          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "UFIRST",
              channelId: "CWORK",
              eventId: "event:batched-activation",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> batch`,
            })
          );
          yield* Deferred.await(contextRequested);
          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "ULATEST",
              channelId: "CWORK",
              eventId: "event:batched-human",
              messageTs: "1700000003.000004",
              text: "human follow-up",
              threadTs: rootTs,
            })
          );
          yield* harness.runner.accept(
            normalizedEvent({
              authorKind: "externalBot",
              authorSlackId: "BEXTERNAL",
              channelId: "CWORK",
              eventId: "event:batched-bot",
              messageTs: "1700000003.000005",
              text: "bot follow-up",
              threadTs: rootTs,
            })
          );
          yield* Deferred.succeed(releaseContext, undefined);

          assert.strictEqual(
            yield* Deferred.await(selectedRecipient),
            "ULATEST"
          );
          yield* Deferred.await(stopped);
        })
      )
  );

  it.effect(
    "finalizes a started native stream when the Runner turn is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const stopCalls = yield* Ref.make(0);
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.as({ ts: "interrupted-stream" })
                ),
              stop: () => Ref.update(stopCalls, (count) => count + 1),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              publish(
                ApplicationConversationMessageChunk.make({
                  messageId: "interrupted-answer",
                  text: "Partial before interruption",
                })
              ).pipe(Effect.andThen(Effect.never)),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          const turnFiber = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UASKER",
                channelId: "CWORK",
                eventId: "event:interrupted-native-stream",
                messageTs: "1700000004.000001",
                text: `<@${LABORER_SLACK_ID}> wait`,
              })
            )
          );
          yield* Deferred.await(started);

          yield* Fiber.interrupt(turnFiber);
          const exit = yield* Fiber.await(turnFiber);

          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            assert.ok(Cause.hasInterrupts(exit.cause));
          }
          assert.strictEqual(yield* Ref.get(stopCalls), 1);
        })
      )
  );

  it.effect(
    "finalizes partial native text before one sanitized application-defect notice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const defect = new Error("application defect fixture");
          const stopCalls = yield* Ref.make(0);
          const notices = yield* Ref.make<readonly string[]>([]);
          const gateway: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () => Effect.succeed({ ts: "defective-stream" }),
              stop: () =>
                Ref.update(stopCalls, (count) => count + 1).pipe(
                  Effect.andThen(
                    DeliveryError.make({
                      category: "stop-failed-after-defect",
                      disposition: "item-permanent",
                      retryAfterMillis: 0,
                    })
                  )
                ),
            },
            postThreadMessage: ({ text }) =>
              Ref.update(notices, (current) => [...current, text]).pipe(
                Effect.as({ ts: "notice" })
              ),
            readActivationContext: () => Effect.succeed([]),
          };
          const application: ApplicationShape = {
            handle: (_event, publish) =>
              publish(
                ApplicationConversationMessageChunk.make({
                  messageId: "defective-answer",
                  text: "Partial before defect",
                })
              ).pipe(Effect.andThen(Effect.die(defect))),
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });

          const exit = yield* Effect.exit(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UASKER",
                channelId: "CWORK",
                eventId: "event:defective-native-stream",
                messageTs: "1700000005.000001",
                text: `<@${LABORER_SLACK_ID}> defect`,
              })
            )
          );

          assert.strictEqual(exit._tag, "Success");
          assert.strictEqual(yield* Ref.get(stopCalls), 1);
          assert.deepStrictEqual(yield* Ref.get(notices), [
            "This conversation turn could not be completed. Please try again.",
          ]);
        })
      )
  );
});
