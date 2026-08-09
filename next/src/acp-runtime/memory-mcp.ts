import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
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
} from "../core/path-safety.ts";
import {
  type AcpAgentContextSources,
  isSlackTeamId,
  isSlackUserId,
  prepareAcpAgentContextSources,
  USER_PROFILE_CHARACTER_LIMIT,
  userProfileLockPath,
  userProfilePath,
  verifyAcpAgentContextSources,
  WORKSPACE_MEMORY_CHARACTER_LIMIT,
} from "./agent-context.ts";
import { withCrossProcessContextLocks } from "./context-lock.ts";
import {
  laborerMcpEnvironmentIsScrubbed,
  laborerMcpServerLauncherArgs,
} from "./mcp-server-launcher-config.ts";
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

// Canonical framing adds fixed metadata per entry. This cap accommodates the
// worst valid 4,000-character state when every four-byte code point is stored
// as its own framed entry, while still bounding operator-controlled reads.
const MAX_MEMORY_SOURCE_BYTES = 512 * 1024;
const MAX_MEMORY_DIAGNOSTIC_BYTES = 4096;
const MEMORY_MCP_READINESS_WAIT_MILLIS = 5000;
const MEMORY_MCP_READINESS_POLL_MILLIS = 20;
const MAX_TEST_CRITICAL_SECTION_DELAY_MILLIS = 7000;
const MEMORY_ENTRY_SEPARATOR = "\n\n";
const MEMORY_MCP_READINESS_FILE_NAME = "memory-mcp-readiness";
const MEMORY_REGISTRATION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MEMORY_AUTHORITY_GUARD_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TRACKED_MEMORY_TOOL_CALLS = 64;
const MAX_MEMORY_PERMISSION_FINGERPRINT_BYTES = 64 * 1024;
const MAX_MEMORY_PERMISSION_FINGERPRINT_DEPTH = 8;
const MAX_MEMORY_PERMISSION_FINGERPRINT_ITEMS = 256;
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

export interface LaborerMemoryAuthorityTestHooks {
  readonly beforeDiagnosticPublication?: () => Promise<void>;
  readonly beforeLockDatabase?: () => Promise<void>;
}

const canonicalTargetPath = async (targetPath: string): Promise<string> =>
  resolve(await realpath(dirname(targetPath)), basename(targetPath));
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
  await options.assertCanCommit?.();
  const directory = await retainTrustedDirectory(
    dirname(options.path),
    "mutate-agent-memory"
  );
  const temporaryPath = `${options.path}.${randomUUID()}.tmp`;
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await options.assertCanCommit?.();
    await verifyRetainedDirectory(directory, "mutate-agent-memory");
    await assertSafeFilePath({
      anchor: options.anchor,
      operation: "mutate-agent-memory",
      path: options.path,
    });
    await options.assertCanCommit?.();
    await verifyRetainedDirectory(directory, "mutate-agent-memory");
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
  | "registration-active-call-timeout"
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
  code: LaborerMemoryDiagnosticCode,
  testHooks?: LaborerMemoryAuthorityTestHooks
): Promise<void> => {
  const assertAuthority = (): Promise<void> =>
    verifyAcpAgentContextSources(sources, "record-memory-diagnostic");
  await assertAuthority();
  const canonicalWorkspaceDirectory = await realpath(
    sources.workspaceDirectory
  );
  await assertAuthority();
  const canonicalDiagnosticsPath = await canonicalTargetPath(
    sources.memoryDiagnosticsPath
  );
  await testHooks?.beforeLockDatabase?.();
  await assertAuthority();
  await withCrossProcessContextLocks({
    lockPaths: [sources.memoryDiagnosticsLockPath],
    operation: async (locks) => {
      const assertCanCommit = async (): Promise<void> => {
        await locks.assertCanCommit();
        await assertAuthority();
      };
      let current = "";
      try {
        current = await readLatestSource(canonicalDiagnosticsPath);
      } catch {
        // An invalid or manually oversized sink is replaced with bounded data.
      }
      await assertCanCommit();
      await testHooks?.beforeDiagnosticPublication?.();
      await assertCanCommit();
      await publishAtomically({
        anchor: canonicalWorkspaceDirectory,
        assertCanCommit,
        content: boundedDiagnosticContent(current, code),
        path: canonicalDiagnosticsPath,
      });
    },
  });
};

