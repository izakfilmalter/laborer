import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { loadLaborerConfig } from "../src/slack/laborer-config.ts";
import {
  deleteRetiredSlackRuntimeState,
  prepareSlackRuntimePaths,
} from "../src/slack/runtime-paths.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laborer-314-")));
  temporaryRoots.push(root);
  return root;
};

describe("issue 314 production cutover", () => {
  it("fails closed when retired configured work-handler configuration is present", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "laborer.json"),
      JSON.stringify({
        application: { type: "reference-coding" },
        workHandler: { command: "node" },
      })
    );

    const failure = await Effect.runPromise(
      Effect.flip(loadLaborerConfig({ defaultRoot: root, environment: {} }))
    );

    expect(failure.reason).toBe("configured-work-handler-retired");
    expect(JSON.stringify(failure).length).toBeLessThan(2048);
  });

  it("partitions the sole runtime state root by authenticated workspace", async () => {
    const stateHome = await temporaryRoot();
    await mkdir(stateHome, { recursive: true });

    const first = await Effect.runPromise(
      prepareSlackRuntimePaths("T-FIRST", { XDG_STATE_HOME: stateHome })
    );
    const second = await Effect.runPromise(
      prepareSlackRuntimePaths("T-SECOND", { XDG_STATE_HOME: stateHome })
    );

    expect(first.root).toBe(
      resolve(stateHome, "laborer", "workspaces", "T-FIRST")
    );
    expect(second.root).toBe(
      resolve(stateHome, "laborer", "workspaces", "T-SECOND")
    );
    expect(first.runtimeDatabase).not.toBe(second.runtimeDatabase);
    expect(JSON.stringify(first)).not.toContain("runner-state.json");
  });

  it("deletes prior root-local runtime state without creating an archive", async () => {
    const root = await temporaryRoot();
    const retired = join(root, ".laborer-runtime");
    await mkdir(join(retired, "slack-workspaces", "T-OLD"), {
      recursive: true,
    });
    await writeFile(join(retired, "runner-state.json"), "old state");

    await Effect.runPromise(deleteRetiredSlackRuntimeState(root));

    await expect(
      readFile(join(retired, "runner-state.json"))
    ).rejects.toThrow();
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(root)
    );
    expect(entries.some((entry) => entry.includes("laborer-runtime"))).toBe(
      false
    );
  });

  it("makes the Chat/ACP entrypoint the only production Slack script", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["start:slack"]).toContain(
      "src/acp-runtime/production-live.ts"
    );
    expect(packageJson.scripts["dev:slack"]).toContain("node --watch");
    expect(JSON.stringify(packageJson.scripts)).not.toContain(
      "src/slack/live.ts"
    );
    expect(packageJson.scripts.prototype).toBeUndefined();
    expect(packageJson.scripts.recovery).toBeUndefined();
  });

  it("keeps the retired Slack plane and Runner modules out of live source", async () => {
    const retired = [
      "../src/development-daemon/dev.ts",
      "../src/durable-runtime/legacy-import.ts",
      "../src/prototype/process-handler.ts",
      "../src/prototype/runtime.ts",
      "../src/prototype/store.ts",
      "../src/slack/live.ts",
      "../src/slack/native-stream.ts",
      "../src/slack/normalize.ts",
      "../src/slack/socket-mode.ts",
      "../src/slack/workspace-startup.ts",
    ];

    const results = await Promise.all(
      retired.map((path) =>
        readFile(new URL(path, import.meta.url)).then(
          () => true,
          () => false
        )
      )
    );
    expect(results).toEqual(retired.map(() => false));
  });
});
