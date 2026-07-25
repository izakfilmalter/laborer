import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  McpServerStdio,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Effect,
  Array as EffectArray,
  Option,
  Schema,
  Semaphore,
} from "effect";
import { z } from "zod";
import {
  assertSafeFilePath,
  ensureOwnerOnlyDirectoryTree,
  openRegularFileNoFollowNonBlocking,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";
import {
  type AcpAgentContextSources,
  isSlackTeamId,
  isSlackUserId,
  prepareAcpAgentContextSources,
  USER_PROFILE_CHARACTER_LIMIT,
  userProfilePath,
  verifyAcpAgentContextSources,
  WORKSPACE_MEMORY_CHARACTER_LIMIT,
} from "./agent-context.ts";
import {
  containsMemoryEntryFrameDelimiter,
  framedMemoryEntries,
  renderFramedMemoryEntry,
  stripMemoryEntryFraming,
} from "./memory-framing.ts";

export const LABORER_MEMORY_MCP_SERVER_NAME = "laborer-memory";
export const LABORER_MEMORY_MCP_TOOL_NAME = "memory";
const LABORER_MEMORY_SERVER_NAME_ENV = "LABORER_MEMORY_SERVER_NAME";
const LABORER_MEMORY_REGISTRATION_NONCE_ENV =
  "LABORER_MEMORY_REGISTRATION_NONCE";
const LABORER_MEMORY_READY_PATH_ENV = "LABORER_MEMORY_READY_PATH";
const LABORER_MEMORY_AUTHORITY_GUARD_ENV = "LABORER_MEMORY_AUTHORITY_GUARD";

const MEMORY_SERVER_PATH = fileURLToPath(
  new URL("./memory-mcp-server.ts", import.meta.url)
);
// Canonical framing adds fixed metadata per entry. This cap accommodates the
// worst valid 4,000-character state when every four-byte code point is stored
// as its own framed entry, while still bounding operator-controlled reads.
const MAX_MEMORY_SOURCE_BYTES = 512 * 1024;
const MAX_MEMORY_DIAGNOSTIC_BYTES = 4096;
const MEMORY_MCP_READINESS_WAIT_MILLIS = 5000;
const MEMORY_MCP_READINESS_POLL_MILLIS = 20;
const MUTATION_LOCK_RETRY_MILLIS = 25;
const MUTATION_LOCK_MAX_RETRY_MILLIS = 2000;
const MUTATION_LOCK_WAIT_MILLIS = 30_000;
const MAX_TEST_CRITICAL_SECTION_DELAY_MILLIS = 7000;
const MEMORY_ENTRY_SEPARATOR = "\n\n";
const MUTATION_LOCK_DATABASE_SUFFIX = ".lock.sqlite";
const MEMORY_MCP_READINESS_FILE_NAME = "memory-mcp-readiness";
const MEMORY_REGISTRATION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MEMORY_AUTHORITY_GUARD_PATTERN = /^[0-9a-f]{64}$/;
const MAX_OBSERVED_MEMORY_TOOL_CALLS = 64;
const MEMORY_DIAGNOSTIC_LINE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (?:startup-failed|mutation-[a-z-]+|registration-[a-z-]+)$/;
const BLANK_LINE_BEFORE_PATTERN = /(?:\r?\n)[\t ]*(?:\r?\n)$/;
const BLANK_LINE_AFTER_PATTERN = /^(?:\r?\n)[\t ]*(?:\r?\n)/;

const MemoryOperation = Schema.Literals(["add", "remove", "replace"]);
type MemoryOperation = typeof MemoryOperation.Type;
const MemoryTarget = Schema.Literals(["user", "workspace"]);
type MemoryTarget = typeof MemoryTarget.Type;

export interface MemoryMutation {
  readonly operation: MemoryOperation;
  readonly replacement?: string | undefined;
  readonly target: MemoryTarget;
  readonly text: string;
  readonly userId?: string | undefined;
}

export interface MemoryMutationResult {
  readonly changed: boolean;
  readonly renderedCharacters: number;
  readonly target: MemoryTarget;
}

export class MemoryMutationError extends Schema.TaggedErrorClass<MemoryMutationError>()(
  "MemoryMutationError",
  {
    reason: Schema.Literals([
      "ambiguous-match",
      "cancelled",
      "invalid-input",
      "invalid-source",
      "limit-exceeded",
      "source-oversized",
      "storage-unavailable",
    ]),
  }
) {}

export interface LaborerMemoryStore {
  readonly mutate: (
    mutation: MemoryMutation,
    signal?: AbortSignal
  ) => Effect.Effect<MemoryMutationResult, MemoryMutationError>;
}

const mutationFailure = (
  reason: MemoryMutationError["reason"]
): MemoryMutationError => MemoryMutationError.make({ reason });

const errorCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

const assertNotCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) {
    throw mutationFailure("cancelled");
  }
};

