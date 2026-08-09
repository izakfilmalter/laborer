// biome-ignore-all lint/suspicious/useAwait: Chat SDK's StateAdapter contract requires Promise-returning methods.
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Lock, QueueEntry, StateAdapter } from "chat";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS chat_subscriptions (
    thread_id TEXT PRIMARY KEY NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chat_locks (
    thread_id TEXT PRIMARY KEY NOT NULL,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chat_cache (
    cache_key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chat_lists (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    list_key TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS chat_lists_key_sequence
    ON chat_lists (list_key, sequence);
  CREATE INDEX IF NOT EXISTS chat_lists_expiration
    ON chat_lists (expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS chat_queues (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS chat_queues_thread_sequence
    ON chat_queues (thread_id, sequence);
  CREATE INDEX IF NOT EXISTS chat_queues_expiration
    ON chat_queues (expires_at);
  CREATE INDEX IF NOT EXISTS chat_cache_expiration
    ON chat_cache (expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS chat_locks_expiration
    ON chat_locks (expires_at);
`;

const EXPIRATION_CLEANUP_BATCH_SIZE = 256;

export interface SQLiteStateAdapterOptions {
  readonly now?: () => number;
  readonly path: string;
}

const readString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Corrupt SQLite chat state: ${field} is not text`);
  }
  return value;
};

const readRowValue = (row: unknown, field: string): unknown => {
  if (typeof row !== "object" || row === null || !("value" in row)) {
    throw new Error(`Corrupt SQLite chat state: missing ${field}`);
  }
  return row.value;
};

const readInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Corrupt SQLite chat state: ${field} is not an integer`);
  }
  return value;
};

const serialize = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new Error("Chat state value is not JSON serializable");
  }
  return result;
};

const deserialize = <T>(value: unknown): T => {
  const encoded = readString(value, "value");
  try {
    return JSON.parse(encoded) as T;
  } catch {
    throw new Error("Corrupt SQLite chat state: value is not valid JSON");
  }
};

const validateBound = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
};

const expirationFrom = (now: number, ttlMs: number): number => {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error(
      "Chat state expiration exceeds SQLite's safe integer range"
    );
  }
  return expiresAt;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const assertRegularFileOrMissing = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("SQLite chat state path must be a regular file");
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
};

const deserializeQueueEntry = (value: unknown): QueueEntry => {
  const entry = deserialize<unknown>(value);
  if (typeof entry !== "object" || entry === null || !("message" in entry)) {
    throw new Error("Corrupt SQLite chat state: invalid queue entry");
  }
  const candidate = entry as Partial<QueueEntry>;
  validateBound(candidate.enqueuedAt ?? Number.NaN, "entry.enqueuedAt");
  validateBound(candidate.expiresAt ?? Number.NaN, "entry.expiresAt");
  if (typeof candidate.message !== "object" || candidate.message === null) {
    throw new Error("Corrupt SQLite chat state: invalid queued message");
  }
  return candidate as QueueEntry;
};

/** Durable, single-file Chat SDK state for the local Laborer daemon. */
export class SQLiteStateAdapter implements StateAdapter {
  readonly #now: () => number;
  readonly #path: string;
  #database: DatabaseSync | undefined;
  #connectPromise: Promise<void> | undefined;

  constructor(options: SQLiteStateAdapterOptions) {
    if (options.path.trim().length === 0 || !isAbsolute(options.path)) {
      throw new Error("SQLite chat state path must be absolute and nonblank");
    }
    this.#path = resolve(options.path);
    this.#now = options.now ?? Date.now;
  }

  async connect(): Promise<void> {
    if (this.#database !== undefined) {
      return;
    }
    this.#connectPromise ??= this.#open().catch((error: unknown) => {
      this.#connectPromise = undefined;
      throw error;
    });
    await this.#connectPromise;
  }

  async #open(): Promise<void> {
    const parent = dirname(this.#path);
    await mkdir(parent, { mode: 0o700, recursive: true });
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error("SQLite chat state parent must be a real directory");
    }
    await chmod(parent, 0o700);
    await assertRegularFileOrMissing(this.#path);
    const database = new DatabaseSync(this.#path, {
      defensive: true,
      timeout: 5000,
    });
    try {
      database.exec(SCHEMA);
      await assertRegularFileOrMissing(this.#path);
      await chmod(this.#path, 0o600);
      this.#database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.#connectPromise?.catch(() => undefined);
    const database = this.#database;
    this.#database = undefined;
    this.#connectPromise = undefined;
    database?.close();
  }

  async subscribe(threadId: string): Promise<void> {
    this.#prepare(
      "INSERT OR IGNORE INTO chat_subscriptions (thread_id) VALUES (?)"
    ).run(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.#prepare("DELETE FROM chat_subscriptions WHERE thread_id = ?").run(
      threadId
    );
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (
      this.#prepare(
        "SELECT 1 AS present FROM chat_subscriptions WHERE thread_id = ?"
      ).get(threadId) !== undefined
    );
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    validateBound(ttlMs, "ttlMs");
    const now = this.#now();
    this.#deleteExpired("chat_locks", now);
    const token = `sqlite_${randomUUID()}`;
    const expiresAt = expirationFrom(now, ttlMs);
    const result = this.#prepare(
      `INSERT INTO chat_locks (thread_id, token, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         token = excluded.token, expires_at = excluded.expires_at
       WHERE chat_locks.expires_at <= ?`
    ).run(threadId, token, expiresAt, now);
    return result.changes === 0 ? null : { expiresAt, threadId, token };
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.#prepare("DELETE FROM chat_locks WHERE thread_id = ?").run(threadId);
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.#prepare(
      "DELETE FROM chat_locks WHERE thread_id = ? AND token = ?"
    ).run(lock.threadId, lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    validateBound(ttlMs, "ttlMs");
    const now = this.#now();
    const result = this.#prepare(
      `UPDATE chat_locks SET expires_at = ?
       WHERE thread_id = ? AND token = ? AND expires_at > ?`
    ).run(expirationFrom(now, ttlMs), lock.threadId, lock.token, now);
    return result.changes > 0;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const database = this.#connectedDatabase();
    return this.#transaction(database, () => {
      const now = this.#now();
      const row: unknown = this.#prepare(
        `SELECT value FROM chat_cache
         WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`
      ).get(key, now);
      if (row === undefined) {
        this.#prepare(
          "DELETE FROM chat_cache WHERE cache_key = ? AND expires_at <= ?"
        ).run(key, now);
        return null;
      }
      return deserialize<T>(readRowValue(row, "cache value"));
    });
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      validateBound(ttlMs, "ttlMs");
    }
    const now = this.#now();
    this.#deleteExpired("chat_cache", now);
    this.#prepare(
      `INSERT INTO chat_cache (cache_key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         value = excluded.value, expires_at = excluded.expires_at`
    ).run(
      key,
      serialize(value),
      ttlMs === undefined ? null : expirationFrom(now, ttlMs)
    );
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    if (ttlMs !== undefined) {
      validateBound(ttlMs, "ttlMs");
    }
    const now = this.#now();
    this.#deleteExpired("chat_cache", now);
    const result = this.#prepare(
      `INSERT INTO chat_cache (cache_key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         value = excluded.value, expires_at = excluded.expires_at
       WHERE chat_cache.expires_at IS NOT NULL AND chat_cache.expires_at <= ?`
    ).run(
      key,
      serialize(value),
      ttlMs === undefined ? null : expirationFrom(now, ttlMs),
      now
    );
    return result.changes > 0;
  }

  async delete(key: string): Promise<void> {
    const database = this.#connectedDatabase();
    this.#transaction(database, () => {
      this.#prepare("DELETE FROM chat_cache WHERE cache_key = ?").run(key);
      this.#prepare("DELETE FROM chat_lists WHERE list_key = ?").run(key);
    });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    if (options?.maxLength !== undefined) {
      validateBound(options.maxLength, "maxLength");
    }
    if (options?.ttlMs !== undefined) {
      validateBound(options.ttlMs, "ttlMs");
    }
    const database = this.#connectedDatabase();
    this.#transaction(database, () => {
      const now = this.#now();
      this.#deleteExpired("chat_lists", now);
      const expiresAt =
        options?.ttlMs === undefined
          ? null
          : expirationFrom(now, options.ttlMs);
      this.#prepare(
        "INSERT INTO chat_lists (list_key, value, expires_at) VALUES (?, ?, ?)"
      ).run(key, serialize(value), expiresAt);
      this.#prepare(
        `UPDATE chat_lists SET expires_at = ?
         WHERE list_key = ? AND (expires_at IS NULL OR expires_at > ?)`
      ).run(expiresAt, key, now);
      if (options?.maxLength !== undefined) {
        this.#prepare(
          `DELETE FROM chat_lists
           WHERE list_key = ? AND (expires_at IS NULL OR expires_at > ?)
           AND sequence NOT IN (
             SELECT sequence FROM chat_lists
             WHERE list_key = ? AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY sequence DESC LIMIT ?
           )`
        ).run(key, now, key, now, options.maxLength);
      }
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const database = this.#connectedDatabase();
    return this.#transaction(database, () => {
      const now = this.#now();
      this.#deleteExpired("chat_lists", now);
      const rows: unknown[] = this.#prepare(
        `SELECT value FROM chat_lists
         WHERE list_key = ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY sequence ASC`
      ).all(key, now);
      return rows.map((row) => deserialize<T>(readRowValue(row, "list value")));
    });
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number
  ): Promise<number> {
    validateBound(maxSize, "maxSize");
    validateBound(entry.enqueuedAt, "entry.enqueuedAt");
    validateBound(entry.expiresAt, "entry.expiresAt");
    const database = this.#connectedDatabase();
    return this.#transaction(database, () => {
      const now = this.#now();
      this.#deleteExpired("chat_queues", now);
      if (entry.expiresAt > now) {
        this.#prepare(
          "INSERT INTO chat_queues (thread_id, value, expires_at) VALUES (?, ?, ?)"
        ).run(threadId, serialize(entry), entry.expiresAt);
      }
      this.#prepare(
        `DELETE FROM chat_queues
         WHERE thread_id = ? AND expires_at > ? AND sequence NOT IN (
           SELECT sequence FROM chat_queues
           WHERE thread_id = ? AND expires_at > ?
           ORDER BY sequence DESC LIMIT ?
         )`
      ).run(threadId, now, threadId, now, maxSize);
      const row: unknown = this.#prepare(
        `SELECT count(*) AS value FROM chat_queues
         WHERE thread_id = ? AND expires_at > ?`
      ).get(threadId, now);
      return readInteger(readRowValue(row, "queue depth"), "queue depth");
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const database = this.#connectedDatabase();
    return this.#transaction(database, () => {
      const now = this.#now();
      this.#deleteExpired("chat_queues", now);
      const row: unknown = this.#prepare(
        `DELETE FROM chat_queues WHERE sequence = (
           SELECT sequence FROM chat_queues WHERE thread_id = ?
           AND expires_at > ?
           ORDER BY sequence ASC LIMIT 1
         ) RETURNING value`
      ).get(threadId, now);
      return row === undefined
        ? null
        : deserializeQueueEntry(readRowValue(row, "queue value"));
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    const now = this.#now();
    this.#deleteExpired("chat_queues", now);
    const row: unknown = this.#prepare(
      `SELECT count(*) AS value FROM chat_queues
       WHERE thread_id = ? AND expires_at > ?`
    ).get(threadId, now);
    return readInteger(readRowValue(row, "queue depth"), "queue depth");
  }

  #connectedDatabase(): DatabaseSync {
    if (this.#database === undefined) {
      throw new Error(
        "SQLiteStateAdapter is not connected. Call connect() first."
      );
    }
    return this.#database;
  }

  #prepare(sql: string): StatementSync {
    return this.#connectedDatabase().prepare(sql);
  }

  #deleteExpired(
    table: "chat_cache" | "chat_lists" | "chat_locks" | "chat_queues",
    now: number
  ): void {
    this.#prepare(
      `DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table}
         WHERE expires_at IS NOT NULL AND expires_at <= ?
         LIMIT ?
       )`
    ).run(now, EXPIRATION_CLEANUP_BATCH_SIZE);
  }

  #transaction<A>(database: DatabaseSync, operation: () => A): A {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export const createSQLiteState = (
  options: SQLiteStateAdapterOptions
): StateAdapter => new SQLiteStateAdapter(options);
