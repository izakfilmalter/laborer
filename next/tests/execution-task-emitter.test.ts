import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { openExecutionTaskEmitter } from "../src/task-db/execution-task-emitter.ts";
import { NativeTaskDatabase } from "../src/task-db/task-database.ts";

const directories: string[] = [];
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const temporaryPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "laborer-execution-tasks-"));
  directories.push(directory);
  return join(directory, "laborer.sqlite");
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const projection = (status: "queued" | "completed" | "failed" | "cancelled") =>
  ({
    acceptedAtUnixMs: 1234,
    actionName: "deal-with-bug",
    conversationId: "workspace:T1:C1:100.200",
    executionId: "execution-1",
    input: {
      prompt: "Fix it",
      title: "Fix startup race",
      worktreeName: "fix-startup-race",
    },
    status,
    workspaceId: "T1",
  }) as const;

describe("execution task emission", () => {
  it("inserts once, enriches the permalink, and mirrors lifecycle mapping", async () => {
    const path = temporaryPath();
    const emitter = openExecutionTaskEmitter({
      databasePath: path,
      resolveSlackPermalink: async ({ channelId, rootTs, workspaceId }) =>
        `https://slack.test/${workspaceId}/${channelId}/${rootTs}`,
      repositoryPath: "/projects/laborer",
      rootPath: "/projects/laborer/packages/app",
    });

    await Effect.runPromise(emitter.emit(projection("queued")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const database = NativeTaskDatabase.open(path);
    expect(database.findByExecutionId("execution-1")).toMatchObject({
      actionName: "deal-with-bug",
      branchName: "laborer/fix-startup-race",
      executionStatus: "queued",
      rootPath: "/projects/laborer/packages/app",
      slackPermalink: "https://slack.test/T1/C1/100.200",
      status: "in_progress",
      title: "Fix startup race",
      worktreePath: "/projects/laborer.worktrees/fix-startup-race",
    });
    expect(database.findByExecutionId("execution-1")?.id).toMatch(ULID_PATTERN);

    await Effect.runPromise(emitter.emit(projection("completed")));
    expect(database.findByExecutionId("execution-1")).toMatchObject({
      executionStatus: "completed",
      status: "in_review",
    });
    await Effect.runPromise(emitter.emit(projection("failed")));
    expect(database.findByExecutionId("execution-1")).toMatchObject({
      executionStatus: "failed",
      status: "in_review",
    });
    await Effect.runPromise(emitter.emit(projection("cancelled")));
    expect(database.findByExecutionId("execution-1")).toMatchObject({
      executionStatus: "cancelled",
      status: "cancelled",
    });
    const revision = database.findByExecutionId("execution-1")?.revision;
    await Effect.runPromise(emitter.emit(projection("cancelled")));
    expect(database.findByExecutionId("execution-1")?.revision).toBe(revision);
    expect(database.changesAfter(0).map(({ taskId }) => taskId)).toEqual([
      database.findByExecutionId("execution-1")?.id,
      database.findByExecutionId("execution-1")?.id,
      database.findByExecutionId("execution-1")?.id,
      database.findByExecutionId("execution-1")?.id,
      database.findByExecutionId("execution-1")?.id,
    ]);
    database.close();
    emitter.close();
  });

  it("does not wait for optional permalink enrichment", async () => {
    const emitter = openExecutionTaskEmitter({
      databasePath: temporaryPath(),
      resolveSlackPermalink: () => new Promise(() => undefined),
      rootPath: "/projects/laborer",
    });
    await Effect.runPromise(emitter.emit(projection("queued")));
    emitter.close();
  });

  it("drops malformed emission without failing its caller", async () => {
    const path = temporaryPath();
    const emitter = openExecutionTaskEmitter({
      databasePath: path,
      rootPath: "/projects/laborer",
    });
    await expect(
      Effect.runPromise(
        emitter.emit({ ...projection("queued"), input: { title: " " } })
      )
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        emitter.emit({
          ...projection("queued"),
          input: {
            prompt: "Fix it",
            title: "Unsafe persisted worktree",
            worktreeName: "../outside",
          },
        })
      )
    ).resolves.toBeUndefined();
    const database = NativeTaskDatabase.open(path);
    expect(database.findByExecutionId("execution-1")).toBeNull();
    database.close();
    emitter.close();
  });
});