const cancellableDelay = (
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> =>
  new Promise((resolveDelay, rejectDelay) => {
    try {
      assertNotCancelled(signal);
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
      rejectDelay(mutationFailure("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

interface HeldMutationLock {
  readonly assertCanCommit: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly canonicalTargetPath: string;
  readonly database: DatabaseSync;
}

interface LockDatabaseIdentity {
  readonly device: bigint | number;
  readonly inode: bigint | number;
}

const canonicalTargetPath = async (targetPath: string): Promise<string> =>
  resolve(await realpath(dirname(targetPath)), basename(targetPath));

const mutationLockDatabasePath = (canonicalPath: string): string =>
  `${canonicalPath}${MUTATION_LOCK_DATABASE_SUFFIX}`;

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

const ensureOwnerOnlyLockDatabase = async (
  canonicalPath: string
): Promise<{
  readonly identity: LockDatabaseIdentity;
  readonly path: string;
}> => {
  const lockDatabasePath = mutationLockDatabasePath(canonicalPath);
  await assertSafeFilePath({
    anchor: dirname(canonicalPath),
    operation: "prepare-memory-mutation-lock",
    path: lockDatabasePath,
  });
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    metadata = await lstat(lockDatabasePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw mutationFailure("storage-unavailable");
    }
  }
  if (metadata === undefined) {
    const temporaryPath = `${lockDatabasePath}.${randomUUID()}.tmp`;
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
        await link(temporaryPath, lockDatabasePath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    } catch {
      throw mutationFailure("storage-unavailable");
    } finally {
      temporaryDatabase?.close();
      await rm(temporaryPath, { force: true });
    }
    metadata = await lstat(lockDatabasePath);
  }
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== undefined && metadata.uid !== currentUserId)
  ) {
    throw mutationFailure("storage-unavailable");
  }
  return {
    identity: { device: metadata.dev, inode: metadata.ino },
    path: lockDatabasePath,
  };
};

const hardenLockDatabaseFile = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== undefined && metadata.uid !== currentUserId)
  ) {
    throw mutationFailure("storage-unavailable");
  }
  try {
    await chmod(path, 0o600);
  } catch {
    throw mutationFailure("storage-unavailable");
  }
};

const verifyLockDatabaseIdentity = async (
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
    throw mutationFailure("storage-unavailable");
  }
};

const acquireMutationLock = async (
  targetPath: string,
  signal?: AbortSignal
): Promise<HeldMutationLock> => {
  const canonicalPath = await canonicalTargetPath(targetPath);
  const lockDatabase = await ensureOwnerOnlyLockDatabase(canonicalPath);
  const database = new DatabaseSync(lockDatabase.path, {
    defensive: true,
    timeout: 0,
  });
  try {
    await hardenLockDatabaseFile(lockDatabase.path);
    database.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + MUTATION_LOCK_WAIT_MILLIS;
    let retryMillis = MUTATION_LOCK_RETRY_MILLIS;
    while (Date.now() < deadline) {
      assertNotCancelled(signal);
      try {
        database.exec("BEGIN IMMEDIATE");
        await verifyLockDatabaseIdentity(
          lockDatabase.path,
          lockDatabase.identity
        );
        const assertOwned = async (): Promise<void> => {
          if (!database.isTransaction) {
            throw mutationFailure("storage-unavailable");
          }
          await verifyLockDatabaseIdentity(
            lockDatabase.path,
            lockDatabase.identity
          );
        };
        return {
          assertCanCommit: async () => {
            assertNotCancelled(signal);
            await assertOwned();
          },
          assertOwned,
          canonicalTargetPath: canonicalPath,
          database,
        };
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
        signal
      );
      retryMillis = Math.min(
        MUTATION_LOCK_MAX_RETRY_MILLIS,
        Math.ceil(retryMillis * 1.5)
      );
    }
    throw mutationFailure("storage-unavailable");
  } catch (error) {
    database.close();
    throw error instanceof MemoryMutationError
      ? error
      : mutationFailure("storage-unavailable");
  }
};

const withCrossProcessMutationLock = async <A>(
  targetPath: string,
  signal: AbortSignal | undefined,
  operation: (lock: HeldMutationLock) => Promise<A>
): Promise<A> => {
  const heldLock = await acquireMutationLock(targetPath, signal);
  try {
    await heldLock.assertCanCommit();
    const result = await operation(heldLock);
    await heldLock.assertOwned();
    // SQLite stores no memory data here. ROLLBACK is the contention-safe
    // transaction release: COMMIT may need an exclusive-lock upgrade and can
    // starve behind simultaneous nonblocking BEGIN attempts.
    heldLock.database.exec("ROLLBACK");
    return result;
  } catch (error) {
    if (heldLock.database.isTransaction) {
      try {
        heldLock.database.exec("ROLLBACK");
      } catch {
        // The original mutation failure remains the actionable result.
      }
    }
    throw error;
  } finally {
    heldLock.database.close();
  }
};

