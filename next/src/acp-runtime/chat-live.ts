import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Redacted } from "effect";
import {
  ChatPlane,
  type ChatPlaneShape,
  makeLiveChatPlaneLayer,
} from "../chat-plane/chat-sdk.ts";
import { makeConversationHandler } from "../chat-plane/conversation-handler.ts";
import { makeNodeRootDurableRuntime } from "../durable-runtime/node-root.ts";
import { makeReferenceCodingRootApplication } from "../durable-runtime/reference-coding-application.ts";
import {
  loadSlackDaemonConfig,
  type SlackDaemonConfig,
} from "../slack/config.ts";
import { authenticateSlackBot } from "../slack/identity.ts";
import { loadLaborerConfig } from "../slack/laborer-config.ts";
import {
  deleteRetiredSlackRuntimeState,
  prepareSlackRuntimePaths,
} from "../slack/runtime-paths.ts";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";
import type { AcpPermissionBroker } from "./acp-permission-broker.ts";
import {
  handleChatPermissionAction,
  makeChatAcpPermissionPresenter,
} from "./chat-permission.ts";
import {
  type AcpChatWorkspaceRuntime,
  makeAcpChatWorkHandler,
} from "./chat-work-handler.ts";
import { makeBoundedSlackParticipantLookup } from "./slack-participant-lookup.ts";
import { makeProductionAcpWorkspaceApplication } from "./workspace-runtime.ts";

const stateRoot = (): string => {
  const configured = process.env.XDG_STATE_HOME?.trim();
  return resolve(
    configured !== undefined && isAbsolute(configured)
      ? configured
      : resolve(homedir(), ".local", "state"),
    "laborer"
  );
};

