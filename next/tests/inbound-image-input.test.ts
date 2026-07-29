import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { WebClient } from "@slack/web-api";
import { Effect } from "effect";
import {
  canonicalThreadId,
  ReadyNormalizedImageInput,
  stableMessageId,
} from "../src/prototype/domain.ts";
import {
  makeSlackGateway,
  normalizeSlackHistoryMessage,
} from "../src/prototype/emulated-slack.ts";
import {
  makeSlackImageInputHydrator,
  type SlackImageInputHydrator,
} from "../src/slack/image-input.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
]);

const fileClient = (overrides?: { readonly url?: string }) => ({
  files: {
    info: async () => ({
      file: {
        id: "F301",
        mimetype: "image/png",
        size: PNG.byteLength,
        url_private_download:
          overrides?.url ??
          "https://files.slack.com/files-pri/T301-F301/task.png",
      },
      ok: true,
    }),
  },
  token: ["xox", "b-image-test-secret"].join(""),
});

describe("canonical-parent image hydration", () => {
  it("normalizes an image-only canonical parent as Historical context", () => {
    const message = normalizeSlackHistoryMessage({
      botId: "B301LABORER",
      botUserId: "U301LABORER",
      channelId: "C301",
      images: [
        ReadyNormalizedImageInput.make({
          byteLength: PNG.byteLength,
          contentDigest: "digest-301",
          id: "image:301",
          mimeType: "image/png",
          storagePath: "image-inputs/digest-301",
        }),
      ],
      message: {
        files: [{ id: "F301" }],
        text: "",
        ts: "301.0",
        user: "U301HUMAN",
      },
      workspaceId: "T301",
    });

    assert.equal(message?.id, stableMessageId("C301", "301.0", "T301"));
    assert.equal(message?.text, "");
    assert.equal(message?.images?.[0]?._tag, "Ready");
  });

  it.effect(
    "stages a validated Slack image without durable private metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-image-input-"
          );
          const storageRoot = resolve(directory, "work-threads");
          yield* Effect.promise(() => mkdir(storageRoot, { mode: 0o700 }));
          const authorization: string[] = [];
          const hydrator = makeSlackImageInputHydrator({
            client: fileClient(),
            fetch: (_input, init) => {
              authorization.push(
                new Headers(init?.headers).get("authorization") ?? ""
              );
              return Promise.resolve(
                new Response(PNG, {
                  headers: {
                    "content-length": String(PNG.byteLength),
                    "content-type": "image/png",
                  },
                })
              );
            },
            storageRoot,
          });

          const images = yield* hydrator.hydrate({
            files: [{ id: "F301", mimetype: "image/png" }],
            messageId: "workspace:T301:C301:171.1",
          });

          assert.equal(images.length, 1);
          const image = images[0];
          assert.equal(image?._tag, "Ready");
          if (image?._tag !== "Ready") {
            return;
          }
          assert.deepEqual(
            new Uint8Array(
              yield* Effect.promise(() =>
                readFile(resolve(storageRoot, image.storagePath))
              )
            ),
            PNG
          );
          assert.equal(
            (yield* Effect.promise(() =>
              stat(resolve(storageRoot, image.storagePath))
            )).mode % 0o1000,
            0o600
          );
          assert.deepEqual(authorization, [
            `Bearer ${["xox", "b-image-test-secret"].join("")}`,
          ]);
          assert.isFalse(JSON.stringify(image).includes("files.slack.com"));
          assert.isFalse(
            JSON.stringify(image).includes(["xox", "b-"].join(""))
          );
          assert.isFalse(JSON.stringify(image).includes("F301"));
        })
      )
  );

  it.effect(
    "rejects an untrusted redirect before forwarding authorization",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-image-redirect-"
          );
          const storageRoot = resolve(directory, "work-threads");
          yield* Effect.promise(() => mkdir(storageRoot, { mode: 0o700 }));
          const requests: string[] = [];
          const hydrator = makeSlackImageInputHydrator({
            client: fileClient(),
            fetch: (input) => {
              requests.push(String(input));
              return Promise.resolve(
                Response.redirect("https://attacker.example/image.png", 302)
              );
            },
            storageRoot,
          });

          const images = yield* hydrator.hydrate({
            files: [{ id: "F301", mimetype: "image/png" }],
            messageId: "message-301",
          });

          assert.deepEqual(requests, [
            "https://files.slack.com/files-pri/T301-F301/task.png",
          ]);
          assert.equal(images[0]?._tag, "Failed");
          if (images[0]?._tag === "Failed") {
            assert.equal(images[0].reason, "unsafe-download-url");
          }
        })
      )
  );

  it.effect(
    "bounds a response body that stalls after authenticated fetch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-image-timeout-"
          );
          const storageRoot = resolve(directory, "work-threads");
          yield* Effect.promise(() => mkdir(storageRoot, { mode: 0o700 }));
          let cancelled = false;
          const hydrator = makeSlackImageInputHydrator({
            client: fileClient(),
            downloadTimeoutMillis: 20,
            fetch: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel: () => {
                      cancelled = true;
                    },
                  }),
                  { headers: { "content-type": "image/png" } }
                )
              ),
            storageRoot,
          });

          const images = yield* hydrator.hydrate({
            files: [{ id: "F301", mimetype: "image/png" }],
            messageId: "message-timeout",
          });

          assert.equal(images[0]?._tag, "Failed");
          if (images[0]?._tag === "Failed") {
            assert.equal(images[0].reason, "download-timeout");
          }
          assert.isTrue(cancelled);
        })
      )
  );

  it.effect(
    "fails closed for malformed file references and truncated downloads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-image-invalid-"
          );
          const storageRoot = resolve(directory, "work-threads");
          yield* Effect.promise(() => mkdir(storageRoot, { mode: 0o700 }));
          const hydrator = makeSlackImageInputHydrator({
            client: fileClient(),
            fetch: () =>
              Promise.resolve(
                new Response(PNG, {
                  headers: {
                    "content-length": String(PNG.byteLength + 1),
                    "content-type": "image/png",
                  },
                })
              ),
            storageRoot,
          });

          const malformed = yield* hydrator.hydrate({
            files: [{ mimetype: "image/png" }],
            messageId: "message-malformed",
          });
          const truncated = yield* hydrator.hydrate({
            files: [{ id: "F301", mimetype: "image/png" }],
            messageId: "message-truncated",
          });

          assert.equal(malformed[0]?._tag, "Failed");
          if (malformed[0]?._tag === "Failed") {
            assert.equal(malformed[0].reason, "metadata-unavailable");
          }
          assert.equal(truncated[0]?._tag, "Failed");
          if (truncated[0]?._tag === "Failed") {
            assert.equal(truncated[0].reason, "invalid-response");
          }
        })
      )
  );

  it.effect(
    "hydrates only the canonical parent during reply Activation context",
    () =>
      Effect.gen(function* () {
        const hydratedMessageIds: string[] = [];
        const imageInputHydrator: SlackImageInputHydrator = {
          hydrate: ({ messageId }) => {
            hydratedMessageIds.push(messageId);
            return Effect.succeed([]);
          },
        };
        const gateway = makeSlackGateway({
          botClient: {
            conversations: {
              replies: async () => ({
                messages: [
                  {
                    files: [{ id: "FROOT", mimetype: "image/png" }],
                    text: "canonical parent",
                    ts: "301.0",
                    user: "U301",
                  },
                  {
                    files: [{ id: "FREPLY", mimetype: "image/png" }],
                    text: "earlier reply",
                    thread_ts: "301.0",
                    ts: "301.1",
                    user: "U301",
                  },
                  {
                    text: "<@U301LABORER> activate",
                    thread_ts: "301.0",
                    ts: "301.2",
                    user: "U301",
                  },
                ],
              }),
            },
          } as unknown as WebClient,
          botId: "B301LABORER",
          botUserId: "U301LABORER",
          imageInputHydrator,
          pageSize: 100,
          workspaceId: "T301",
        });

        const context = yield* gateway.readActivationContext({
          activationTs: "301.2",
          channelId: "C301",
          isReplyActivation: true,
          retryAtMillis: null,
          rootTs: "301.0",
          threadId: canonicalThreadId("C301", "301.0", "T301"),
        });

        assert.deepEqual(
          context.map((message) => message.slackTs),
          ["301.0", "301.1"]
        );
        assert.deepEqual(hydratedMessageIds, [
          stableMessageId("C301", "301.0", "T301"),
        ]);
      })
  );
});