const testCriticalSectionDelayMillis = (): number => {
  const configured = Number.parseInt(
    process.env.LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS ?? "0",
    10
  );
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return 0;
  }
  return Math.min(configured, MAX_TEST_CRITICAL_SECTION_DELAY_MILLIS);
};

const escapedRenderedCharacterCount = (value: string): number => {
  let count = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const valid =
      codePoint !== undefined &&
      (codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
        (codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
        (codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff));
    if (!valid) {
      throw mutationFailure("invalid-source");
    }
    if (character === "&") {
      count += 5;
    } else if (character === "<" || character === ">") {
      count += 4;
    } else {
      count += 1;
    }
  }
  return count;
};

const exactMatchIndexes = (source: string, text: string): readonly number[] => {
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= source.length - text.length) {
    const index = source.indexOf(text, fromIndex);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    fromIndex = index + 1;
  }
  return indexes;
};

const visibleMatchIndexes = (
  source: string,
  text: string
): readonly number[] => {
  const entries = framedMemoryEntries(source);
  return exactMatchIndexes(source, text).filter((index) => {
    const end = index + text.length;
    return entries.every(
      ({ contentEnd, contentStart, frameEnd, frameStart }) => {
        const overlapsFrame = index < frameEnd && end > frameStart;
        const isInsideVisibleContent =
          index >= contentStart && end <= contentEnd;
        return !overlapsFrame || isInsideVisibleContent;
      }
    );
  });
};

const hasExactAddedEntry = (source: string, candidate: string): boolean => {
  const framedEntries = framedMemoryEntries(source);
  if (framedEntries.some(({ content }) => content === candidate)) {
    return true;
  }
  return exactMatchIndexes(source, candidate).some((index) => {
    const end = index + candidate.length;
    const overlapsFramedEntry = framedEntries.some(
      ({ frameEnd, frameStart }) => index < frameEnd && end > frameStart
    );
    if (overlapsFramedEntry) {
      return false;
    }
    // Unframed operator Markdown is exact-deduped only as the whole file or as
    // one or more complete blank-line-delimited blocks. The candidate itself
    // is never normalized, so CRLF and whitespace differences stay distinct.
    const startsAtBlockBoundary =
      index === 0 || BLANK_LINE_BEFORE_PATTERN.test(source.slice(0, index));
    const endsAtBlockBoundary =
      end === source.length || BLANK_LINE_AFTER_PATTERN.test(source.slice(end));
    return startsAtBlockBoundary && endsAtBlockBoundary;
  });
};

const additionSeparator = (source: string): string => {
  if (source.length === 0) {
    return "";
  }
  return MEMORY_ENTRY_SEPARATOR;
};

const applyMutation = (
  source: string,
  mutation: MemoryMutation
): { readonly changed: boolean; readonly content: string } => {
  if (mutation.operation === "add") {
    if (hasExactAddedEntry(source, mutation.text)) {
      return { changed: false, content: source };
    }
    const separator = additionSeparator(source);
    return {
      changed: true,
      content: `${source}${separator}${renderFramedMemoryEntry(mutation.text)}`,
    };
  }
  // Framing is storage metadata, not model-visible memory. A replace/remove
  // may target operator Markdown or framed entry content, but never a marker
  // or a range crossing a marker boundary.
  const matches = visibleMatchIndexes(source, mutation.text);
  if (matches.length !== 1) {
    throw mutationFailure("ambiguous-match");
  }
  const index = matches[0];
  if (index === undefined) {
    throw mutationFailure("ambiguous-match");
  }
  const replacement =
    mutation.operation === "replace" ? mutation.replacement : "";
  if (replacement === undefined) {
    throw mutationFailure("invalid-input");
  }
  if (mutation.operation === "remove") {
    const framedEntry = framedMemoryEntries(source).find(
      ({ contentEnd, contentStart }) =>
        contentStart === index && contentEnd === index + mutation.text.length
    );
    if (framedEntry !== undefined) {
      let removalStart = framedEntry.frameStart;
      let removalEnd = framedEntry.frameEnd;
      if (
        removalStart >= MEMORY_ENTRY_SEPARATOR.length &&
        source.slice(
          removalStart - MEMORY_ENTRY_SEPARATOR.length,
          removalStart
        ) === MEMORY_ENTRY_SEPARATOR
      ) {
        removalStart -= MEMORY_ENTRY_SEPARATOR.length;
      } else if (
        source.slice(removalEnd, removalEnd + MEMORY_ENTRY_SEPARATOR.length) ===
        MEMORY_ENTRY_SEPARATOR
      ) {
        removalEnd += MEMORY_ENTRY_SEPARATOR.length;
      }
      return {
        changed: true,
        content: `${source.slice(0, removalStart)}${source.slice(removalEnd)}`,
      };
    }
  }
  return {
    changed: replacement !== mutation.text,
    content: `${source.slice(0, index)}${replacement}${source.slice(index + mutation.text.length)}`,
  };
};