export const recordLaborerMemoryDiagnostic = Effect.fn(
  "recordLaborerMemoryDiagnostic"
)(function* (options: {
  readonly authorityGuard?: string;
  readonly code: LaborerMemoryDiagnosticCode;
  readonly configRoot?: string;
  readonly root: string;
  readonly stateRoot?: string;
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
  readonly testHooks?: LaborerMemoryAuthorityTestHooks;
}) {
  yield* Effect.tryPromise({
    try: () =>
      writeLaborerMemoryDiagnostic(
        options.sources,
        options.code,
        options.testHooks
      ),
    catch: () => mutationFailure("storage-unavailable"),
  }).pipe(Effect.ignore);
});

const targetDetails = (
  sources: AcpAgentContextSources,
  mutation: MemoryMutation
): {
  readonly characterLimit: number;
  readonly lockPath: string;
  readonly path: string;
} => {
  if (mutation.target === "workspace") {
    if (mutation.userId !== undefined) {
      throw mutationFailure("invalid-input");
    }
    return {
      characterLimit: WORKSPACE_MEMORY_CHARACTER_LIMIT,
      lockPath: sources.workspaceMemoryLockPath,
      path: sources.workspaceMemoryPath,
    };
  }
  if (mutation.userId === undefined || !isSlackUserId(mutation.userId)) {
    throw mutationFailure("invalid-input");
  }
  return {
    characterLimit: USER_PROFILE_CHARACTER_LIMIT,
    lockPath: userProfileLockPath(sources, mutation.userId),
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
    readonly configRoot?: string;
    readonly root: string;
    readonly stateRoot?: string;
    readonly testHooks?: LaborerMemoryAuthorityTestHooks;
    readonly workspaceId: string;
  }): Effect.fn.Return<LaborerMemoryStore> {
    const sources = yield* prepareAcpAgentContextSources({
      ...(options.configRoot === undefined
        ? {}
        : { configRoot: options.configRoot }),
      root: options.root,
      ...(options.stateRoot === undefined
        ? {}
        : { stateRoot: options.stateRoot }),
      workspaceId: options.workspaceId,
    });
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
            await Promise.all([
              ensureOwnerOnlyDirectoryTree({
                anchor: sources.workspaceContextDirectory,
                operation: "prepare-user-profile-directory",
                target: sources.userProfilesDirectory,
              }),
              ensureOwnerOnlyDirectoryTree({
                anchor: sources.workspaceLockDirectory,
                operation: "prepare-user-profile-lock-directory",
                target: sources.userProfileLocksDirectory,
              }),
            ]);
          }
          const canonicalWorkspaceContextDirectory = await realpath(
            sources.workspaceContextDirectory
          );
          const canonicalMemoryPath = await canonicalTargetPath(details.path);
          await options.testHooks?.beforeLockDatabase?.();
          await verifyAcpAgentContextSources(sources, "mutate-agent-memory");
          return withCrossProcessContextLocks({
            lockPaths: [details.lockPath],
            onCancelled: () => mutationFailure("cancelled"),
            operation: async (heldLocks) => {
              const assertCanCommit = async (): Promise<void> => {
                await heldLocks.assertCanCommit();
                await verifyAcpAgentContextSources(
                  sources,
                  "mutate-agent-memory"
                );
              };
              await assertCanCommit();
              const current = await readLatestSource(canonicalMemoryPath);
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
                  anchor: canonicalWorkspaceContextDirectory,
                  assertCanCommit,
                  content: next.content,
                  path: canonicalMemoryPath,
                });
              }
              return {
                changed: next.changed,
                renderedCharacters,
                target: mutation.target,
              };
            },
            signal,
          });
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
  readonly configRoot?: string;
  readonly root: string;
  readonly serverName?: string;
  readonly stateRoot?: string;
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
    name: options.serverName ?? laborerMemoryServerName(diagnosticSources),
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
  readonly configRoot: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly workspaceId: string;
}): string => {
  const authority = createHash("sha256")
    .update(options.root)
    .update("\0")
    .update(options.configRoot)
    .update("\0")
    .update(options.stateRoot)
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
    .update(sources.configRoot)
    .update("\0")
    .update(String(sources.configRootDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.configRootDirectoryIdentity.inode))
    .update("\0")
    .update(sources.stateRoot)
    .update("\0")
    .update(String(sources.stateRootDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.stateRootDirectoryIdentity.inode))
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
    .update("\0")
    .update(sources.rootContextDirectory)
    .update("\0")
    .update(String(sources.rootContextDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.rootContextDirectoryIdentity.inode))
    .update("\0")
    .update(sources.workspaceContextDirectory)
    .update("\0")
    .update(String(sources.workspaceContextDirectoryIdentity.device))
    .update("\0")
    .update(String(sources.workspaceContextDirectoryIdentity.inode))
    .digest("hex");

const serverEnvironmentValue = (
  server: McpServerStdio,
  name: string
): string | undefined => {
  const matches = server.env.filter((entry) => entry.name === name);
  return matches.length === 1 ? matches[0]?.value : undefined;
};

export interface LaborerMemoryMcpAuthority {
  readonly configRoot: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly workspaceId: string;
}

export const laborerMemoryMcpAuthority = (
  server: McpServerStdio
): LaborerMemoryMcpAuthority | null => {
  const root = serverEnvironmentValue(server, "LABORER_MEMORY_ROOT");
  const configRoot = serverEnvironmentValue(
    server,
    "LABORER_MEMORY_CONFIG_ROOT"
  );
  const stateRoot = serverEnvironmentValue(server, "LABORER_MEMORY_STATE_ROOT");
  const workspaceId = serverEnvironmentValue(
    server,
    "LABORER_MEMORY_WORKSPACE_ID"
  );
  return root === undefined ||
    configRoot === undefined ||
    !isAbsolute(configRoot) ||
    stateRoot === undefined ||
    !isAbsolute(stateRoot) ||
    workspaceId === undefined ||
    !isSlackTeamId(workspaceId)
    ? null
    : { configRoot, root, stateRoot, workspaceId };
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
    args: [...laborerMcpServerLauncherArgs("memory")],
    command: process.execPath,
    env: [
      { name: "LABORER_MEMORY_ROOT", value: sources.root },
      { name: "LABORER_MEMORY_CONFIG_ROOT", value: sources.configRoot },
      { name: "LABORER_MEMORY_STATE_ROOT", value: sources.stateRoot },
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
    JSON.stringify(server.args) !==
      JSON.stringify(laborerMcpServerLauncherArgs("memory")) ||
    server.env.length !== 6
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
  const configRoot = Option.getOrUndefined(
    EffectArray.findFirst(
      server.env,
      ({ name }) => name === "LABORER_MEMORY_CONFIG_ROOT"
    )
  )?.value;
  const stateRoot = Option.getOrUndefined(
    EffectArray.findFirst(
      server.env,
      ({ name }) => name === "LABORER_MEMORY_STATE_ROOT"
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
  if (
    configuredRoot === undefined ||
    configRoot === undefined ||
    stateRoot === undefined ||
    workspaceId === undefined
  ) {
    return false;
  }
  return (
    configuredRoot === root &&
    isAbsolute(configRoot) &&
    isAbsolute(stateRoot) &&
    workspaceId !== undefined &&
    isSlackTeamId(workspaceId) &&
    serverName ===
      laborerMemoryServerName({
        configRoot,
        root: configuredRoot,
        stateRoot,
        workspaceId,
      }) &&
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

const registrationFailure = (
  reason: LaborerMemoryRegistrationError["reason"]
): LaborerMemoryRegistrationError =>
  LaborerMemoryRegistrationError.make({ reason });

const decodeMemoryReadiness = (
  source: string
): {
  readonly environmentNames: readonly string[];
  readonly nonce: string;
} | null => {
  try {
    const readiness = JSON.parse(source) as unknown;
    if (
      typeof readiness !== "object" ||
      readiness === null ||
      !("nonce" in readiness) ||
      typeof readiness.nonce !== "string" ||
      !("environmentNames" in readiness) ||
      !Array.isArray(readiness.environmentNames) ||
      !readiness.environmentNames.every((name) => typeof name === "string")
    ) {
      return null;
    }
    return {
      environmentNames: readiness.environmentNames as string[],
      nonce: readiness.nonce,
    };
  } catch {
    return null;
  }
};

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
  const readinessNonce = randomUUID().replaceAll("-", "");
  const readinessPath = resolve(
    sources.workspaceDirectory,
    `${MEMORY_MCP_READINESS_FILE_NAME}-${readinessNonce}`
  );
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
    permission: laborerMemoryOpenCodePermission(server.name),
    readinessNonce,
    readinessPath,
    server: {
      ...server,
      env: [
        ...server.env,
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
): Effect.fn.Return<readonly string[], LaborerMemoryRegistrationError> {
  const deadline = Date.now() + MEMORY_MCP_READINESS_WAIT_MILLIS;
  while (Date.now() < deadline) {
    const observed = yield* Effect.tryPromise({
      try: () => readLatestSource(registration.readinessPath),
      catch: () => registrationFailure("missing"),
    });
    const readiness = decodeMemoryReadiness(observed);
    if (
      readiness?.nonce === registration.readinessNonce &&
      laborerMcpEnvironmentIsScrubbed("memory", readiness.environmentNames)
    ) {
      return readiness.environmentNames;
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
): Effect.fn.Return<readonly string[], LaborerMemoryRegistrationError> {
  return yield* waitForLaborerMemoryMcpReadiness(registration).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => rm(registration.readinessPath, { force: true }),
        catch: () => registrationFailure("missing"),
      }).pipe(Effect.ignore)
    )
  );
});

export const publishLaborerMemoryMcpReadiness = Effect.fn(
  "publishLaborerMemoryMcpReadiness"
)(function* (options: {
  readonly authorityGuard?: string;
  readonly configRoot: string;
  readonly nonce: string;
  readonly environmentNames: readonly string[];
  readonly path: string;
  readonly root: string;
  readonly serverName: string;
  readonly stateRoot: string;
  readonly workspaceId: string;
}) {
  const sources = yield* prepareAcpAgentContextSources(options);
  const expectedGuard = laborerMemoryAuthorityGuard(sources);
  if (options.authorityGuard !== expectedGuard) {
    return yield* registrationFailure("invalid");
  }
  const expectedPath = resolve(
    sources.workspaceDirectory,
    `${MEMORY_MCP_READINESS_FILE_NAME}-${options.nonce}`
  );
  if (
    options.serverName !== laborerMemoryServerName(options) ||
    options.path !== expectedPath ||
    !MEMORY_REGISTRATION_TOKEN_PATTERN.test(options.nonce) ||
    !laborerMcpEnvironmentIsScrubbed("memory", options.environmentNames)
  ) {
    return yield* registrationFailure("invalid");
  }
  yield* Effect.tryPromise({
    try: () =>
      publishAtomically({
        anchor: sources.workspaceDirectory,
        assertCanCommit: () =>
          verifyAcpAgentContextSources(sources, "publish-memory-readiness"),
        content: JSON.stringify({
          environmentNames: options.environmentNames,
          nonce: options.nonce,
        }),
        path: options.path,
      }),
    catch: () => registrationFailure("missing"),
  });
});

export interface LaborerMemoryPermissionRegistration {
  readonly consumedToolCallIds: Set<string>;
  readonly gate: LaborerMemoryPermissionGate;
  readonly generation: string;
  readonly observedFingerprints: Map<
    string,
    { readonly fingerprint: string; readonly generation: string }
  >;
  readonly observedToolCallIds: Set<string>;
  readonly permission: string;
  readonly pinnedOpenCodeVersion: "0.0.0-next-17055" | null;
  readonly rejectedToolCallIds: Set<string>;
  rejectUncorrelatedPermissions: boolean;
}

export interface LaborerMemoryPermissionGate {
  acceptingCalls: boolean;
  readonly activeToolCallIds: Set<string>;
  readonly onSafetyDenial?: () => void;
  safetyDenialObserved: boolean;
}

const memoryToolCallKey = (sessionId: string, toolCallId: string): string =>
  `${sessionId}\0${toolCallId}`;

const invalidFingerprintValue = Symbol("invalid-memory-fingerprint-value");

const canonicalFingerprintValue = (
  value: unknown,
  depth = 0
): unknown | typeof invalidFingerprintValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidFingerprintValue;
  }
  if (depth >= MAX_MEMORY_PERMISSION_FINGERPRINT_DEPTH) {
    return invalidFingerprintValue;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_MEMORY_PERMISSION_FINGERPRINT_ITEMS) {
      return invalidFingerprintValue;
    }
    const normalized: unknown[] = [];
    for (const item of value) {
      const canonical = canonicalFingerprintValue(item, depth + 1);
      if (canonical === invalidFingerprintValue) {
        return invalidFingerprintValue;
      }
      normalized.push(canonical);
    }
    return normalized;
  }
  if (typeof value !== "object" || value === null) {
    return invalidFingerprintValue;
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_MEMORY_PERMISSION_FINGERPRINT_ITEMS) {
    return invalidFingerprintValue;
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    const canonical = canonicalFingerprintValue(item, depth + 1);
    if (canonical === invalidFingerprintValue) {
      return invalidFingerprintValue;
    }
    normalized[key] = canonical;
  }
  return normalized;
};

const memoryPermissionFingerprint = (toolCall: {
  readonly kind?: unknown;
  readonly rawInput?: unknown;
  readonly status?: unknown;
  readonly title?: unknown;
}): string | null => {
  const canonicalRawInput =
    toolCall.rawInput === undefined
      ? "<absent>"
      : canonicalFingerprintValue(toolCall.rawInput);
  if (canonicalRawInput === invalidFingerprintValue) {
    return null;
  }
  const rawInput = JSON.stringify(canonicalRawInput);
  if (
    Buffer.byteLength(rawInput, "utf8") >
    MAX_MEMORY_PERMISSION_FINGERPRINT_BYTES
  ) {
    return null;
  }
  const rawInputDigest = createHash("sha256")
    .update(rawInput)
    .digest("base64url");
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: toolCall.kind,
        rawInputDigest,
        status: toolCall.status,
        title: toolCall.title,
      })
    )
    .digest("base64url");
};

