import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NativeTaskDatabase", () => {
  it("migrates a fresh database once and a second writer adopts it", () => {
    const path = temporaryDatabasePath();
    const first = NativeTaskDatabase.open(path);
    expect(first.migrationNames()).toEqual(["0000_shared_task_db"]);

    const second = NativeTaskDatabase.open(path);
    expect(second.migrationNames()).toEqual(["0000_shared_task_db"]);

    second.close();
    first.close();
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

    expect(database.changesFor(inserted.id)).toEqual([
      { sequence: 1, changedAt: 10 },
      { sequence: 2, changedAt: 20 },
    ]);
    expect(() =>
      database.update(inserted.id, 1, { title: "stale" }, 30)
    ).toThrow(TaskStaleRevisionError);
    expect(database.changesFor(inserted.id)).toHaveLength(2);
    database.close();
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