const readLatestSource = async (path: string): Promise<string> => {
  let file:
    | Awaited<ReturnType<typeof openRegularFileNoFollowNonBlocking>>
    | undefined;
  try {
    file = await openRegularFileNoFollowNonBlocking(
      path,
      "mutate-agent-memory"
    );
    const metadata = await file.stat();
    if (metadata.size > MAX_MEMORY_SOURCE_BYTES) {
      throw mutationFailure("source-oversized");
    }
    const source = await file.readFile();
    if (source.byteLength > MAX_MEMORY_SOURCE_BYTES) {
      throw mutationFailure("source-oversized");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    if (error instanceof MemoryMutationError) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    if (error instanceof TypeError) {
      throw mutationFailure("invalid-source");
    }
    throw mutationFailure("storage-unavailable");
  } finally {
    await file?.close();
  }
};

const publishAtomically = async (options: {
  readonly anchor: string;
  readonly assertCanCommit?: (() => void | Promise<void>) | undefined;
  readonly content: string;
  readonly path: string;
}): Promise<void> => {
  const directory = await retainTrustedDirectory(
    dirname(options.path),
    "mutate-agent-memory"
  );
  const temporaryPath = `${options.path}.${randomUUID()}.tmp`;
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertSafeFilePath({
      anchor: options.anchor,
      operation: "mutate-agent-memory",
      path: options.path,
    });
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(options.content, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await verifyRetainedDirectory(directory, "mutate-agent-memory");
    await options.assertCanCommit?.();
    await rename(temporaryPath, options.path);
    await verifyRetainedDirectory(directory, "mutate-agent-memory");
    await directory.handle.sync();
  } finally {
    await temporaryFile?.close();
    await rm(temporaryPath, { force: true });
    await directory.handle.close();
  }
};

export type LaborerMemoryDiagnosticCode =
  | "startup-failed"
  | "registration-collision"
  | "registration-invalid"
  | "registration-missing"
  | `mutation-${MemoryMutationError["reason"]}`;

const boundedDiagnosticContent = (
  source: string,
  code: LaborerMemoryDiagnosticCode
): string => {
  const lines = source
    .split("\n")
    .filter((line) => MEMORY_DIAGNOSTIC_LINE_PATTERN.test(line));
  lines.push(`${new Date().toISOString()} ${code}`);
  while (
    lines.length > 1 &&
    new TextEncoder().encode(`${lines.join("\n")}\n`).byteLength >
      MAX_MEMORY_DIAGNOSTIC_BYTES
  ) {
    lines.shift();
  }
  return `${lines.join("\n")}\n`;
};

const writeLaborerMemoryDiagnostic = async (
  sources: AcpAgentContextSources,
  code: LaborerMemoryDiagnosticCode
): Promise<void> => {
  await verifyAcpAgentContextSources(sources, "record-memory-diagnostic");
  const canonicalWorkspaceDirectory = await realpath(
    sources.workspaceDirectory
  );
  await withCrossProcessMutationLock(
    sources.memoryDiagnosticsPath,
    undefined,
    async (heldLock) => {
      let current = "";
      try {
        current = await readLatestSource(heldLock.canonicalTargetPath);
      } catch {
        // An invalid or manually oversized sink is replaced with bounded data.
      }
      await heldLock.assertCanCommit();
      await publishAtomically({
        anchor: canonicalWorkspaceDirectory,
        assertCanCommit: heldLock.assertCanCommit,
        content: boundedDiagnosticContent(current, code),
        path: heldLock.canonicalTargetPath,
      });
    }
  );
};

export const recordLaborerMemoryDiagnostic = Effect.fn(
  "recordLaborerMemoryDiagnostic"
)(function* (options: {
  readonly authorityGuard?: string;
  readonly code: LaborerMemoryDiagnosticCode;
  readonly root: string;
  readonly workspaceId: string;
}) {
  const sources = yield* prepareAcpAgentContextSources(options);
  if (
    options.authorityGuard !== undefined &&
    options.authorityGuard !== laborerMemoryAuthorityGuard(sources)
  ) {
    return;
  }
  yield* Effect.tryPromise({
    try: () => writeLaborerMemoryDiagnostic(sources, options.code),
    catch: () => mutationFailure("storage-unavailable"),
  }).pipe(Effect.ignore);
});

export const recordLaborerMemoryDiagnosticForSources = Effect.fn(
  "recordLaborerMemoryDiagnosticForSources"
)(function* (options: {
  readonly code: LaborerMemoryDiagnosticCode;
  readonly sources: AcpAgentContextSources;
}) {
  yield* Effect.tryPromise({
    try: () => writeLaborerMemoryDiagnostic(options.sources, options.code),
    catch: () => mutationFailure("storage-unavailable"),
  }).pipe(Effect.ignore);
});

const targetDetails = (
  sources: AcpAgentContextSources,
  mutation: MemoryMutation
): {
  readonly characterLimit: number;
  readonly path: string;
} => {
  if (mutation.target === "workspace") {
    if (mutation.userId !== undefined) {
      throw mutationFailure("invalid-input");
    }
    return {
      characterLimit: WORKSPACE_MEMORY_CHARACTER_LIMIT,
      path: sources.workspaceMemoryPath,
    };
  }
  if (mutation.userId === undefined || !isSlackUserId(mutation.userId)) {
    throw mutationFailure("invalid-input");
  }
  return {
    characterLimit: USER_PROFILE_CHARACTER_LIMIT,
    path: userProfilePath(sources, mutation.userId),
  };
};

const validateMutation = (mutation: MemoryMutation): void => {
  if (
    mutation.text.trim().length === 0 ||
    (mutation.operation === "replace" &&
      mutation.replacement?.trim().length === 0) ||
    containsMemoryEntryFrameDelimiter(mutation.text) ||
    (mutation.replacement !== undefined &&
      containsMemoryEntryFrameDelimiter(mutation.replacement))
  ) {
    throw mutationFailure("invalid-input");
  }
  const hasReplacement = mutation.replacement !== undefined;
  if (
    (mutation.operation === "replace" && !hasReplacement) ||
    (mutation.operation !== "replace" && hasReplacement)
  ) {
    throw mutationFailure("invalid-input");
  }
};

export const makeLaborerMemoryStore = Effect.fn("makeLaborerMemoryStore")(
  function* (options: {
    readonly root: string;
    readonly workspaceId: string;
  }): Effect.fn.Return<LaborerMemoryStore> {
    const sources = yield* prepareAcpAgentContextSources(options);
    const processMutationGate = yield* Semaphore.make(1);

    const mutate = Effect.fn("LaborerMemoryStore.mutate")(function* (
      mutation: MemoryMutation,
      signal?: AbortSignal
    ) {
      yield* Effect.try({
        try: () => validateMutation(mutation),
        catch: (error) =>
          error instanceof MemoryMutationError
            ? error
            : mutationFailure("invalid-input"),
      });
      const details = yield* Effect.try({
        try: () => targetDetails(sources, mutation),
        catch: (error) =>
          error instanceof MemoryMutationError
            ? error
            : mutationFailure("invalid-input"),
      });
      return yield* Effect.tryPromise({
        try: async () => {
          assertNotCancelled(signal);
          await verifyAcpAgentContextSources(sources, "mutate-agent-memory");
          if (mutation.target === "user") {
            await ensureOwnerOnlyDirectoryTree({
              anchor: sources.workspaceDirectory,
              operation: "prepare-user-profile-directory",
              target: sources.userProfilesDirectory,
            });
          }
          const canonicalWorkspaceDirectory = await realpath(
            sources.workspaceDirectory
          );
          return withCrossProcessMutationLock(
            details.path,
            signal,
            async (heldLock) => {
              const assertCanCommit = async (): Promise<void> => {
                await heldLock.assertCanCommit();
                await verifyAcpAgentContextSources(
                  sources,
                  "mutate-agent-memory"
                );
              };
              await assertCanCommit();
              const current = await readLatestSource(
                heldLock.canonicalTargetPath
              );
              const configuredDelay = testCriticalSectionDelayMillis();
              if (configuredDelay > 0) {
                await cancellableDelay(configuredDelay, signal);
              }
              await assertCanCommit();
              const currentCharacters = escapedRenderedCharacterCount(
                stripMemoryEntryFraming(current)
              );
              if (currentCharacters > details.characterLimit) {
                throw mutationFailure("source-oversized");
              }
              const next = applyMutation(current, mutation);
              const renderedCharacters = escapedRenderedCharacterCount(
                stripMemoryEntryFraming(next.content)
              );
              if (renderedCharacters > details.characterLimit) {
                throw mutationFailure("limit-exceeded");
              }
              if (next.changed) {
                await assertCanCommit();
                await publishAtomically({
                  anchor: canonicalWorkspaceDirectory,
                  assertCanCommit,
                  content: next.content,
                  path: heldLock.canonicalTargetPath,
                });
              }
              return {
                changed: next.changed,
                renderedCharacters,
                target: mutation.target,
              };
            }
          );
        },
        catch: (error) =>
          error instanceof MemoryMutationError
            ? error
            : mutationFailure("storage-unavailable"),
      });
    });

    return {
      mutate: (mutation, signal) =>
        processMutationGate.withPermit(mutate(mutation, signal)),
    };
  }
);

const diagnostic = (reason: string): void => {
  const boundedReason = EffectArray.fromIterable(reason).slice(0, 80).join("");
  process.stderr.write(`[laborer-memory] mutation failed: ${boundedReason}\n`);
};

const errorText = (reason: MemoryMutationError["reason"]): string => {
  switch (reason) {
    case "ambiguous-match":
      return "Memory mutation requires exactly one matching text occurrence.";
    case "cancelled":
      return "Memory mutation was cancelled.";
    case "limit-exceeded":
      return "Memory mutation would exceed the target character limit.";
    case "source-oversized":
      return "Memory target is already oversized and must be reduced locally.";
    case "invalid-input":
      return "Memory mutation input is invalid.";
    case "invalid-source":
      return "Memory target is not valid text.";
    case "storage-unavailable":
      return "Memory storage is unavailable.";
    default:
      return "Memory mutation failed.";
  }
};

export const makeLaborerMemoryMcpServer = Effect.fn(
  "makeLaborerMemoryMcpServer"
)(function* (options: {
  readonly authorityGuard?: string;
  readonly root: string;
  readonly serverName?: string;
  readonly workspaceId: string;
}) {
  const diagnosticSources = yield* prepareAcpAgentContextSources(options);
  if (
    options.authorityGuard !== undefined &&
    options.authorityGuard !== laborerMemoryAuthorityGuard(diagnosticSources)
  ) {
    return yield* mutationFailure("storage-unavailable");
  }
  const store = yield* makeLaborerMemoryStore(options);
  const runMutation = Effect.runPromiseWith(yield* Effect.context<never>());
  const server = new McpServer({
    name: options.serverName ?? laborerMemoryServerName(options),
    version: "1.0.0",
  });
  server.registerTool(
    LABORER_MEMORY_MCP_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Add, replace, or remove one piece of Workspace memory or one Slack User profile. Retain durable information likely to improve future workspace collaboration. Keep routine maintenance acknowledgements, tool results, and diagnostics private; still answer substantively when a user explicitly asks about remembered information.",
      inputSchema: {
        operation: z.enum(["add", "replace", "remove"]),
        replacement: z.string().optional(),
        target: z.enum(["workspace", "user"]),
        text: z.string(),
        userId: z.string().optional(),
      },
      title: "Maintain Laborer memory",
    },
    async (mutation, { signal }) => {
      const result = await runMutation(
        Effect.result(store.mutate(mutation, signal))
      );
      if (result._tag === "Failure") {
        const reason =
          result.failure instanceof MemoryMutationError
            ? result.failure.reason
            : "storage-unavailable";
        diagnostic(reason);
        if (reason !== "cancelled") {
          await runMutation(
            recordLaborerMemoryDiagnosticForSources({
              code: `mutation-${reason}`,
              sources: diagnosticSources,
            })
          );
        }
        return {
          content: [{ text: errorText(reason), type: "text" }],
          isError: true,
        };
      }
      return {
        content: [
          {
            text: result.success.changed
              ? `Memory updated (${result.success.renderedCharacters} rendered characters).`
              : `Memory was already in the requested state (${result.success.renderedCharacters} rendered characters).`,
            type: "text",
          },
        ],
      };
    }
  );
  return server;
});