const isPinnedOpenCodeMemoryTitle = (
  registration: LaborerMemoryPermissionRegistration,
  toolCall: {
    readonly kind?: unknown;
    readonly rawInput?: unknown;
    readonly title?: unknown;
  }
): boolean => {
  if (
    registration.pinnedOpenCodeVersion === null ||
    toolCall.title !== registration.permission
  ) {
    return false;
  }
  if (toolCall.kind !== "execute") {
    return true;
  }
  if (typeof toolCall.rawInput !== "object" || toolCall.rawInput === null) {
    return true;
  }
  let command: unknown;
  if ("command" in toolCall.rawInput) {
    command = toolCall.rawInput.command;
  } else if ("cmd" in toolCall.rawInput) {
    command = toolCall.rawInput.cmd;
  }
  return typeof command !== "string";
};

const rejectMemoryToolCall = (
  registration: LaborerMemoryPermissionRegistration,
  toolCallId: string
): void => {
  if (registration.rejectedToolCallIds.size < MAX_TRACKED_MEMORY_TOOL_CALLS) {
    registration.rejectedToolCallIds.add(toolCallId);
  } else {
    registration.rejectUncorrelatedPermissions = true;
  }
  markMemoryPermissionSafetyDenial(registration.gate);
};

const refreshConsumedToolCall = (
  registration: LaborerMemoryPermissionRegistration,
  toolCallId: string
): void => {
  registration.consumedToolCallIds.delete(toolCallId);
  registration.consumedToolCallIds.add(toolCallId);
};

