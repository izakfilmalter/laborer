import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

const sourceFiles = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (extname(entry.name) === ".ts") {
      files.push(path);
    }
  }
  return files;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("issue #258 legacy Conversation cleanup", () => {
  it("keeps production source free of every removed runtime selector and protocol", async () => {
    const root = process.cwd();
    const sources = await sourceFiles(join(root, "src"));
    const production = (
      await Promise.all(sources.map((path) => readFile(path, "utf8")))
    ).join("\n");
    const forbidden = [
      `makeOpenCode${"Conversation"}Agent`,
      `makeHotReloading${"Conversation"}PromptConfig`,
      `DEFAULT_${"CONVERSATION"}_INSTRUCTIONS`,
      `IMPLEMENTATION_COMPAT_OPEN_CODE_${"PERMISSION"}`,
      "Return exactly one JSON object and no markdown.",
      `conversation-execution-live-${"canary"}-prototype`,
    ];
    for (const token of forbidden) {
      assert.ok(
        !production.includes(token),
        `removed production token: ${token}`
      );
    }
    assert.ok(
      !production.includes(
        `{ action: "allow", pattern: "*", permission: "*" }`
      ),
      "production source must not install the legacy wildcard allow"
    );

    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8")
    ) as { readonly scripts: Readonly<Record<string, string>> };
    assert.ok(!(`start:slack:${"acp"}` in packageJson.scripts));
    assert.ok(
      !(`start:conversation-execution-${"canary"}` in packageJson.scripts)
    );
    assert.strictEqual(
      packageJson.scripts["start:slack"],
      "node --env-file-if-exists=.env.local src/slack/live.ts"
    );

    assert.strictEqual(
      await pathExists(join(root, "src/slack/acp-live.ts")),
      false
    );
    assert.strictEqual(
      await pathExists(join(root, "src/slack/conversation-prompt-config.ts")),
      false
    );
  });

  it("retains the generic application seam and implementation adapter", async () => {
    const [adapter, application, runner] = await Promise.all([
      readFile(join(process.cwd(), "src/adapters/opencode-agents.ts"), "utf8"),
      readFile(
        join(process.cwd(), "src/reference-coding-application.ts"),
        "utf8"
      ),
      readFile(join(process.cwd(), "src/slack/workspace-runner.ts"), "utf8"),
    ]);

    assert.ok(adapter.includes("makeOpenCodeImplementationAgent"));
    assert.ok(adapter.includes("legacySession.promptAsync"));
    assert.ok(adapter.includes("legacySession.update"));
    assert.ok(adapter.includes("prepareSessionForReuse"));
    assert.ok(application.includes("ConversationAgentShape"));
    assert.ok(application.includes('origin: "legacy"'));
    assert.ok(
      runner.includes(
        "makeReferenceCodingWorkspaceApplicationWithConversationAgent"
      )
    );
    assert.ok(runner.includes("makeLazyOpenCodeImplementationAgent"));
    assert.ok(runner.includes("legacyHandlerState"));
  });
});
