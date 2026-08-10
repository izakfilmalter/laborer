import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { taskDbMigrations } from "../src/task-db/migrations.ts";
import {
  NativeTaskDatabase,
  TaskDatabaseSchemaTooNewError,
  TaskStaleRevisionError,
  taskDatabasePath,
} from "../src/task-db/task-database.ts";

const directories: string[] = [];

const temporaryDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "laborer-task-db-next-"));
  directories.push(directory);
  return join(directory, "laborer.sqlite");
};

const createPreDescriptionDatabase = (path: string): void => {
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL UNIQUE
  )`);
  const record = raw.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"
  );
  for (const migration of taskDbMigrations.slice(0, 2)) {
    raw.exec(migration.sql.replaceAll("--> statement-breakpoint", ""));
    record.run(
      createHash("sha256").update(migration.sql).digest("hex"),
      1,
      migration.name
    );
  }
  raw
    .prepare(`INSERT INTO tasks (
      id, root_path, title, status, source, initial_prompt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("existing", "/repo", "Existing", "todo", "manual", "Keep me", 1, 1);
  raw.close();
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NativeTaskDatabase", () => {
  it("migrates a fresh database once and a second writer adopts it", () => {
    const path = temporaryDatabasePath();
    const first = NativeTaskDatabase.open(path);
    expect(first.migrationNames()).toEqual([
      "0000_shared_task_db",
      "0001_execution_lifecycle_statuses",
      "0002_task_description_agent_source",
    ]);

    const second = NativeTaskDatabase.open(path);
    expect(second.migrationNames()).toEqual([
      "0000_shared_task_db",
      "0001_execution_lifecycle_statuses",
      "0002_task_description_agent_source",
    ]);

    second.close();
    first.close();
  });

  it("migrates initial prompts to descriptions without changing the ledger", () => {
    const path = temporaryDatabasePath();
    createPreDescriptionDatabase(path);

    const database = NativeTaskDatabase.open(path);
    expect(database.find("existing")).toMatchObject({
      description: "Keep me",
      revision: 1,
    });
    expect(database.changesAfter(0)).toEqual([]);
    database.close();
  });

  it("accepts agent tasks and rejects unknown sources", () => {
    const path = temporaryDatabasePath();
    const database = NativeTaskDatabase.open(path);
    expect(
      database.insert({
        id: "agent-task",
        rootPath: "/repo",
        title: "Agent task",
        description: "Follow up",
        status: "todo",
        source: "agent",
      }).task
    ).toMatchObject({ source: "agent", description: "Follow up" });
    database.close();

    const raw = new DatabaseSync(path);
    expect(() =>
      raw
        .prepare(`INSERT INTO tasks (
          id, root_path, title, status, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("unknown", "/repo", "Unknown", "todo", "unknown", 1, 1)
    ).toThrow();
    raw.close();
  });

  it("rejects a stale CAS across two writers", () => {
    const path = temporaryDatabasePath();
    const first = NativeTaskDatabase.open(path);
    const second = NativeTaskDatabase.open(path);
    const inserted = first.insert(
      {
        id: "task-1",
        rootPath: "/repo",
        title: "Original",
        status: "in_progress",
        source: "manual",
      },
      100
    ).task;
    const staleRevision = second.find(inserted.id)?.revision;

    const updated = first.update(
      inserted.id,
      inserted.revision,
      { title: "First" },
      200
    );
    expect(updated.revision).toBe(2);
    expect(() =>
      second.update(inserted.id, staleRevision ?? -1, { title: "Second" }, 300)
    ).toThrow(TaskStaleRevisionError);
    expect(second.find(inserted.id)?.title).toBe("First");

    second.close();
    first.close();
  });

  it("makes replayed execution inserts idempotent", () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath());
    const input = {
      id: "task-execution",
      rootPath: "/repo",
      title: "Execution",
      status: "in_progress" as const,
      source: "execution" as const,
      executionId: "execution-1",
      executionStatus: "running" as const,
    };

    expect(database.insert(input, 10).inserted).toBe(true);
    const replay = database.insert({ ...input, id: "replayed-id" }, 20);
    expect(replay).toMatchObject({
      inserted: false,
      task: { id: "task-execution", revision: 1 },
    });
    expect(database.changesAfter(0)).toHaveLength(1);
    database.close();
  });

  it("appends exactly one change in the same transaction as each mutation", () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath());
    const inserted = database.insert(
      {
        id: "task-ledger",
        rootPath: "/repo",
        title: "Ledger",
        status: "todo",
        source: "manual",
      },
      10
    ).task;
    database.update(
      inserted.id,
      inserted.revision,
      { status: "in_progress" },
      20
    );

    expect(database.changesAfter(0)).toEqual([
      { sequence: 1, taskId: inserted.id, changedAt: 10 },
      { sequence: 2, taskId: inserted.id, changedAt: 20 },
    ]);
    expect(() =>
      database.update(inserted.id, 1, { title: "stale" }, 30)
    ).toThrow(TaskStaleRevisionError);
    expect(database.changesAfter(0)).toHaveLength(2);
    database.close();
  });

  it("bounds change-ledger reads", () => {
    const database = NativeTaskDatabase.open(temporaryDatabasePath());
    database.insert({
      id: "task-bounded-ledger",
      rootPath: "/repo",
      title: "Bounded ledger",
      status: "todo",
      source: "manual",
    });

    expect(database.changesAfter(0, 1)).toHaveLength(1);
    expect(() => database.changesAfter(0, 1001)).toThrow(
      "A task change limit must be between 1 and 1000"
    );
    database.close();
  });

  it("enforces persisted task enums", () => {
    const path = temporaryDatabasePath();
    const database = NativeTaskDatabase.open(path);
    database.close();
    const raw = new DatabaseSync(path);

    expect(() =>
      raw
        .prepare(
          `INSERT INTO tasks (
            id, root_path, title, status, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("invalid", "/repo", "Invalid", "unknown", "manual", 1, 1)
    ).toThrow();
    raw.close();
  });

  it("fails closed when the migration ledger contains a newer schema", () => {
    const path = temporaryDatabasePath();
    const database = NativeTaskDatabase.open(path);
    database.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"
      )
      .run("future", Date.now(), "9999_future");
    raw.close();

    expect(() => NativeTaskDatabase.open(path)).toThrow(
      TaskDatabaseSchemaTooNewError
    );
  });
});

describe("taskDatabasePath", () => {
  it("uses only an absolute nonblank XDG_STATE_HOME", () => {
    expect(taskDatabasePath({ XDG_STATE_HOME: "/state" }, "/home/me")).toBe(
      "/state/laborer/laborer.sqlite"
    );
    expect(taskDatabasePath({ XDG_STATE_HOME: "relative" }, "/home/me")).toBe(
      "/home/me/.local/state/laborer/laborer.sqlite"
    );
  });
});

import { createHash } from "node:crypto";