const makeTrackingCapacity = (
  registration: LaborerMemoryPermissionRegistration,
  sessionId: string
): boolean => {
  while (
    registration.consumedToolCallIds.size +
      registration.observedToolCallIds.size >=
    MAX_TRACKED_MEMORY_TOOL_CALLS
  ) {
    let inactiveConsumed: string | undefined;
    for (const consumedToolCallId of registration.consumedToolCallIds) {
      if (
        !registration.gate.activeToolCallIds.has(
          memoryToolCallKey(sessionId, consumedToolCallId)
        )
      ) {
        inactiveConsumed = consumedToolCallId;
        break;
      }
    }
    if (inactiveConsumed === undefined) {
      return false;
    }
    registration.consumedToolCallIds.delete(inactiveConsumed);
  }
  return true;
};

const markMemoryPermissionSafetyDenial = (
  gate: LaborerMemoryPermissionGate
): void => {
  if (gate.safetyDenialObserved) {
    return;
  }
  gate.safetyDenialObserved = true;
  gate.onSafetyDenial?.();
};

export const clearLaborerMemoryPermissionRegistration = (
  sessionId: string,
  registration: LaborerMemoryPermissionRegistration,
  options?: { readonly preserveActiveToolCalls?: boolean }
): void => {
  registration.consumedToolCallIds.clear();
  registration.observedFingerprints.clear();
  registration.observedToolCallIds.clear();
  registration.rejectedToolCallIds.clear();
  registration.rejectUncorrelatedPermissions = false;
  if (options?.preserveActiveToolCalls === true) {
    return;
  }
  const prefix = `${sessionId}\0`;
  for (const activeToolCallId of registration.gate.activeToolCallIds) {
    if (activeToolCallId.startsWith(prefix)) {
      registration.gate.activeToolCallIds.delete(activeToolCallId);
    }
  }
};

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
    if (registration.observedToolCallIds.delete(update.toolCallId)) {
      registration.observedFingerprints.delete(update.toolCallId);
      refreshConsumedToolCall(registration, update.toolCallId);
    }
    registration.gate.activeToolCallIds.delete(
      memoryToolCallKey(notification.sessionId, update.toolCallId)
    );
    return;
  }
  if (registration === undefined || update.sessionUpdate !== "tool_call") {
    return;
  }
  // Pinned OpenCode emits the exact programmatic tool name as the first pending
  // tool-call update before asking permission. The later permission request can
  // omit `name`, so authorization consumes only this correlated call ID and
  // never trusts its human-readable title as authentication.
  const hasExactExperimentalName = update.name === registration.permission;
  const hasPinnedTitleAttempt = isPinnedOpenCodeMemoryTitle(
    registration,
    update
  );
  const hasPinnedFallbackIdentity =
    update.name === undefined && hasPinnedTitleAttempt;
  if (!(hasExactExperimentalName || hasPinnedTitleAttempt)) {
    return;
  }
  const fingerprint = memoryPermissionFingerprint(update);
  const hasValidPendingShape =
    (hasExactExperimentalName || hasPinnedFallbackIdentity) &&
    update.status === "pending" &&
    update.kind === "other" &&
    fingerprint !== null;
  if (!hasValidPendingShape) {
    rejectMemoryToolCall(registration, update.toolCallId);
    return;
  }
  if (registration.consumedToolCallIds.has(update.toolCallId)) {
    refreshConsumedToolCall(registration, update.toolCallId);
    return;
  }
  if (registration.observedToolCallIds.has(update.toolCallId)) {
    return;
  }
  if (registration.rejectedToolCallIds.has(update.toolCallId)) {
    return;
  }
  if (!makeTrackingCapacity(registration, notification.sessionId)) {
    rejectMemoryToolCall(registration, update.toolCallId);
    return;
  }
  registration.observedToolCallIds.add(update.toolCallId);
  registration.observedFingerprints.set(update.toolCallId, {
    fingerprint,
    generation: registration.generation,
  });
  registration.gate.activeToolCallIds.add(
    memoryToolCallKey(notification.sessionId, update.toolCallId)
  );
};

