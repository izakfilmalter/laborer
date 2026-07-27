import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { Effect, Redacted, Schema } from "effect";
import {
  ApplicationConversationMessageChunk,
  type ApplicationShape,
} from "../../src/application.ts";
import { slackConversationStreamDeliveryPolicy } from "../../src/prototype/conversation-stream-delivery.ts";
import { PrototypeState } from "../../src/prototype/domain.ts";
import {
  makeSlackActivationAcknowledger,
  makeSlackCompletionReactor,
  makeSlackGateway,
} from "../../src/prototype/emulated-slack.ts";
import { makePrototypeHarness } from "../../src/prototype/runtime.ts";
import { normalizedEvent } from "../../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../../src/prototype/store.ts";
import type { SlackRuntimeIdentity } from "../../src/slack/config.ts";
import { makeSlackNativeStreamCapability } from "../../src/slack/native-stream.ts";
import { prepareSlackRuntimePaths } from "../../src/slack/runtime-paths.ts";
import { slackWebApiRequestPolicy } from "../../src/slack/web-api-request-policy.ts";
import {
  type SlackWorkspaceStartupAdapter,
  startSlackWorkspaceDirectory,
} from "../../src/slack/workspace-startup.ts";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const root = requiredEnvironment("STREAM_ROOT");
const serverUrl = requiredEnvironment("STREAM_SLACK_API_URL");
const controls = requiredEnvironment("STREAM_CONTROLS");
const action = requiredEnvironment("STREAM_ACTION");
const transport = process.env.STREAM_TRANSPORT ?? "fallback";
const workspaceId = "TSTREAMPRODUCTION";
const botUserId = "USTREAMPRODUCTION";
const channelId = "CSTREAMPRODUCTION";
const rootTs = "250.100";
const eventId = "event:stream-production-crash";
const token = ["x", "oxb", "-stream-production"].join("");
const identity: SlackRuntimeIdentity = {
  botId: "BSTREAMPRODUCTION",
  botUserId,
  teamId: workspaceId,
};
const releasePath = join(controls, "release");
const waitForRelease = Effect.promise(async () => {
  while (true) {
    try {
      await readFile(releasePath);
      return;
    } catch {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
});

const application: ApplicationShape = {
  handle: (event, publish) =>
    event._tag === "ParticipantInput"
      ? Effect.gen(function* () {
          yield* publish(
            ApplicationConversationMessageChunk.make({
              messageId: "production-delayed-recovery-message",
              text: "**Streaming** from ACP",
            })
          );
          yield* waitForRelease;
          yield* publish(
            ApplicationConversationMessageChunk.make({
              messageId: "production-delayed-recovery-message",
              text: "\n\n- complete\n- unchanged",
            })
          );
        })
      : Effect.void,
};

const readState = (path: string): Effect.Effect<PrototypeState> =>
  Effect.promise(async () =>
    Schema.decodeUnknownSync(PrototypeState)(
      JSON.parse(await readFile(path, "utf8")) as unknown
    )
  );

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      writeFile(
        join(root, "laborer.json"),
        JSON.stringify({
          application: {
            environment: [],
            type: "reference-coding",
          },
        }),
        { mode: 0o600 }
      )
    );
    const byClient = new Map<WebClient, SlackRuntimeIdentity>();
    const adapter: SlackWorkspaceStartupAdapter<
      WebClient,
      ReturnType<typeof makeSlackGateway>
    > = {
      authenticate: (client) =>
        Effect.succeed(byClient.get(client) ?? identity),
      makeClient: () => {
        const client = new WebClient(token, {
          ...slackWebApiRequestPolicy,
          slackApiUrl: serverUrl,
        });
        byClient.set(client, identity);
        return client;
      },
      makeGateway: ({ client }) =>
        makeSlackGateway({
          botId: identity.botId,
          botClient: client,
          botUserId,
          conversationStreamDeliveryPolicy:
            slackConversationStreamDeliveryPolicy,
          ...(transport === "native"
            ? {
                nativeStreaming: makeSlackNativeStreamCapability({
                  client: client.chat,
                  recipientTeamId: identity.teamId,
                }),
              }
            : {}),
          pageSize: 100,
          workspaceId,
        }),
      makeRunner: (runtime) =>
        Effect.gen(function* () {
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: makeSlackActivationAcknowledger(
              runtime.client
            ),
            application,
            completionReactor: makeSlackCompletionReactor(runtime.client),
            laborerSlackId: runtime.identity.botUserId,
            slack: runtime.gateway,
            storeLayer: makeFileStoreLayer(
              runtime.identity.botUserId,
              runtime.paths.runnerState,
              runtime.paths.root
            ),
          });
          return harness.runner;
        }),
      makeSetupIncompleteResponder: () => () => Effect.void,
    };
    const routes = yield* startSlackWorkspaceDirectory({
      adapter,
      config: {
        appToken: Redacted.make(["x", "app", "-stream-production"].join("")),
        installations: [
          {
            bindingIndex: 0,
            botToken: Redacted.make(token),
            botTokenEnvironment: "SLACK_BOT_TOKEN_STREAM_PRODUCTION",
            expectedTeamId: workspaceId,
            namespaceWorkspace: true,
            root,
            tokenIsValid: true,
            validation: { _tag: "Valid" },
          },
        ],
        startupMode: "multi-workspace",
      },
      environment: {},
    });
    const installation = yield* routes.awaitReady(workspaceId);
    if (installation.runner === undefined) {
      return yield* Effect.die(new Error("production stream Runner is absent"));
    }
    const paths = yield* prepareSlackRuntimePaths(root, workspaceId);
    if (action === "production") {
      yield* installation.runner
        .inject(
          normalizedEvent({
            authorSlackId: "USTREAMHUMAN",
            channelId,
            eventId,
            messageTs: rootTs,
            text: `<@${botUserId}> production crash stream`,
            workspaceId,
          })
        )
        .pipe(Effect.forkScoped);
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const result = yield* Effect.exit(readState(paths.runnerState));
        if (result._tag === "Success") {
          const state = result.value;
          const stream = state.conversationStreams[0];
          if (
            stream?.confirmedOffset === [..."**Streaming** from ACP"].length &&
            stream.slackTs !== null
          ) {
            process.stdout.write("PARTIAL_ACKNOWLEDGED\n");
            return yield* Effect.never;
          }
        }
        yield* Effect.sleep("10 millis");
      }
      return yield* Effect.die(
        new Error("production stream partial acknowledgement was not durable")
      );
    }
    if (action !== "production-recover") {
      return yield* Effect.die(
        new Error(`unsupported production stream action: ${action}`)
      );
    }

    process.stdout.write("RECOVERY_STARTED\n");
    let state = yield* readState(paths.runnerState);
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      const stream =
        state.conversationStreams[0] ??
        state.conversationStreamTombstones.at(-1);
      if (
        stream?.lifecycle === "unresolved" ||
        stream?.lifecycle === "stopped"
      ) {
        break;
      }
      yield* Effect.sleep("10 millis");
      state = yield* readState(paths.runnerState);
    }
    process.stdout.write(`RESULT:${JSON.stringify(state)}\n`);
  })
);

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
