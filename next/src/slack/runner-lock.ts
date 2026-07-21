import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { Effect, type Scope } from "effect";
import { assertSafeFilePath } from "../prototype/path-safety.ts";
import { RunnerLockError } from "./errors.ts";

const LOCK_HOST = "127.0.0.1";
const MINIMUM_LOCK_PORT = 20_000;
const LOCK_PORT_RANGE = 40_000;

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HeldRunnerLock {
  readonly identity: FileIdentity;
  readonly path: string;
  readonly server: Server;
}

const lockFailure = (reason: string): RunnerLockError =>
  RunnerLockError.make({ operation: "runner-lock", reason });

const errorCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

const closeFile = async (file: FileHandle): Promise<void> => {
  await file.close();
};

const lockPortFor = (runtimeRoot: string): number => {
  const digest = createHash("sha256").update(runtimeRoot).digest();
  return MINIMUM_LOCK_PORT + (digest.readUInt32BE(0) % LOCK_PORT_RANGE);
};

const listenOnPort = (port: number): Promise<Server> =>
  new Promise((resolveListen, rejectListen) => {
    const server = createServer((socket) => socket.end());
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      exclusive: true,
      host: LOCK_HOST,
      port,
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
        return;
      }
      rejectClose(error);
    });
  });

const markerIdentity = async (path: string): Promise<FileIdentity> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw lockFailure("lock-path-is-symbolic-link");
  }
  if (!metadata.isFile()) {
    throw lockFailure("lock-path-is-not-regular-file");
  }
  return { device: metadata.dev, inode: metadata.ino };
};

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

const writeMarker = async (
  runtimeRoot: string,
  path: string,
  port: number
): Promise<FileIdentity> => {
  await assertSafeFilePath({
    anchor: runtimeRoot,
    operation: "runner-lock",
    path,
  });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      const rootIdentity = createHash("sha256")
        .update(runtimeRoot)
        .digest("hex");
      await file.writeFile(
        JSON.stringify({ port, rootIdentity, version: 1 }),
        "utf8"
      );
      await file.sync();
    } finally {
      await closeFile(file);
    }
    await assertSafeFilePath({
      anchor: runtimeRoot,
      operation: "runner-lock",
      path,
    });
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await closeFile(directory);
    }
    return await markerIdentity(path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const acquireLockPromise = async (
  runtimeRoot: string,
  path: string
): Promise<HeldRunnerLock> => {
  await assertSafeFilePath({
    anchor: runtimeRoot,
    operation: "runner-lock",
    path,
  });
  const port = lockPortFor(runtimeRoot);
  let server: Server;
  try {
    server = await listenOnPort(port);
  } catch (error) {
    throw errorCode(error) === "EADDRINUSE"
      ? lockFailure("already-held")
      : error;
  }
  try {
    const identity = await writeMarker(runtimeRoot, path, port);
    return { identity, path, server };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
};

const releaseLockPromise = async (lock: HeldRunnerLock): Promise<void> => {
  await closeServer(lock.server);
  try {
    const currentIdentity = await markerIdentity(lock.path);
    if (sameIdentity(lock.identity, currentIdentity)) {
      await unlink(lock.path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
};

export const acquireRunnerLock = (
  runtimeRoot: string,
  path: string
): Effect.Effect<void, RunnerLockError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireLockPromise(runtimeRoot, path),
      catch: (error) =>
        error instanceof RunnerLockError
          ? error
          : lockFailure("acquire-failed"),
    }),
    (lock) =>
      Effect.tryPromise({
        try: () => releaseLockPromise(lock),
        catch: () => lockFailure("release-failed"),
      }).pipe(Effect.orDie)
  ).pipe(Effect.asVoid);