const waitForShutdownSignal: Effect.Effect<void> = Effect.callback((resume) => {
  const stop = () => resume(Effect.void);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return Effect.sync(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
});

/** The one production composition: Chat owns Slack; ACP owns agent runtime. */
export const runAcpChatComposition = Effect.fn("AcpRuntime.runChatComposition")(
  function* (
    config: SlackDaemonConfig,
    options: {
      readonly botUserIds?: ReadonlyMap<string, string>;
      readonly stateFile?: string;
      readonly workspaceStatePrefix?: string;
    } = {}
  ) {
    const workspaces = new Map<string, AcpChatWorkspaceRuntime>();
    const brokers = new Map<string, AcpPermissionBroker>();
    const attachmentRoots = new Map<string, string>();
    let chat: ChatPlaneShape | undefined;

    for (const installation of config.installations) {
      if (!installation.tokenIsValid || installation.root === undefined) {
        continue;
      }
      if (!("expectedTeamId" in installation)) {
        return yield* Effect.die(
          new Error(
            "Chat production runtime requires workspace-scoped installation configuration"
          )
        );
      }
      const workspaceId = installation.expectedTeamId;
      const laborer = yield* loadLaborerConfig({
        defaultRoot: installation.root,
        environment: { ...process.env, LABORER_ROOT: installation.root },
      });
      yield* deleteRetiredSlackRuntimeState(laborer.root);
      const stateWorkspaceId =
        options.workspaceStatePrefix === undefined
          ? workspaceId
          : `${options.workspaceStatePrefix}:${workspaceId}`;
      const paths = yield* prepareSlackRuntimePaths(
        stateWorkspaceId,
        process.env
      );
      const prepared = { laborer, paths };
      const applicationConfig = prepared.laborer.config.application;
      if (applicationConfig === undefined) {
        return yield* Effect.die(
          new Error("ACP Chat runtime requires a registered application")
        );
      }
      const rootApplication = yield* makeReferenceCodingRootApplication({
        config: applicationConfig,
        environment: process.env,
        paths: prepared.paths,
        root: prepared.laborer.root,
      });
      const rootRuntime = yield* makeNodeRootDurableRuntime({
        application: rootApplication,
        databasePath: prepared.paths.runtimeDatabase,
        rootIdentity: prepared.laborer.root,
      });
      const workspace = yield* makeProductionAcpWorkspaceApplication(
        {
          applicationConfig,
          environment: process.env,
          laborerSlackId:
            options.botUserIds?.get(workspaceId) ?? "chat:laborer",
          paths: prepared.paths,
          root: prepared.laborer.root,
          rootRuntime,
          workspaceId,
        },
        {
          participantLookup: makeBoundedSlackParticipantLookup({
            token: Redacted.value(installation.botToken),
          }),
          permissionPresenter: makeChatAcpPermissionPresenter({
            post: (request) => {
              if (chat === undefined) {
                return Effect.die(new Error("Chat plane is not ready"));
              }
              return chat.postPermission(request);
            },
            settle: (request) => chat?.settlePermission(request) ?? Effect.void,
          }),
          publishExternalOutput: (conversationId, output) => {
            if (chat === undefined) {
              return Effect.void;
            }
            const prefix = `workspace:${workspaceId}:`;
            if (!conversationId.startsWith(prefix)) {
              return Effect.void;
            }
            const [channelId, rootTs, ...remainder] = conversationId
              .slice(prefix.length)
              .split(":");
            if (
              channelId === undefined ||
              rootTs === undefined ||
              remainder.length > 0
            ) {
              return Effect.void;
            }
            return chat
              .postToThread(workspaceId, channelId, rootTs, output.text)
              .pipe(Effect.ignore);
          },
        }
      );
      workspaces.set(workspaceId, {
        acceptEvent: (event) =>
          Effect.succeed({
            decision: { _tag: "Accepted", eventId: event.eventId },
            scheduling: "AlreadyDurable",
          }),
        application: workspace.application,
      });
      brokers.set(workspaceId, workspace.permissionBroker);
      attachmentRoots.set(workspaceId, prepared.paths.attachments);
    }

    const workHandler = makeAcpChatWorkHandler({
      forWorkspace: (workspaceId) => {
        const workspace = workspaces.get(workspaceId);
        return workspace === undefined
          ? Effect.die(new Error("Unknown authenticated Slack workspace"))
          : Effect.succeed(workspace);
      },
    });
    const layer = makeLiveChatPlaneLayer(
      {
        appToken: Redacted.value(config.appToken),
        installations: config.installations.flatMap((installation) =>
          installation.tokenIsValid &&
          "expectedTeamId" in installation &&
          workspaces.has(installation.expectedTeamId)
            ? [
                {
                  botToken: Redacted.value(installation.botToken),
                  teamId: installation.expectedTeamId,
                },
              ]
            : []
        ),
        statePath: resolve(stateRoot(), options.stateFile ?? "chat.sqlite"),
        userName: "laborer",
      },
      makeConversationHandler(workHandler),
      {
        attachmentStorageRoot: (workspaceId) =>
          attachmentRoots.get(workspaceId),
        actionHandler: (action) =>
          handleChatPermissionAction(
            {
              brokerForWorkspace: (workspaceId) => {
                const broker = brokers.get(workspaceId);
                return broker === undefined
                  ? Effect.die(new Error("Unknown permission workspace"))
                  : Effect.succeed(broker);
              },
            },
            {
              actionId: action.actionId,
              capability: action.capability,
              channelId: action.channelId,
              messageTs: action.messageTs,
              rootTs: action.rootTs,
              slackUserId: action.slackUserId,
              workspaceId: action.workspaceId,
            }
          ).pipe(Effect.asVoid),
        onReady: (service) => {
          chat = service;
        },
      }
    );

    yield* Effect.gen(function* () {
      yield* ChatPlane;
      yield* Console.log(
        "LIVE SLACK LABORER — Chat plane with ACP Conversations enabled."
      );
      yield* waitForShutdownSignal;
    }).pipe(Effect.provide(layer), Effect.scoped);
    yield* Console.log("Slack Laborer stopped cleanly.");
  }
);

export const runAcpChatDaemon = Effect.fn("AcpRuntime.runChatDaemon")(
  function* (defaultRoot: string) {
    const config = yield* loadSlackDaemonConfig({ defaultRoot });
    const botUserIds = new Map<string, string>();
    const installations = yield* Effect.forEach(
      config.installations,
      (installation) =>
        Effect.gen(function* () {
          if (!installation.tokenIsValid || installation.root === undefined) {
            return installation;
          }
          const identity = yield* authenticateSlackBot(
            new WebClient(
              Redacted.value(installation.botToken),
              slackWebApiRequestPolicy
            )
          );
          const expectedTeamId =
            "expectedTeamId" in installation
              ? installation.expectedTeamId
              : undefined;
          if (
            expectedTeamId !== undefined &&
            expectedTeamId !== identity.teamId
          ) {
            return yield* Effect.die(
              new Error("Slack installation identity mismatch")
            );
          }
          botUserIds.set(identity.teamId, identity.botUserId);
          return {
            ...installation,
            expectedTeamId: identity.teamId,
          };
        })
    );
    return yield* runAcpChatComposition(
      { ...config, installations },
      { botUserIds }
    );
  }
);
