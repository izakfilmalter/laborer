import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { type Duration, Effect, type Scope } from "effect";
import { assertSafeFilePath } from "../prototype/path-safety.ts";
import { RunnerLockError } from "./errors.ts";

const LOCK_HOST = "127.0.0.1";
const MINIMUM_LOCK_PORT = 20_000;
const LOCK_PORT_RANGE = 40_000;
const LOCK_ACQUISITION_TIMEOUT = "15 seconds";
const PENDING_CLEANUP_BOUND_MILLIS = 1000;

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HeldRunnerLock {
  readonly identity: FileIdentity;
  readonly path: string;
  readonly server: Server;
  readonly sockets: ReadonlySet<Socket>;
}

export interface RunnerLockAcquisitionBoundary {
  readonly acquisitionTimeout?: Duration.Input;
  readonly afterOwnedMarkerRemoved?: () => Promise<void>;
  readonly afterServerStarted?: Effect.Effect<void>;
  readonly afterTemporaryFileOpened?: (signal: AbortSignal) => Promise<void>;
}

export type RunnerLockAcquirer = (
  runtimeRoot: string,
  path: string
) => Effect.Effect<void, RunnerLockError, Scope.Scope>;

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

const listenOnPort = (
  port: number,
  signal: AbortSignal,
  server: Server
): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    const removeListeners = () => {
      signal.removeEventListener("abort", onAbort);
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onAbort = () => {
      removeListeners();
      rejectListen(signal.reason);
    };
    const onError = (error: Error) => {
      removeListeners();
      rejectListen(error);
    };
    const onListening = () => {
      removeListeners();
      resolveListen();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      exclusive: true,
      host: LOCK_HOST,
      port,
      signal,
    });
  });

const closeServer = (
  server: Server,
  sockets: ReadonlySet<Socket>
): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
        return;
      }
      rejectClose(error);
    });
  });

const settleWithin = (
  promise: Promise<unknown>,
  milliseconds: number
): Promise<void> =>
  new Promise((resolveBounded) => {
    const timer = setTimeout(resolveBounded, milliseconds);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolveBounded();
      },
      () => {
        clearTimeout(timer);
        resolveBounded();
      }
    );
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

class RunnerLockAttempt {
  readonly boundary: RunnerLockAcquisitionBoundary;
  readonly controller = new AbortController();
  readonly files = new Set<FileHandle>();
  readonly temporaryPaths = new Set<string>();
  readonly operations = new Set<Promise<unknown>>();
  heldLock: HeldRunnerLock | null = null;
  marker: { readonly identity: FileIdentity; readonly path: string } | null =
    null;
  readonly server: Server;
  readonly sockets = new Set<Socket>();

  constructor(boundary: RunnerLockAcquisitionBoundary) {
    this.boundary = boundary;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.end();
    });
  }

  abort(): void {
    this.controller.abort();
  }

  assertActive(): void {
    if (this.controller.signal.aborted) {
      throw this.controller.signal.reason;
    }
  }

  async cleanupPending(): Promise<void> {
    this.abort();
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled([
      ...[...this.files].map(closeFile),
      ...[...this.temporaryPaths].map((temporaryPath) =>
        rm(temporaryPath, { force: true })
      ),
      ...(this.marker === null ? [] : [removeOwnedMarker(this.marker)]),
    ]);
    await settleWithin(
      closeServer(this.server, this.sockets),
      PENDING_CLEANUP_BOUND_MILLIS
    );
  }

  track<A>(operation: Promise<A>): Promise<A> {
    this.operations.add(operation);
    operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    );
    return operation;
  }

  release(): Promise<void> {
    const heldLock = this.heldLock;
    this.heldLock = null;
    return heldLock === null
      ? this.cleanupPending()
      : releaseLockPromise(heldLock, this.boundary);
  }
}