const laborerMemoryServerName = (options: {
  readonly root: string;
  readonly workspaceId: string;
}): string => {
  const authority = createHash("sha256")
    .update(options.root)
    .update("\0")
    .update(options.workspaceId)
    .digest("hex")
    .slice(0, 16);
  return `${LABORER_MEMORY_MCP_SERVER_NAME}-${authority}`;
};

const laborerMemoryAuthorityGuard = (sources: AcpAgentContextSources): string =>
  createHash("sha256")
    .update(sources.root)
    .update("\0")
    .update(String(sources.rootDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.rootDirectoryIdentity.inode))
    .update("\0")
    .update(sources.workspaceDirectory)
    .update("\0")
    .update(String(sources.workspaceDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.workspaceDirectoryIdentity.inode))
    .digest("hex");

const serverEnvironmentValue = (
  server: McpServerStdio,
  name: string
): string | undefined => {
  const matches = server.env.filter((entry) => entry.name === name);
  return matches.length === 1 ? matches[0]?.value : undefined;
};

export interface LaborerMemoryMcpAuthority {
  readonly root: string;
  readonly workspaceId: string;
}

export const laborerMemoryMcpAuthority = (
  server: McpServerStdio
): LaborerMemoryMcpAuthority | null => {
  const root = serverEnvironmentValue(server, "LABORER_MEMORY_ROOT");
  const workspaceId = serverEnvironmentValue(
    server,
    "LABORER_MEMORY_WORKSPACE_ID"
  );
  return root === undefined ||
    workspaceId === undefined ||
    !isSlackTeamId(workspaceId)
    ? null
    : { root, workspaceId };
};

