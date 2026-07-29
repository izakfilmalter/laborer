import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  NormalizedImageInput,
  UnavailableNormalizedImageInput,
} from "../src/prototype/domain.ts";
import {
  CONVERSATION_ADOPTION_HISTORY_MAX_BYTES,
  CONVERSATION_ADOPTION_HISTORY_MAX_MESSAGES,
  makeSlackConversationAdoptionHistoryGateway,
} from "../src/slack/conversation-adoption-history.ts";

interface FakePage {
  readonly messages?: readonly Record<string, unknown>[];
  readonly nextCursor?: string;
}

const gatewayFor = (options: {
  readonly failures?: readonly unknown[];
  readonly maxPages?: number;
  readonly pages: readonly FakePage[];
}) => {
  let requestCount = 0;
  const requests: Record<string, unknown>[] = [];
  const gateway = makeSlackConversationAdoptionHistoryGateway({
    botId: "B-LABORER",
    botUserId: "U-LABORER",
    client: {
      conversations: {
        replies: (request: Record<string, unknown>) => {
          requests.push(request);
          const failure = options.failures?.[requestCount];
          const page = options.pages[requestCount];
          requestCount += 1;
          if (failure !== undefined) {
            return Promise.reject(failure);
          }
          return Promise.resolve({
            messages: page?.messages ?? [],
            response_metadata: { next_cursor: page?.nextCursor ?? "" },
          });
        },
      },
    },
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    requestTimeoutMillis: 1000,
    transientRetries: 0,
    workspaceId: "T-ADOPT",
  });
  return { gateway, requests };
};

const readHistory = (gateway: ReturnType<typeof gatewayFor>["gateway"]) =>
  gateway.read({
    channelId: "C-PRIVATE",
    cutoffSlackTs: "2000000000.000100",
    rootTs: "1999999999.000001",
    workspaceId: "T-ADOPT",
  });

const adoptedImage = (fileId: string, index: number) =>
  NormalizedImageInput.make({
    byteLength: 8,
    contentDigest: String(index + 1).repeat(64),
    contentPath: `inbound-images/${String(index + 1).repeat(64)}.png`,
    id: `adopted-image-${index}`,
    mimeType: "image/png",
    slackFileId: fileId,
  });