const removeOwnedMarker = async (marker: {
  readonly identity: FileIdentity;
  readonly path: string;
}): Promise<void> => {
  try {
    const currentIdentity = await markerIdentity(marker.path);
    if (sameIdentity(marker.identity, currentIdentity)) {
      await unlink(marker.path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
};

const writeMarker = async (
  attempt: RunnerLockAttempt,
  boundary: RunnerLockAcquisitionBoundary,
  runtimeRoot: string,
  path: string,
  port: number
): Promise<FileIdentity> => {
  await assertSafeFilePath({
    anchor: runtimeRoot,
    operation: "runner-lock",
    path,
  });
  attempt.assertActive();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  attempt.temporaryPaths.add(temporaryPath);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    attempt.files.add(file);
    try {
      attempt.assertActive();
      await boundary.afterTemporaryFileOpened?.(attempt.controller.signal);
      attempt.assertActive();
      const rootIdentity = createHash("sha256")
        .update(runtimeRoot)
        .digest("hex");
      await file.writeFile(
        JSON.stringify({ port, rootIdentity, version: 1 }),
        "utf8"
      );
      await file.sync();
      attempt.assertActive();
    } finally {
      await closeFile(file);
      attempt.files.delete(file);
    }
    const identity = await markerIdentity(temporaryPath);
    attempt.marker = { identity, path };
    await assertSafeFilePath({
      anchor: runtimeRoot,
      operation: "runner-lock",
      path,
    });
    attempt.assertActive();
    await rename(temporaryPath, path);
    attempt.temporaryPaths.delete(temporaryPath);
    attempt.assertActive();
    const directory = await open(dirname(path), "r");
    attempt.files.add(directory);
    try {
      await directory.sync();
      attempt.assertActive();
    } finally {
      await closeFile(directory);
      attempt.files.delete(directory);
    }
    return identity;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    attempt.temporaryPaths.delete(temporaryPath);
    if (attempt.marker !== null) {
      await removeOwnedMarker(attempt.marker);
      attempt.marker = null;
    }
    throw error;
  }
};

const acquireLock = (
  attempt: RunnerLockAttempt,
  runtimeRoot: string,
  path: string,
  boundary: RunnerLockAcquisitionBoundary
): Effect.Effect<void, RunnerLockError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        assertSafeFilePath({
          anchor: runtimeRoot,
          operation: "runner-lock",
          path,
        }),
      catch: (error) =>
        error instanceof RunnerLockError
          ? error
          : lockFailure("acquire-failed"),
    });
    const port = lockPortFor(runtimeRoot);
    yield* Effect.tryPromise({
      try: (signal) => {
        const abortAttempt = () => attempt.abort();
        signal.addEventListener("abort", abortAttempt, { once: true });
        return attempt
          .track(listenOnPort(port, attempt.controller.signal, attempt.server))
          .finally(() => signal.removeEventListener("abort", abortAttempt));
      },
      catch: (error) =>
        errorCode(error) === "EADDRINUSE"
          ? lockFailure("already-held")
          : lockFailure("acquire-failed"),
    });
    yield* boundary.afterServerStarted ?? Effect.void;
    const identity = yield* Effect.tryPromise({
      try: (signal) => {
        const abortAttempt = () => attempt.abort();
        signal.addEventListener("abort", abortAttempt, { once: true });
        return attempt
          .track(writeMarker(attempt, boundary, runtimeRoot, path, port))
          .finally(() => signal.removeEventListener("abort", abortAttempt));
      },
      catch: (error) =>
        error instanceof RunnerLockError
          ? error
          : lockFailure("acquire-failed"),
    });
    attempt.assertActive();
    attempt.heldLock = {
      identity,
      path,
      server: attempt.server,
      sockets: attempt.sockets,
    };
  });

const releaseLockPromise = async (
  lock: HeldRunnerLock,
  boundary: RunnerLockAcquisitionBoundary
): Promise<void> => {
  try {
    await removeOwnedMarker(lock);
    await boundary.afterOwnedMarkerRemoved?.();
  } finally {
    await closeServer(lock.server, lock.sockets);
  }
};

export const makeRunnerLockAcquirer = (
  boundary: RunnerLockAcquisitionBoundary = {}
): RunnerLockAcquirer =>
  Effect.fn("acquireRunnerLock")(function* (runtimeRoot, path) {
    const attempt = yield* Effect.acquireRelease(
      Effect.sync(() => new RunnerLockAttempt(boundary)),
      (currentAttempt) =>
        Effect.tryPromise({
          try: () => currentAttempt.release(),
          catch: () => lockFailure("release-failed"),
        }).pipe(Effect.orDie)
    );
    yield* acquireLock(attempt, runtimeRoot, path, boundary).pipe(
      Effect.timeout(boundary.acquisitionTimeout ?? LOCK_ACQUISITION_TIMEOUT),
      Effect.mapError((error) =>
        error instanceof RunnerLockError
          ? error
          : lockFailure("acquire-timeout")
      )
    );
  });

export const acquireRunnerLock: RunnerLockAcquirer = makeRunnerLockAcquirer();