export const laborerMemoryOpenCodePermission = (serverName: string): string =>
  `${serverName}_${LABORER_MEMORY_MCP_TOOL_NAME}`;

export const makeLaborerMemoryMcpServerConfiguration = (
  sources: AcpAgentContextSources
): McpServerStdio => {
  if (!isSlackTeamId(sources.workspaceId)) {
    throw new Error("Invalid authenticated Slack workspace ID");
  }
  const name = laborerMemoryServerName(sources);
  return {
    args: [MEMORY_SERVER_PATH],
    command: process.execPath,
    env: [
      { name: "LABORER_MEMORY_ROOT", value: sources.root },
      { name: "LABORER_MEMORY_WORKSPACE_ID", value: sources.workspaceId },
      { name: LABORER_MEMORY_SERVER_NAME_ENV, value: name },
      {
        name: LABORER_MEMORY_AUTHORITY_GUARD_ENV,
        value: laborerMemoryAuthorityGuard(sources),
      },
    ],
    name,
  };
};

export const isLaborerMemoryMcpServerConfiguration = (
  server: McpServerStdio,
  root: string
): boolean => {
  if (
    server.command !== process.execPath ||
    server.args.length !== 1 ||
    server.args[0] !== MEMORY_SERVER_PATH ||
    server.env.length !== 4
  ) {
    return false;
  }
  const configuredRoot = Option.getOrUndefined(
    EffectArray.findFirst(
      server.env,
      ({ name }) => name === "LABORER_MEMORY_ROOT"
    )
  )?.value;
  const workspaceId = Option.getOrUndefined(
    EffectArray.findFirst(
      server.env,
      ({ name }) => name === "LABORER_MEMORY_WORKSPACE_ID"
    )
  )?.value;
  const serverName = serverEnvironmentValue(
    server,
    LABORER_MEMORY_SERVER_NAME_ENV
  );
  const authorityGuard = serverEnvironmentValue(
    server,
    LABORER_MEMORY_AUTHORITY_GUARD_ENV
  );
  if (configuredRoot === undefined || workspaceId === undefined) {
    return false;
  }
  return (
    configuredRoot === root &&
    workspaceId !== undefined &&
    isSlackTeamId(workspaceId) &&
    serverName ===
      laborerMemoryServerName({ root: configuredRoot, workspaceId }) &&
    authorityGuard !== undefined &&
    MEMORY_AUTHORITY_GUARD_PATTERN.test(authorityGuard) &&
    server.name === serverName
  );
};

