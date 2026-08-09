/** Credential- and state-isolated manual canary over the production runtime. */
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import { Effect, Redacted } from "effect";
import {
  loadAcpCanarySlackConfig,
  type SlackDaemonConfig,
} from "../slack/config.ts";
import { authenticateSlackBot } from "../slack/identity.ts";
import { loadLaborerConfig } from "../slack/laborer-config.ts";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";
import { runAcpChatComposition } from "./chat-live.ts";

const DEFAULT_LABORER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const program = Effect.gen(function* () {
  // This loader rejects production and Chat-canary credential reuse before any
  // connection is made. The Web API call is a manual canary identity preflight,
  // not a second receiver.
  const canary = yield* loadAcpCanarySlackConfig();
  const laborer = yield* loadLaborerConfig({
    defaultRoot: DEFAULT_LABORER_ROOT,
  });
  const identity = yield* authenticateSlackBot(
    new WebClient(Redacted.value(canary.botToken), slackWebApiRequestPolicy)
  );
  const config = {
    appToken: canary.appToken,
    installations: [
      {
        bindingIndex: 0,
        botToken: canary.botToken,
        botTokenEnvironment: "LABORER_ACP_CANARY_BOT_TOKEN",
        expectedTeamId: identity.teamId,
        namespaceWorkspace: true,
        root: laborer.root,
        tokenIsValid: true,
        validation: { _tag: "Valid" },
      },
    ],
    startupMode: "multi-workspace",
  } satisfies SlackDaemonConfig;
  yield* runAcpChatComposition(config, {
    stateFile: `acp-canary-${identity.teamId}.sqlite`,
    workspaceStatePrefix: "acp-canary",
  });
}).pipe(Effect.scoped);

await Effect.runPromise(program);
