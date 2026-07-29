import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import {
  EventId,
  MessageId,
  NormalizedImageInput,
  NormalizedInboundEvent,
  NormalizedMessage,
} from "../src/prototype/domain.ts";
import type { SlackGatewayShape } from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { SlackRuntimeIdentity } from "../src/slack/config.ts";
import { normalizeConversationAdoptionHistoryMessage } from "../src/slack/conversation-adoption-history.ts";
import { SlackBoundaryError } from "../src/slack/errors.ts";
import { makeSlackInboundImageResolver } from "../src/slack/inbound-images.ts";
import { normalizeSlackEvent } from "../src/slack/normalize.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const scriptedPeerPath = resolve(
  process.cwd(),
  "tests/fixtures/scripted-acp-peer.ts"
);

const identity = SlackRuntimeIdentity.make({
  botId: "BLABORER",
  botUserId: "ULABORER",
  teamId: "TLABORER",
});

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

describe("inbound Slack images", () => {
  it.effect(
    "refreshes, validates, and atomically stages Slack-hosted bytes",
    () =>
      Effect.gen(function* () {
        const storageRoot = yield* makeTempDirectoryScoped(
          "laborer-inbound-images-"
        );
        const authorizationHeaders: string[] = [];
        const resolver = makeSlackInboundImageResolver({
          client: {
            files: {
              info: () =>
                Promise.resolve({
                  file: {
                    id: "FIMAGE",
                    mimetype: "image/png",
                    size: png.byteLength,
                    url_private_download:
                      "https://files.slack.com/files-pri/TLABORER-FIMAGE/image.png",
                  },
                }),
            },
            token: "test-bot-token",
          } as never,
          fetch: ((_input, init) => {
            authorizationHeaders.push(
              new Headers(init?.headers).get("authorization") ?? ""
            );
            return Promise.resolve(
              new Response(png, {
                headers: {
                  "content-length": String(png.byteLength),
                  "content-type": "image/png",
                },
              })
            );
          }) as typeof fetch,
          storageRoot,
        });

        const [image] = yield* resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          messageTs: "1.0",
        });

        if (image === undefined || "failureReason" in image) {
          return assert.fail("expected a staged image");
        }
        const stagedBytes = yield* Effect.promise(() =>
          readFile(resolve(storageRoot, image.contentPath))
        );
        assert.deepStrictEqual(new Uint8Array(stagedBytes), png);
        assert.strictEqual(image.byteLength, png.byteLength);
        assert.match(image.contentDigest, SHA256_HEX_PATTERN);
        assert.deepStrictEqual(authorizationHeaders, ["Bearer test-bot-token"]);
      })
  );

  it.effect(
    "normalizes an image-only Slack message through the private resolver",
    () =>
      Effect.gen(function* () {
        const image = NormalizedImageInput.make({
          byteLength: png.byteLength,
          contentDigest: "a".repeat(64),
          contentPath: `inbound-images/${"a".repeat(64)}.png`,
          id: "image-one",
          mimeType: "image/png",
          slackFileId: "FIMAGE",
        });
        const normalized = yield* normalizeSlackEvent(
          {
            event: {
              channel: "CWORK",
              channel_type: "channel",
              files: [
                {
                  id: "FIMAGE",
                  mimetype: "image/png",
                  url_private: "must-not-survive",
                },
              ],
              subtype: "file_share",
              ts: "1.0",
              type: "message",
              user: "UHUMAN",
            },
            event_id: "EvImage",
            team_id: identity.teamId,
            type: "event_callback",
          },
          identity,
          {
            resolveImages: ({ candidates }) => {
              assert.deepStrictEqual(candidates, [{ id: "FIMAGE" }]);
              return Effect.succeed([image]);
            },
          }
        );

        assert.strictEqual(normalized?.text, null);
        assert.deepStrictEqual(normalized?.images, [image]);
        assert.ok(!JSON.stringify(normalized).includes("must-not-survive"));

        const unavailable = yield* normalizeSlackEvent(
          {
            event: {
              channel: "CWORK",
              channel_type: "channel",
              files: [{ id: "FIMAGE", mimetype: "image/png" }],
              subtype: "file_share",
              thread_ts: "1.0",
              ts: "2.0",
              type: "message",
              user: "UHUMAN",
            },
            event_id: "EvUnavailableImage",
            team_id: identity.teamId,
            type: "event_callback",
          },
          identity,
          {
            resolveImages: () =>
              SlackBoundaryError.make({
                boundary: "slack-files-api",
                reason: "unsupported-image-type",
              }),
          }
        );
        assert.strictEqual(
          unavailable?.images?.[0] !== undefined &&
            "failureReason" in unavailable.images[0]
            ? unavailable.images[0].failureReason
            : null,
          "unsupported-image-type"
        );
      })
  );

  it.effect(
    "preserves a direct Activation caption and queues an image-only follow-up",
    () =>
      Effect.gen(function* () {
        const activationImage = NormalizedImageInput.make({
          byteLength: png.byteLength,
          contentDigest: "c".repeat(64),
          contentPath: `inbound-images/${"c".repeat(64)}.png`,
          id: "activation-image",
          mimeType: "image/png",
          slackFileId: "FACTIVATION",
        });
        const followupImage = NormalizedImageInput.make({
          ...activationImage,
          contentDigest: "d".repeat(64),
          contentPath: `inbound-images/${"d".repeat(64)}.png`,
          id: "followup-image",
          slackFileId: "FFOLLOWUP",
        });
        const resolveImages = ({
          candidates,
        }: {
          readonly candidates: readonly { readonly id: string }[];
        }) =>
          Effect.succeed(
            candidates.map(({ id }) =>
              id === "FACTIVATION" ? activationImage : followupImage
            )
          );
        const caption = "  <@ULABORER> inspect this\n*carefully*  ";
        const activation = yield* normalizeSlackEvent(
          {
            event: {
              channel: "CWORK",
              channel_type: "channel",
              files: [{ id: "FACTIVATION", mimetype: "image/png" }],
              text: caption,
              ts: "1.0",
              type: "app_mention",
              user: "UHUMAN",
            },
            event_id: "EvDirectImageActivation",
            team_id: identity.teamId,
            type: "event_callback",
          },
          identity,
          { resolveImages }
        );
        const followup = yield* normalizeSlackEvent(
          {
            event: {
              channel: "CWORK",
              channel_type: "channel",
              files: [{ id: "FFOLLOWUP", mimetype: "image/png" }],
              subtype: "file_share",
              thread_ts: "1.0",
              ts: "2.0",
              type: "message",
              user: "UHUMAN",
            },
            event_id: "EvQueuedImageFollowup",
            team_id: identity.teamId,
            type: "event_callback",
          },
          identity,
          { resolveImages }
        );
        assert.ok(activation !== null && followup !== null);
        if (activation === null || followup === null) {
          return;
        }

        const firstTurnStarted = yield* Deferred.make<void>();
        const releaseFirstTurn = yield* Deferred.make<void>();
        const turns: import("../src/prototype/domain.ts").ClaimedTurn[] = [];
        const harness = yield* makePrototypeHarness({
          handler: {
            invoke: (turn) =>
              Effect.gen(function* () {
                turns.push(turn);
                if (turns.length === 1) {
                  yield* Deferred.succeed(firstTurnStarted, undefined);
                  yield* Deferred.await(releaseFirstTurn);
                }
              }),
          },
          laborerSlackId: identity.botUserId,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        const activationFiber = yield* Effect.forkChild(
          harness.runner.inject(activation)
        );
        yield* Deferred.await(firstTurnStarted);

        const accepted = yield* harness.runner.accept(followup);
        const duplicate = yield* harness.runner.accept(followup);
        assert.strictEqual(accepted.decision._tag, "Accepted");
        assert.strictEqual(accepted.scheduling, "Scheduled");
        assert.strictEqual(duplicate.decision._tag, "Ignored");
        assert.strictEqual(turns.length, 1);

        yield* Deferred.succeed(releaseFirstTurn, undefined);
        yield* Fiber.join(activationFiber);

        assert.strictEqual(turns.length, 2);
        assert.strictEqual(turns[0]?.messages[0]?.text, caption);
        assert.deepStrictEqual(turns[0]?.messages[0]?.images, [
          activationImage,
        ]);
        assert.strictEqual(turns[1]?.messages[0]?.text, "");
        assert.deepStrictEqual(turns[1]?.messages[0]?.images, [followupImage]);
      })
  );

  it.effect("ignores attached non-image files without resolving them", () =>
    Effect.gen(function* () {
      let resolutionCount = 0;
      const normalized = yield* normalizeSlackEvent(
        {
          event: {
            channel: "CWORK",
            channel_type: "channel",
            files: [{ id: "FPDF", mimetype: "application/pdf" }],
            text: "<@ULABORER> use the notes",
            ts: "1.0",
            type: "app_mention",
            user: "UHUMAN",
          },
          event_id: "EvNonImage",
          team_id: identity.teamId,
          type: "event_callback",
        },
        identity,
        {
          resolveImages: () => {
            resolutionCount += 1;
            return Effect.succeed([]);
          },
        }
      );

      assert.strictEqual(resolutionCount, 0);
      assert.deepStrictEqual(normalized?.images, []);
    })
  );

  it.effect(
    "keeps unrelated textless Slack rich content classified as blank",
    () =>
      Effect.gen(function* () {
        let resolutionCount = 0;
        const normalized = yield* normalizeSlackEvent(
          {
            event: {
              blocks: [
                {
                  elements: [{ type: "rich_text_section" }],
                  type: "rich_text",
                },
              ],
              channel: "CWORK",
              channel_type: "channel",
              ts: "1.0",
              type: "message",
              user: "UHUMAN",
            },
            event_id: "EvTextlessRichContent",
            team_id: identity.teamId,
            type: "event_callback",
          },
          identity,
          {
            resolveImages: () => {
              resolutionCount += 1;
              return Effect.succeed([]);
            },
          }
        );
        assert.ok(normalized !== null);
        if (normalized === null) {
          return;
        }
        const harness = yield* makePrototypeHarness({
          handler: { invoke: () => Effect.void },
          laborerSlackId: identity.botUserId,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });

        const decision = yield* harness.runner.inject(normalized);

        assert.strictEqual(decision._tag, "Ignored");
        if (decision._tag === "Ignored") {
          assert.strictEqual(decision.reason, "blank");
        }
        assert.strictEqual(resolutionCount, 0);
      })
  );

  it.effect("fails closed on count, type, and download-origin violations", () =>
    Effect.gen(function* () {
      const storageRoot = yield* makeTempDirectoryScoped(
        "laborer-inbound-image-bounds-"
      );
      const metadata = {
        current: {
          id: "FIMAGE",
          mimetype: "image/png",
          size: png.byteLength,
          url_private_download: "https://evil.example/image.png",
        },
      };
      const resolver = makeSlackInboundImageResolver({
        client: {
          files: {
            info: () => Promise.resolve({ file: metadata.current }),
          },
          token: "test-bot-token",
        } as never,
        fetch,
        storageRoot,
      });
      const excessive = yield* Effect.result(
        resolver({
          candidates: Array.from({ length: 5 }, (_, index) => ({
            id: `F${index}`,
          })),
          channelId: "CWORK",
          messageTs: "1.0",
        })
      );
      assert.strictEqual(
        excessive._tag === "Failure" ? excessive.failure.reason : null,
        "image-count-limit"
      );

      const untrusted = yield* Effect.result(
        resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          messageTs: "1.0",
        })
      );
      assert.strictEqual(
        untrusted._tag === "Failure" ? untrusted.failure.reason : null,
        "untrusted-download-origin"
      );

      metadata.current = { ...metadata.current, mimetype: "text/html" };
      const unsupported = yield* Effect.result(
        resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          messageTs: "1.0",
        })
      );
      assert.strictEqual(
        unsupported._tag === "Failure" ? unsupported.failure.reason : null,
        "unsupported-image-type"
      );

      metadata.current = {
        ...metadata.current,
        mimetype: "image/png",
        url_private_download:
          "https://files.slack.com/files-pri/TLABORER-FIMAGE/image.png",
      };
      const aggregate = yield* Effect.result(
        resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          maxAggregateBytes: png.byteLength - 1,
          messageTs: "1.0",
        })
      );
      assert.strictEqual(
        aggregate._tag === "Failure" ? aggregate.failure.reason : null,
        "aggregate-image-byte-limit"
      );
    })
  );

  it.effect("forwards authorization only across allowlisted redirects", () =>
    Effect.gen(function* () {
      const storageRoot = yield* makeTempDirectoryScoped(
        "laborer-inbound-image-redirect-"
      );
      const requests: string[] = [];
      let redirectTarget =
        "https://files-origin.slack.com/files-pri/TLABORER-FIMAGE/image.png";
      const resolver = makeSlackInboundImageResolver({
        client: {
          files: {
            info: () =>
              Promise.resolve({
                file: {
                  id: "FIMAGE",
                  mimetype: "image/png",
                  size: png.byteLength,
                  url_private_download:
                    "https://files.slack.com/files-pri/TLABORER-FIMAGE/image.png",
                },
              }),
          },
          token: "test-bot-token",
        } as never,
        fetch: ((input, init) => {
          requests.push(
            `${String(input)} ${new Headers(init?.headers).get("authorization")}`
          );
          return Promise.resolve(
            requests.length === 1 || requests.length === 3
              ? new Response(null, {
                  headers: { location: redirectTarget },
                  status: 302,
                })
              : new Response(png, {
                  headers: {
                    "content-length": String(png.byteLength),
                    "content-type": "image/png",
                  },
                })
          );
        }) as typeof fetch,
        storageRoot,
      });

      const allowed = yield* Effect.result(
        resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          messageTs: "1.0",
        })
      );
      assert.strictEqual(allowed._tag, "Success");
      assert.strictEqual(requests.length, 2);

      redirectTarget = "https://attacker.example/image.png";
      const rejected = yield* Effect.result(
        resolver({
          candidates: [{ id: "FIMAGE" }],
          channelId: "CWORK",
          messageTs: "2.0",
        })
      );
      assert.strictEqual(
        rejected._tag === "Failure" ? rejected.failure.reason : null,
        "untrusted-download-origin"
      );
      assert.strictEqual(requests.length, 3);
      assert.isFalse(requests.some((request) => request.includes("attacker")));
    })
  );

  it.effect("does not stage partial input when a later download fails", () =>
    Effect.gen(function* () {
      const storageRoot = yield* makeTempDirectoryScoped(
        "laborer-inbound-image-partial-"
      );
      const firstDigest = createHash("sha256").update(png).digest("hex");
      const resolver = makeSlackInboundImageResolver({
        client: {
          files: {
            info: ({ file }: { readonly file: string }) =>
              Promise.resolve({
                file: {
                  id: file,
                  mimetype: "image/png",
                  size: png.byteLength,
                  url_private_download: `https://files.slack.com/files-pri/TLABORER-${file}/image.png`,
                },
              }),
          },
          token: "test-bot-token",
        } as never,
        fetch: ((input) =>
          Promise.resolve(
            new Response(
              String(input).includes("FSECOND") ? new Uint8Array(8) : png,
              {
              headers: {
                "content-length": String(png.byteLength),
                "content-type": "image/png",
              },
              }
            )
          )) as typeof fetch,
        storageRoot,
      });

      const result = yield* Effect.result(
        resolver({
          candidates: [{ id: "FFIRST" }, { id: "FSECOND" }],
          channelId: "CWORK",
          messageTs: "1.0",
        })
      );
      const firstWasStaged = yield* Effect.promise(() =>
        readFile(
          resolve(storageRoot, "inbound-images", `${firstDigest}.png`)
        ).then(
          () => true,
          () => false
        )
      );

      assert.strictEqual(
        result._tag === "Failure" ? result.failure.reason : null,
        "image-signature-mismatch"
      );
      assert.isFalse(firstWasStaged);
    })
  );

  it("marks adopted image history unavailable instead of claiming text-only understanding", () => {
    const adopted = normalizeConversationAdoptionHistoryMessage({
      botId: identity.botId,
      botUserId: identity.botUserId,
      channelId: "CWORK",
      message: {
        files: [{ id: "FADOPTED" }],
        subtype: "file_share",
        ts: "1.0",
        user: "UHUMAN",
      },
      workspaceId: identity.teamId,
    });

    assert.strictEqual(adopted?.imageUnavailable, true);
    assert.strictEqual(adopted?.text, "");
  });

  it.effect(
    "keeps image-only context and follow-ups as ordered durable input",
    () =>
      Effect.gen(function* () {
        const image = NormalizedImageInput.make({
          byteLength: png.byteLength,
          contentDigest: "b".repeat(64),
          contentPath: `inbound-images/${"b".repeat(64)}.png`,
          id: "image-parent",
          mimeType: "image/png",
          slackFileId: "FPARENT",
        });
        const turns: import("../src/prototype/domain.ts").ClaimedTurn[] = [];
        const slack: SlackGatewayShape = {
          postThreadMessage: () => Effect.succeed({ ts: "unused" }),
          readActivationContext: () =>
            Effect.succeed([
              NormalizedMessage.make({
                authorKind: "human",
                authorSlackId: "UHUMAN",
                classification: "context",
                id: MessageId.make("CWORK:1.0"),
                images: [image],
                isActivation: false,
                slackTs: "1.0",
                text: "",
              }),
            ]),
        };
        const harness = yield* makePrototypeHarness({
          handler: {
            invoke: (turn) => Effect.sync(() => turns.push(turn)),
          },
          laborerSlackId: identity.botUserId,
          slack,
        });
        const activation = NormalizedInboundEvent.make({
          authorKind: "human",
          authorSlackId: "UHUMAN",
          channelId: "CWORK",
          channelKind: "public",
          eventId: EventId.make("EvActivation"),
          images: [],
          messageTs: "2.0",
          recordKind: "message",
          text: "<@ULABORER> do the thing",
          threadTs: "1.0",
        });
        yield* harness.runner.inject(activation);
        const followup = NormalizedInboundEvent.make({
          authorKind: "human",
          authorSlackId: "UHUMAN",
          channelId: "CWORK",
          channelKind: "public",
          eventId: EventId.make("EvFollowupImage"),
          images: [
            NormalizedImageInput.make({
              ...image,
              id: "image-followup",
              slackFileId: "FFOLLOWUP",
            }),
          ],
          messageTs: "3.0",
          recordKind: "message",
          text: null,
          threadTs: "1.0",
        });
        const decision = yield* harness.runner.inject(followup);

        assert.strictEqual(decision._tag, "Accepted");
        assert.strictEqual(turns.length, 2);
        assert.deepStrictEqual(turns[0]?.context[0]?.images, [image]);
        assert.strictEqual(turns[1]?.messages[0]?.text, "");
        assert.strictEqual(
          turns[1]?.messages[0]?.images?.[0]?.slackFileId,
          "FFOLLOWUP"
        );
      })
  );

  it.effect(
    "submits durable bytes as an ACP image block only when advertised",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const storageRoot =
            yield* makeTempDirectoryScoped("laborer-acp-image-");
          const imageDirectory = resolve(storageRoot, "inbound-images");
          const imageDigest = createHash("sha256").update(png).digest("hex");
          const imagePath = resolve(imageDirectory, `${imageDigest}.png`);
          const promptPath = resolve(storageRoot, "prompt-content.jsonl");
          const readyPath = resolve(storageRoot, "prompt-ready");
          const releasePath = resolve(storageRoot, "prompt-release");
          yield* Effect.promise(async () => {
            await mkdir(imageDirectory, { mode: 0o700 });
            await writeFile(imagePath, png, { mode: 0o600 });
            await writeFile(releasePath, "release", { mode: 0o600 });
          });
          const image = NormalizedImageInput.make({
            byteLength: png.byteLength,
            contentDigest: imageDigest,
            contentPath: `inbound-images/${imageDigest}.png`,
            id: "acp-image",
            mimeType: "image/png",
            slackFileId: "FACP",
          });
          const message = NormalizedMessage.make({
            authorKind: "human",
            authorSlackId: "UHUMAN",
            classification: "input",
            id: MessageId.make("CWORK:1.0"),
            images: [image],
            isActivation: true,
            slackTs: "1.0",
            text: "inspect this",
          });
          const agent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: storageRoot,
            environment: {
              HOME: storageRoot,
              PATH: process.env.PATH,
              SCRIPTED_ACP_IMAGE_PROMPT_CAPABILITY: "1",
              SCRIPTED_ACP_PROMPT_CONTENT_JSONL_PATH: promptPath,
              SCRIPTED_ACP_READY_PATH: readyPath,
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            imageStorageRoot: storageRoot,
          });
          yield* agent.handle(
            {
              actions: [],
              context: [],
              conversationId: "conversation:image",
              conversationSessionId: "session:image",
              conversationSessionIsNew: true,
              executionControls: [],
              executions: [],
              input: "inspect this",
              messages: [message],
              promptId: "prompt:image",
              source: "slack",
              turnId: "turn:image",
            },
            () => Effect.void
          );
          const [line] = (yield* Effect.promise(() =>
            readFile(promptPath, "utf8")
          ))
            .trim()
            .split("\n");
          const blocks = JSON.parse(line ?? "[]") as Record<string, unknown>[];
          assert.strictEqual(blocks[0]?.type, "text");
          assert.strictEqual(blocks[1]?.type, "image");
          assert.strictEqual(blocks[1]?.mimeType, "image/png");
          assert.strictEqual(
            blocks[1]?.data,
            Buffer.from(png).toString("base64")
          );

          const rejectedPromptPath = resolve(
            storageRoot,
            "rejected-prompt-content.jsonl"
          );
          const incapableAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: storageRoot,
            environment: {
              HOME: storageRoot,
              PATH: process.env.PATH,
              SCRIPTED_ACP_PROMPT_CONTENT_JSONL_PATH: rejectedPromptPath,
              SCRIPTED_ACP_READY_PATH: readyPath,
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            imageStorageRoot: storageRoot,
          });
          const rejected = yield* Effect.result(
            incapableAgent.handle(
              {
                actions: [],
                context: [],
                conversationId: "conversation:incapable-image",
                conversationSessionId: "session:incapable-image",
                conversationSessionIsNew: true,
                executionControls: [],
                executions: [],
                input: "inspect this",
                messages: [message],
                promptId: "prompt:incapable-image",
                source: "slack",
                turnId: "turn:incapable-image",
              },
              () => Effect.void
            )
          );
          assert.strictEqual(rejected._tag, "Failure");
          if (rejected._tag === "Failure") {
            assert.strictEqual(
              rejected.failure.safeDetail,
              "the selected Conversation agent does not support image input"
            );
          }
          const rejectedPromptExists = yield* Effect.promise(() =>
            readFile(rejectedPromptPath).then(
              () => true,
              () => false
            )
          );
          assert.isFalse(rejectedPromptExists);
        })
      )
  );
});