describe("conversation adoption Slack history", () => {
  it.effect("uses current visible truth with stable attributed authors", () =>
    Effect.gen(function* () {
      const { gateway, requests } = gatewayFor({
        pages: [
          {
            messages: [
              {
                edited: { ts: "2000000000.000001", user: "U-EDITOR" },
                text: "edited current <text> & now",
                ts: "1999999999.000010",
                user: "U-HUMAN",
              },
              {
                bot_id: "B-EXTERNAL",
                subtype: "bot_message",
                text: "external bot",
                ts: "1999999999.000020",
              },
              {
                bot_id: "B-LABORER",
                subtype: "bot_message",
                text: "visible Laborer output",
                ts: "1999999999.000030",
                user: "U-LABORER",
              },
              {
                subtype: "message_deleted",
                text: "must not survive",
                ts: "1999999999.000040",
                user: "U-HUMAN",
              },
              { blocks: [], ts: "1999999999.000050", user: "U-HUMAN" },
              {
                subtype: "channel_join",
                text: "unsupported",
                ts: "1999999999.000060",
                user: "U-HUMAN",
              },
              {
                text: "trigger must be excluded",
                ts: "2000000000.000100",
                user: "U-HUMAN",
              },
            ],
          },
        ],
      });
      const snapshot = yield* readHistory(gateway);
      assert.strictEqual(snapshot.degradation, "complete");
      assert.strictEqual(snapshot.messageCount, 3);
      assert.ok(snapshot.rendered.includes('author-kind="human"'));
      assert.ok(snapshot.rendered.includes('author-kind="externalBot"'));
      assert.ok(snapshot.rendered.includes('author-kind="laborer"'));
      assert.ok(
        snapshot.rendered.includes("edited current &lt;text&gt; &amp; now")
      );
      assert.ok(!snapshot.rendered.includes("must not survive"));
      assert.ok(!snapshot.rendered.includes("unsupported"));
      assert.ok(!snapshot.rendered.includes("trigger must"));
      assert.ok(snapshot.rendered.includes('trust="untrusted-reference-only"'));
      assert.deepStrictEqual(
        requests.map((request) => request.channel),
        ["C-PRIVATE"]
      );
      assert.strictEqual(requests[0]?.inclusive, false);
      assert.strictEqual(requests[0]?.latest, "2000000000.000100");
    })
  );

  it.effect(
    "retains the newest chronological suffix within count and exact UTF-8 bytes",
    () =>
      Effect.gen(function* () {
        const messages = Array.from(
          { length: CONVERSATION_ADOPTION_HISTORY_MAX_MESSAGES + 5 },
          (_, index) => ({
            text:
              index === CONVERSATION_ADOPTION_HISTORY_MAX_MESSAGES + 4
                ? `newest-${"🧪".repeat(70_000)}`
                : `message-${index}`,
            ts: `1999999999.${String(index).padStart(6, "0")}`,
            user: "U-HUMAN",
          })
        );
        const { gateway } = gatewayFor({ pages: [{ messages }] });
        const snapshot = yield* readHistory(gateway);
        assert.ok(snapshot.bytes <= CONVERSATION_ADOPTION_HISTORY_MAX_BYTES);
        assert.strictEqual(
          Buffer.byteLength(snapshot.rendered, "utf8"),
          snapshot.bytes
        );
        assert.strictEqual(snapshot.truncation.count, true);
        assert.strictEqual(snapshot.truncation.bytes, true);
        assert.ok(snapshot.rendered.includes('reason="count"'));
        assert.ok(snapshot.rendered.includes('reason="bytes"'));
        assert.ok(!snapshot.rendered.includes("message-0<"));
      })
  );

  it.effect(
    "marks age, partial, unavailable, retry exhaustion, and pagination limits without fabricating content",
    () =>
      Effect.gen(function* () {
        const partial = gatewayFor({
          maxPages: 1,
          pages: [
            {
              messages: [
                {
                  text: "known visible record",
                  ts: "1999999999.000010",
                  user: "U-HUMAN",
                },
              ],
              nextCursor: "more",
            },
          ],
        });
        const partialSnapshot = yield* readHistory(partial.gateway);
        assert.strictEqual(partialSnapshot.degradation, "partial");
        assert.deepStrictEqual(partialSnapshot.diagnosticCodes, ["page-limit"]);
        assert.ok(partialSnapshot.rendered.includes("known visible record"));
        assert.ok(partialSnapshot.rendered.includes('code="page-limit"'));

        const unavailable = gatewayFor({
          failures: [new Error("private credential must not persist")],
          pages: [],
        });
        const unavailableSnapshot = yield* readHistory(unavailable.gateway);
        assert.strictEqual(unavailableSnapshot.degradation, "unavailable");
        assert.deepStrictEqual(unavailableSnapshot.diagnosticCodes, [
          "slack-permanent",
        ]);
        assert.ok(!unavailableSnapshot.rendered.includes("credential"));
        assert.strictEqual(unavailableSnapshot.messageCount, 0);

        const oldRoot = makeSlackConversationAdoptionHistoryGateway({
          botId: "B-LABORER",
          botUserId: "U-LABORER",
          client: {
            conversations: { replies: async () => ({ messages: [] }) },
          },
          workspaceId: "T-ADOPT",
        });
        const oldSnapshot = yield* oldRoot.read({
          channelId: "C-PRIVATE",
          cutoffSlackTs: "2000000000.000100",
          rootTs: "1000000000.000001",
          workspaceId: "T-ADOPT",
        });
        assert.strictEqual(oldSnapshot.truncation.age, true);
        assert.ok(oldSnapshot.rendered.includes('reason="age"'));
      })
  );

  it.effect("fails closed across workspace scope", () =>
    Effect.gen(function* () {
      const { gateway, requests } = gatewayFor({ pages: [] });
      const snapshot = yield* gateway.read({
        channelId: "C-PRIVATE",
        cutoffSlackTs: "2000000000.000100",
        rootTs: "1999999999.000001",
        workspaceId: "T-OTHER",
      });
      assert.strictEqual(snapshot.degradation, "unavailable");
      assert.strictEqual(requests.length, 0);
    })
  );

  it.effect(
    "hydrates adopted images in chronological Slack order and records bounded failures",
    () =>
      Effect.gen(function* () {
        const calls: string[][] = [];
        const gateway = makeSlackConversationAdoptionHistoryGateway({
          botId: "B-LABORER",
          botUserId: "U-LABORER",
          client: {
            conversations: {
              replies: async () => ({
                messages: [
                  {
                    files: [
                      { id: "F-ONE", mimetype: "image/png" },
                      { id: "F-TWO", mimetype: "image/png" },
                    ],
                    subtype: "file_share",
                    text: "first caption",
                    ts: "1999999999.000010",
                    user: "U-ONE",
                  },
                  {
                    files: [{ id: "F-THREE", mimetype: "image/png" }],
                    subtype: "file_share",
                    ts: "1999999999.000020",
                    user: "U-TWO",
                  },
                ],
              }),
            },
          },
          resolveImages: (request) => {
            calls.push(request.candidates.map(({ id }) => id));
            return request.messageTs.endsWith("20")
              ? Effect.succeed([
                  UnavailableNormalizedImageInput.make({
                    failureReason: "download-timeout",
                    id: "adopted-image-2",
                    slackFileId: "F-THREE",
                  }),
                ])
              : Effect.succeed(
                  request.candidates.map(({ id }, index) =>
                    adoptedImage(id, index)
                  )
                );
          },
          workspaceId: "T-ADOPT",
        });

        const snapshot = yield* readHistory(gateway);

        assert.deepStrictEqual(calls, [["F-ONE", "F-TWO"], ["F-THREE"]]);
        assert.deepStrictEqual(
          snapshot.images.map((image) => image.slackFileId),
          ["F-ONE", "F-TWO", "F-THREE"]
        );
        assert.ok(snapshot.rendered.indexOf("first caption") >= 0);
        assert.ok(
          snapshot.rendered.indexOf("adopted-image-0") <
            snapshot.rendered.indexOf("adopted-image-1")
        );
        assert.ok(snapshot.rendered.includes('reason="download-timeout"'));
      })
  );
});
