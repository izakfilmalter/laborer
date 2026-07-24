import { stat } from "node:fs/promises";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { WebClient } from "@slack/web-api";
import { Effect } from "effect";
import { SlackRuntimeIdentity } from "../src/slack/config.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeSlackWorkspaceRunner } from "../src/slack/workspace-runner.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const pathExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    stat(path)
      .then(() => true)
      .catch(() => false)
  );

it.effect(
  "keeps configured workHandler state on legacy state.json while exposing the cutover Runner path",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-high-runner-state-"
        );
        const paths = yield* prepareSlackRuntimePaths(root);

        yield* makeSlackWorkspaceRunner({
          client: new WebClient("test-token"),
          gateway: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
          identity: SlackRuntimeIdentity.make({
            botId: "BTEST",
            botUserId: "UTEST",
            teamId: "TTEST",
          }),
          laborer: {
            config: {
              workHandler: {
                args: [],
                command: "/usr/bin/true",
                environment: [],
              },
            },
            root,
          },
          paths,
        });

        assert.strictEqual(
          paths.legacyHandlerState,
          join(paths.root, "state.json")
        );
        assert.strictEqual(
          paths.runnerState,
          join(paths.root, "runner-state.json")
        );
        assert.strictEqual(yield* pathExists(paths.legacyHandlerState), true);
        assert.strictEqual(yield* pathExists(paths.runnerState), false);
      })
    )
);