export class LaborerMemoryRegistrationError extends Schema.TaggedErrorClass<LaborerMemoryRegistrationError>()(
  "LaborerMemoryRegistrationError",
  {
    reason: Schema.Literals(["collision", "invalid", "missing"]),
  }
) {}

export interface PreparedLaborerMemoryMcpRegistration {
  readonly authority: LaborerMemoryMcpAuthority;
  readonly permission: string;
  readonly readinessNonce: string;
  readonly readinessPath: string;
  readonly server: McpServerStdio;
}

const registrationName = (
  authority: LaborerMemoryMcpAuthority,
  token: string
): string => `${laborerMemoryServerName(authority)}-${token}`;

const registrationTokenFromName = (
  authority: LaborerMemoryMcpAuthority,
  name: string
): string | null => {
  const prefix = `${laborerMemoryServerName(authority)}-`;
  const token = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return MEMORY_REGISTRATION_TOKEN_PATTERN.test(token) ? token : null;
};

const registrationFailure = (
  reason: LaborerMemoryRegistrationError["reason"]
): LaborerMemoryRegistrationError =>
  LaborerMemoryRegistrationError.make({ reason });

export const prepareLaborerMemoryMcpRegistration = Effect.fn(
  "prepareLaborerMemoryMcpRegistration"
)(function* (
  server: McpServerStdio,
  trustedRoot: string
): Effect.fn.Return<
  PreparedLaborerMemoryMcpRegistration,
  LaborerMemoryRegistrationError
> {
  if (!isLaborerMemoryMcpServerConfiguration(server, trustedRoot)) {
    return yield* registrationFailure("invalid");
  }
  const authority = laborerMemoryMcpAuthority(server);
  if (authority === null) {
    return yield* registrationFailure("invalid");
  }
  const sources = yield* prepareAcpAgentContextSources(authority);
  if (
    serverEnvironmentValue(server, LABORER_MEMORY_AUTHORITY_GUARD_ENV) !==
    laborerMemoryAuthorityGuard(sources)
  ) {
    return yield* registrationFailure("invalid");
  }
  const registrationToken = randomUUID().replaceAll("-", "");
  const name = registrationName(authority, registrationToken);
  const readinessPath = resolve(
    sources.workspaceDirectory,
    `${MEMORY_MCP_READINESS_FILE_NAME}-${registrationToken}`
  );
  const readinessNonce = randomUUID();
  yield* Effect.tryPromise({
    try: async () => {
      await assertSafeFilePath({
        anchor: sources.workspaceDirectory,
        operation: "prepare-memory-mcp-readiness",
        path: readinessPath,
      });
      await rm(readinessPath, { force: true });
    },
    catch: () => registrationFailure("invalid"),
  });
  return {
    authority,
    permission: laborerMemoryOpenCodePermission(name),
    readinessNonce,
    readinessPath,
    server: {
      ...server,
      name,
      env: [
        ...server.env.filter(
          ({ name: environmentName }) =>
            environmentName !== LABORER_MEMORY_SERVER_NAME_ENV
        ),
        { name: LABORER_MEMORY_SERVER_NAME_ENV, value: name },
        {
          name: LABORER_MEMORY_REGISTRATION_NONCE_ENV,
          value: readinessNonce,
        },
        { name: LABORER_MEMORY_READY_PATH_ENV, value: readinessPath },
      ],
    },
  };
});

