import { randomInt, randomUUID } from "node:crypto";
import { chmod, link, lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSafeFilePath } from "../prototype/path-safety.ts";

const LOCK_RETRY_MILLIS = 25;
const LOCK_MAX_RETRY_MILLIS = 2000;
const LOCK_WAIT_MILLIS = 30_000;

interface LockDatabaseIdentity {
  readonly device: bigint | number;
  readonly inode: bigint | number;
}

interface HeldLock {
  readonly assertOwned: () => Promise<void>;
  readonly database: DatabaseSync;
  readonly identity: LockDatabaseIdentity;
  readonly path: string;
}

export interface HeldContextLocks {
  readonly assertCanCommit: () => Promise<void>;
}

const errorCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

const throwIfCancelled = (
  signal: AbortSignal | undefined,
  onCancelled: (() => unknown) | undefined
): void => {
  if (signal?.aborted !== true) {
    return;
  }
  throw onCancelled?.() ?? signal.reason ?? new Error("Context lock cancelled");
};

const cancellableDelay = (
  milliseconds: number,
  signal: AbortSignal | undefined,
  onCancelled: (() => unknown) | undefined
): Promise<void> =>
  new Promise((resolveDelay, rejectDelay) => {
    try {
      throwIfCancelled(signal, onCancelled);
    } catch (error) {
      rejectDelay(error);
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      rejectDelay(
        onCancelled?.() ?? signal?.reason ?? new Error("Context lock cancelled")
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const isSqliteContention = (error: unknown): boolean => {
  const code = errorCode(error);
  const resultCode =
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number"
      ? error.errcode
      : null;
  return (
    code?.startsWith("SQLITE_BUSY") === true ||
    code?.startsWith("SQLITE_LOCKED") === true ||
    resultCode === 5 ||
    resultCode === 6 ||
    (error instanceof Error &&
      (error.message.includes("database is locked") ||
        error.message.includes("database table is locked")))
  );
};

const canonicalLockPath = async (path: string): Promise<string> =>
  resolve(await realpath(dirname(path)), basename(path));

const ensureOwnerOnlyLockDatabase = async (
  path: string
): Promise<LockDatabaseIdentity> => {
  await assertSafeFilePath({
    anchor: dirname(path),
    operation: "prepare-context-lock",
    path,
  });
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  if (metadata === undefined) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let temporaryDatabase: DatabaseSync | undefined;
    try {
      temporaryDatabase = new DatabaseSync(temporaryPath, {
        defensive: true,
        timeout: 0,
      });
      temporaryDatabase.exec(
        "CREATE TABLE lock_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))"
      );
      temporaryDatabase.close();
      temporaryDatabase = undefined;
      await chmod(temporaryPath, 0o600);
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      temporaryDatabase?.close();
      await rm(temporaryPath, { force: true });
    }
    metadata = await lstat(path);
  }
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== undefined && metadata.uid !== currentUserId)
  ) {
    throw new Error("Context lock is not an owner-controlled regular file");
  }
  await chmod(path, 0o600);
  return { device: metadata.dev, inode: metadata.ino };
};

const verifyLockIdentity = async (
  path: string,
  expected: LockDatabaseIdentity
): Promise<void> => {
  const metadata = await lstat(path);
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== expected.device ||
    metadata.ino !== expected.inode ||
    (currentUserId !== undefined && metadata.uid !== currentUserId)
  ) {
    throw new Error("Context lock identity changed");
  }
};

const acquireLock = async (
  inputPath: string,
  signal: AbortSignal | undefined,
  onCancelled: (() => unknown) | undefined
): Promise<HeldLock> => {
  const path = await canonicalLockPath(inputPath);
  const identity = await ensureOwnerOnlyLockDatabase(path);
  const database = new DatabaseSync(path, { defensive: true, timeout: 0 });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + LOCK_WAIT_MILLIS;
    let retryMillis = LOCK_RETRY_MILLIS;
    while (Date.now() < deadline) {
      throwIfCancelled(signal, onCancelled);
      try {
        database.exec("BEGIN IMMEDIATE");
        await verifyLockIdentity(path, identity);
        const assertOwned = async (): Promise<void> => {
          if (!database.isTransaction) {
            throw new Error("Context lock transaction ended unexpectedly");
          }
          await verifyLockIdentity(path, identity);
        };
        return { assertOwned, database, identity, path };
      } catch (error) {
        if (!isSqliteContention(error)) {
          throw error;
        }
      }
      const jitter = randomInt(0, Math.max(2, Math.ceil(retryMillis / 4)));
      const remainingMillis = deadline - Date.now();
      if (remainingMillis <= 0) {
        break;
      }
      await cancellableDelay(
        Math.min(remainingMillis, retryMillis + jitter),
        signal,
        onCancelled
      );
      retryMillis = Math.min(
        LOCK_MAX_RETRY_MILLIS,
        Math.ceil(retryMillis * 1.5)
      );
    }
    throw new Error("Context lock wait timed out");
  } catch (error) {
    database.close();
    throw error;
  }
};

const releaseLock = (lock: HeldLock): void => {
  if (lock.database.isTransaction) {
    try {
      lock.database.exec("ROLLBACK");
    } catch {
      // The original operation result remains authoritative.
    }
  }
  lock.database.close();
};

export const withCrossProcessContextLocks = async <A>(options: {
  readonly lockPaths: readonly string[];
  readonly onCancelled?: (() => unknown) | undefined;
  readonly operation: (locks: HeldContextLocks) => Promise<A>;
  readonly signal?: AbortSignal | undefined;
}): Promise<A> => {
  const canonicalPaths = await Promise.all(
    options.lockPaths.map(canonicalLockPath)
  );
  const orderedPaths = [...new Set(canonicalPaths)].sort();
  const held: HeldLock[] = [];
  try {
    for (const path of orderedPaths) {
      held.push(await acquireLock(path, options.signal, options.onCancelled));
    }
    const assertCanCommit = async (): Promise<void> => {
      throwIfCancelled(options.signal, options.onCancelled);
      for (const lock of held) {
        await lock.assertOwned();
      }
    };
    await assertCanCommit();
    const result = await options.operation({ assertCanCommit });
    await assertCanCommit();
    return result;
  } finally {
    for (const lock of held.reverse()) {
      releaseLock(lock);
    }
  }
};
