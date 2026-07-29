import { access, readFile } from "node:fs/promises";
import { assert, describe, it } from "@effect/vitest";

const exists = (url: URL): Promise<boolean> =>
  access(url).then(
    () => true,
    () => false
  );

describe("issue #278 primary Cluster cutover", () => {
  it("keeps only the primary runtime commands and implementation", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly scripts: Readonly<Record<string, string>> };

    assert.notProperty(packageJson.scripts, "prototype:actions");
    assert.notProperty(packageJson.scripts, "prototype:conversation-execution");
    assert.isFalse(
      await exists(new URL("../src/action-toolkit-prototype", import.meta.url))
    );
    assert.isFalse(
      await exists(new URL("../src/cluster-runtime", import.meta.url))
    );
    assert.isFalse(
      await exists(
        new URL(
          "../src/conversation-execution-tracer-prototype",
          import.meta.url
        )
      )
    );
  });

  it("registers the user application in the normal Slack root runtime", async () => {
    const [live, runner] = await Promise.all([
      readFile(new URL("../src/slack/live.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../src/slack/acp-workspace-runner.ts", import.meta.url),
        "utf8"
      ),
    ]);

    assert.include(live, "makeReferenceCodingRootApplication");
    assert.include(live, "application,");
    assert.notInclude(runner, "CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT");
    assert.include(runner, "options.rootRuntime.actions.fingerprint");
  });
});