const waitForLaborerMemoryMcpReadiness = Effect.fn(
  "waitForLaborerMemoryMcpReadiness"
)(function* (
  registration: PreparedLaborerMemoryMcpRegistration
): Effect.fn.Return<void, LaborerMemoryRegistrationError> {
  const deadline = Date.now() + MEMORY_MCP_READINESS_WAIT_MILLIS;
  while (Date.now() < deadline) {
    const observed = yield* Effect.tryPromise({
      try: () => readLatestSource(registration.readinessPath),
      catch: () => registrationFailure("missing"),
    });
    if (observed === registration.readinessNonce) {
      return;
    }
    if (observed.length > 0) {
      return yield* registrationFailure("collision");
    }
    yield* Effect.sleep(`${MEMORY_MCP_READINESS_POLL_MILLIS} millis`);
  }
  return yield* registrationFailure("missing");
});

export const awaitLaborerMemoryMcpReadiness = Effect.fn(
  "awaitLaborerMemoryMcpReadiness"
)(function* (
  registration: PreparedLaborerMemoryMcpRegistration
): Effect.fn.Return<void, LaborerMemoryRegistrationError> {
  const result = yield* Effect.result(
    waitForLaborerMemoryMcpReadiness(registration)
  );
  yield* Effect.tryPromise({
    try: () => rm(registration.readinessPath, { force: true }),
    catch: () => registrationFailure("missing"),
  }).pipe(Effect.ignore);
  if (result._tag === "Failure") {
    return yield* result.failure;
  }
});

export const publishLaborerMemoryMcpReadiness = Effect.fn(
  "publishLaborerMemoryMcpReadiness"
)(function* (options: {
  readonly authorityGuard?: string;
  readonly nonce: string;
  readonly path: string;
  readonly root: string;
  readonly serverName: string;
  readonly workspaceId: string;
}) {
  const registrationToken = registrationTokenFromName(
    options,
    options.serverName
  );
  const sources = yield* prepareAcpAgentContextSources(options);
  if (
    options.authorityGuard !== undefined &&
    options.authorityGuard !== laborerMemoryAuthorityGuard(sources)
  ) {
    return yield* registrationFailure("invalid");
  }
  const expectedPath = resolve(
    sources.workspaceDirectory,
    `${MEMORY_MCP_READINESS_FILE_NAME}-${registrationToken ?? "invalid"}`
  );
  if (
    registrationToken === null ||
    options.path !== expectedPath ||
    options.nonce.length === 0 ||
    options.nonce.length > 64
  ) {
    return yield* registrationFailure("invalid");
  }
  yield* Effect.tryPromise({
    try: () =>
      publishAtomically({
        anchor: sources.workspaceDirectory,
        content: options.nonce,
        path: options.path,
      }),
    catch: () => registrationFailure("missing"),
  });
});

export interface LaborerMemoryPermissionRegistration {
  readonly observedToolCallIds: Set<string>;
  readonly permission: string;
}

export const observeLaborerMemoryToolCall = (
  notification: SessionNotification,
  trustedSessionPermissions: ReadonlyMap<
    string,
    LaborerMemoryPermissionRegistration
  >
): void => {
  const registration = trustedSessionPermissions.get(notification.sessionId);
  const update = notification.update;
  if (
    registration !== undefined &&
    update.sessionUpdate === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed")
  ) {
    registration.observedToolCallIds.delete(update.toolCallId);
    return;
  }
  if (
    registration === undefined ||
    update.sessionUpdate !== "tool_call" ||
    update.status !== "pending" ||
    update.title !== registration.permission
  ) {
    return;
  }
  // Pinned OpenCode emits the exact programmatic tool name as the first pending
  // tool-call update before asking permission. The later permission request
  // omits `name`, so authorization consumes only this correlated call ID and
  // never trusts its human-readable title.
  registration.observedToolCallIds.add(update.toolCallId);
  while (
    registration.observedToolCallIds.size > MAX_OBSERVED_MEMORY_TOOL_CALLS
  ) {
    const oldest = registration.observedToolCallIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    registration.observedToolCallIds.delete(oldest);
  }
};

export const authorizeLaborerMemoryPermission = (
  request: RequestPermissionRequest,
  trustedSessionPermissions: ReadonlyMap<
    string,
    LaborerMemoryPermissionRegistration
  >
): RequestPermissionResponse => {
  const registration = trustedSessionPermissions.get(request.sessionId);
  const requestNameMatches =
    request.toolCall.name === undefined ||
    request.toolCall.name === registration?.permission;
  const isObservedMemoryCall =
    requestNameMatches &&
    registration?.observedToolCallIds.delete(request.toolCall.toolCallId) ===
      true;
  const option = isObservedMemoryCall
    ? Option.getOrUndefined(
        EffectArray.findFirst(
          request.options,
          (candidate) => candidate.kind === "allow_once"
        )
      )
    : undefined;
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { optionId: option.optionId, outcome: "selected" } };
};