export const tryAuthorizeLaborerMemoryPermission = (
  request: RequestPermissionRequest,
  trustedSessionPermissions: ReadonlyMap<
    string,
    LaborerMemoryPermissionRegistration
  >
): RequestPermissionResponse | null => {
  const registration = trustedSessionPermissions.get(request.sessionId);
  const hasExactRegisteredIdentity = [
    ...trustedSessionPermissions.values(),
  ].some((candidate) => request.toolCall.name === candidate.permission);
  const hasPinnedRegisteredIdentity = [
    ...trustedSessionPermissions.values(),
  ].some((candidate) =>
    isPinnedOpenCodeMemoryTitle(candidate, request.toolCall)
  );
  const wasConsumedMemoryCall =
    registration?.consumedToolCallIds.has(request.toolCall.toolCallId) === true;
  const isTrackedMemoryCall =
    wasConsumedMemoryCall ||
    registration?.observedToolCallIds.has(request.toolCall.toolCallId) ===
      true ||
    registration?.rejectedToolCallIds.has(request.toolCall.toolCallId) === true;
  const isUncorrelatedMemoryCandidate =
    registration !== undefined &&
    request.toolCall.name === undefined &&
    (registration.observedToolCallIds.size > 0 ||
      registration.rejectUncorrelatedPermissions);
  if (
    !(
      hasExactRegisteredIdentity ||
      hasPinnedRegisteredIdentity ||
      isTrackedMemoryCall ||
      isUncorrelatedMemoryCandidate
    )
  ) {
    return null;
  }
  if (registration === undefined) {
    return { outcome: { outcome: "cancelled" } };
  }
  if (registration.rejectedToolCallIds.has(request.toolCall.toolCallId)) {
    return { outcome: { outcome: "cancelled" } };
  }
  const observedFingerprint = registration.observedFingerprints.get(
    request.toolCall.toolCallId
  );
  const wasObservedMemoryCall = registration.observedToolCallIds.delete(
    request.toolCall.toolCallId
  );
  registration.observedFingerprints.delete(request.toolCall.toolCallId);
  if (wasObservedMemoryCall) {
    refreshConsumedToolCall(registration, request.toolCall.toolCallId);
  } else if (wasConsumedMemoryCall) {
    refreshConsumedToolCall(registration, request.toolCall.toolCallId);
  }
  const hasExactExperimentalName =
    request.toolCall.name === registration.permission;
  const requestFingerprint = memoryPermissionFingerprint(request.toolCall);
  const hasExactPinnedShape =
    request.toolCall.name === undefined &&
    registration.pinnedOpenCodeVersion !== null &&
    request.toolCall.title === registration.permission &&
    request.toolCall.kind === "other" &&
    request.toolCall.status === "pending" &&
    requestFingerprint !== null &&
    observedFingerprint?.generation === registration.generation &&
    observedFingerprint.fingerprint === requestFingerprint;
  const requestAuthenticationMatches =
    hasExactExperimentalName || hasExactPinnedShape;
  const isObservedMemoryCall =
    wasObservedMemoryCall &&
    requestAuthenticationMatches &&
    registration.gate.acceptingCalls;
  if (!wasObservedMemoryCall) {
    return { outcome: { outcome: "cancelled" } };
  }
  const option = isObservedMemoryCall
    ? Option.getOrUndefined(
        EffectArray.findFirst(
          request.options,
          (candidate) => candidate.kind === "allow_once"
        )
      )
    : undefined;
  if (!isObservedMemoryCall || option === undefined) {
    markMemoryPermissionSafetyDenial(registration.gate);
  }
  if (option !== undefined) {
    registration.gate.activeToolCallIds.add(
      memoryToolCallKey(request.sessionId, request.toolCall.toolCallId)
    );
  }
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { optionId: option.optionId, outcome: "selected" } };
};

export const authorizeLaborerMemoryPermission = (
  request: RequestPermissionRequest,
  trustedSessionPermissions: ReadonlyMap<
    string,
    LaborerMemoryPermissionRegistration
  >
): RequestPermissionResponse =>
  tryAuthorizeLaborerMemoryPermission(request, trustedSessionPermissions) ?? {
    outcome: { outcome: "cancelled" },
  };
