import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { opencodeV2Agent } from "../.sandcastle/opencode-v2-agent/index.ts";

const runCommand = async (
  command: string,
  stdin: string,
  env: NodeJS.ProcessEnv
): Promise<string> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Fake opencode2 exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(stdin);
  });

describe("Sandcastle OpenCode V2 agent", () => {
  it("matches its command contract to the installed pinned CLI", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const version = packageJson.devDependencies["@opencode-ai/cli"];
    const executable = "./node_modules/.bin/opencode2";
    const reportedVersion = execFileSync(executable, ["--version"], {
      encoding: "utf8",
    });
    const help = execFileSync(executable, ["run", "--help"], {
      encoding: "utf8",
    });

    assert.strictEqual(reportedVersion.trim(), `opencode2 v${version}`);
    for (const contract of [
      "--standalone",
      "--format choice",
      "--model, -m string",
      "provider/model#variant",
      "--agent string",
      "--auto",
    ]) {
      assert.include(help, contract);
    }
    assert.notInclude(help, "--variant");
  });

  it("launches standalone V2 with an encoded variant and preserves JSON events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "laborer-opencode-v2-"));
    const executable = join(directory, "opencode2");
    const argsPath = join(directory, "args");
    const stdinPath = join(directory, "stdin");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$FAKE_OPENCODE_ARGS"',
        'cat > "$FAKE_OPENCODE_STDIN"',
        'printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-1","part":{}}\'',
        'printf \'%s\\n\' \'{"type":"text","part":{"type":"text","text":"finished"}}\'',
        'printf \'%s\\n\' \'{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"bun test"}}}}\'',
      ].join("\n")
    );
    chmodSync(executable, 0o755);

    try {
      const agent = opencodeV2Agent("openai/gpt-5.6-sol", {
        agent: "build",
        variant: "medium",
      });
      const invocation = agent.buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: "Implement safely.\nThen test.",
      });
      const stdout = await runCommand(
        invocation.command,
        invocation.stdin ?? "",
        {
          ...process.env,
          FAKE_OPENCODE_ARGS: argsPath,
          FAKE_OPENCODE_STDIN: stdinPath,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        }
      );

      assert.deepStrictEqual(
        readFileSync(argsPath, "utf8").trimEnd().split("\n"),
        [
          "run",
          "--standalone",
          "--format",
          "json",
          "--model",
          "openai/gpt-5.6-sol#medium",
          "--agent",
          "build",
          "--auto",
        ]
      );
      assert.strictEqual(
        readFileSync(stdinPath, "utf8"),
        "Implement safely.\nThen test."
      );
      assert.deepStrictEqual(
        stdout
          .trimEnd()
          .split("\n")
          .flatMap((line) => agent.parseStreamLine(line)),
        [
          { sessionId: "session-1", type: "session_id" },
          { text: "finished", type: "text" },
          { result: "finished", type: "result" },
          { args: "bun test", name: "bash", type: "tool_call" },
        ]
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not auto-approve when Sandcastle preserves permission prompts", () => {
    const invocation = opencodeV2Agent(
      "anthropic/claude-opus-5"
    ).buildPrintCommand({
      dangerouslySkipPermissions: false,
      prompt: "Review",
    });

    assert.notInclude(invocation.command, "--auto");
    assert.include(invocation.command, "'anthropic/claude-opus-5'");
  });

  it("fails closed on malformed records and surfaces V2 errors", () => {
    const agent = opencodeV2Agent("fixture/model");

    assert.deepStrictEqual(agent.parseStreamLine("not-json"), []);
    assert.deepStrictEqual(agent.parseStreamLine('{"type":"text"'), []);
    assert.deepStrictEqual(
      agent.parseStreamLine(
        JSON.stringify({
          error: { message: "provider unavailable" },
          type: "error",
        })
      ),
      [{ result: "provider unavailable", type: "result" }]
    );
  });
});
