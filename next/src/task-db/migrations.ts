import { readFileSync } from "node:fs";

export interface TaskDbMigration {
  readonly name: string;
  readonly sql: string;
}

/** Append-only. Copy this file and the SQL migrations verbatim into current. */
export const taskDbMigrations: readonly TaskDbMigration[] = [
  {
    name: "0000_shared_task_db",
    sql: readFileSync(
      new URL("./migrations/0000_shared_task_db.sql", import.meta.url),
      "utf8"
    ),
  },
  {
    name: "0001_execution_lifecycle_statuses",
    sql: readFileSync(
      new URL(
        "./migrations/0001_execution_lifecycle_statuses.sql",
        import.meta.url
      ),
      "utf8"
    ),
  },
];
