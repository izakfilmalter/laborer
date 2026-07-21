#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Array as EffectArray,
  Record as EffectRecord,
  pipe,
  Schema,
} from "effect";
import {
  assertNoSymlinkPathComponents,
  assertSafeFilePath,
  canonicalDirectory,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const STATE_FILE = "classifier-worker-state.json";
const DIAGNOSTIC_FILE = "opencode-stderr.log";
const STALE_TEMPORARY_PATTERN =
  /^\.(?:classifier-worker-state|opencode-|reply-text\.)/;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const MessageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ClassifierMutation = Schema.Struct({
  kind: Schema.Literal("classifier"),
  status: Schema.Literal("started"),
  turnId: NonEmptyString,
  sessionId: Schema.Null,
  baselineMessageCount: Schema.Null,
  resultText: Schema.Null,
});

const InitialWorkerStartedMutation = Schema.Struct({
  kind: Schema.Literal("initial_worker"),
  status: Schema.Literal("started"),
  turnId: NonEmptyString,
  sessionId: Schema.Null,
  baselineMessageCount: Schema.Null,
  resultText: Schema.Null,
});

const InitialWorkerCompletedMutation = Schema.Struct({
  kind: Schema.Literal("initial_worker"),
  status: Schema.Literal("completed"),
  turnId: NonEmptyString,
  sessionId: NonEmptyString,
  baselineMessageCount: Schema.Null,
  resultText: NonEmptyString,
});

const FollowUpStartedMutation = Schema.Struct({
  kind: Schema.Literal("follow_up"),
  status: Schema.Literal("started"),
  turnId: NonEmptyString,
  sessionId: NonEmptyString,
  baselineMessageCount: MessageCount,
  resultText: Schema.Null,
});

const FollowUpCompletedMutation = Schema.Struct({
  kind: Schema.Literal("follow_up"),
  status: Schema.Literal("completed"),
  turnId: NonEmptyString,
  sessionId: NonEmptyString,
  baselineMessageCount: MessageCount,
  resultText: NonEmptyString,
});

const PendingMutation = Schema.Union([
  ClassifierMutation,
  InitialWorkerStartedMutation,
  InitialWorkerCompletedMutation,
  FollowUpStartedMutation,
  FollowUpCompletedMutation,
]);

const StoredReply = Schema.Struct({
  replyId: NonEmptyString,
  text: NonBlankString,
});

const ClassifierWorkerStateShape = Schema.Struct({
  version: Schema.Literal(3),
  classification: Schema.NullOr(Schema.Literals(["bug", "feature"])),
  workerBrief: Schema.NullOr(NonBlankString),
  workerSessionId: Schema.NullOr(NonEmptyString),
  pendingMutation: Schema.NullOr(PendingMutation),
  replies: Schema.Record(NonEmptyString, StoredReply),
});

type ClassifierWorkerState = typeof ClassifierWorkerStateShape.Type;

const classifierWorkerStateInvariant = (
  state: ClassifierWorkerState
): string | undefined => {
  const hasClassification = state.classification !== null;
  const hasWorkerBrief = state.workerBrief !== null;
  if (hasClassification !== hasWorkerBrief) {
    return "classification and workerBrief must be present together";
  }

  const repliesAreCoherent = pipe(
    state.replies,
    EffectRecord.toEntries,
    EffectArray.every(
      ([turnId, reply]) => reply.replyId === `reply:${turnId}:1`
    )
  );
  if (!repliesAreCoherent) {
    return "stored reply IDs must match their turn IDs";
  }

  const replyCount = EffectRecord.size(state.replies);
  if (!hasClassification) {
    const isClassifierStart = state.pendingMutation?.kind === "classifier";
    return state.workerSessionId === null &&
      replyCount === 0 &&
      isClassifierStart
      ? undefined
      : "unclassified state must contain only a started classifier mutation";
  }

  if (state.pendingMutation?.kind === "classifier") {
    return "classifier mutation cannot remain after classification";
  }
  if (replyCount > 0 && state.workerSessionId === null) {
    return "stored replies require a worker session";
  }
  if (
    state.pendingMutation !== null &&
    EffectRecord.has(state.replies, state.pendingMutation.turnId)
  ) {
    return "a pending mutation cannot already have a stored reply";
  }
  if (state.pendingMutation?.kind === "initial_worker") {
    return state.workerSessionId === null
      ? undefined
      : "initial worker mutation cannot have a committed worker session";
  }
  if (state.pendingMutation?.kind === "follow_up") {
    return state.workerSessionId === state.pendingMutation.sessionId
      ? undefined
      : "follow-up mutation must resume the committed worker session";
  }
  return undefined;
};

const ClassifierWorkerState = ClassifierWorkerStateShape.check(
  Schema.makeFilter(classifierWorkerStateInvariant)
);

const validateStateContent = (content: Buffer): void => {
  const source = fatalUtf8Decoder.decode(content);
  const parsed = JSON.parse(source) as unknown;
  Schema.decodeUnknownSync(ClassifierWorkerState)(parsed, {
    errors: "all",
    onExcessProperty: "error",
  });
};

const fail = (message: string): never => {
  process.stderr.write(`classifier-worker state helper: ${message}\n`);
  process.exit(1);
};

const readBoundedStdin = async (maximumBytes: number): Promise<Buffer> => {
  let retained = Buffer.alloc(0);
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      fail("input exceeds limit");
    }
    retained = Buffer.concat([retained, buffer], totalBytes);
  }
  return retained;
};

const readDiagnosticTail = async (): Promise<Buffer> => {
  let retained = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length >= MAX_DIAGNOSTIC_BYTES) {
      retained = buffer.subarray(-MAX_DIAGNOSTIC_BYTES);
      continue;
    }
    const offset = Math.max(
      0,
      retained.length + buffer.length - MAX_DIAGNOSTIC_BYTES
    );
    retained = Buffer.concat(
      [retained.subarray(offset), buffer],
      Math.min(MAX_DIAGNOSTIC_BYTES, retained.length + buffer.length)
    );
  }
  return retained;
};

const atomicWrite = async (
  directory: string,
  filename: string,
  content: Buffer
): Promise<void> => {
  const target = resolve(directory, filename);
  const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`);
  const retainedDirectory = await retainTrustedDirectory(
    directory,
    "write-handler-state"
  );
  try {
    await assertSafeFilePath({
      anchor: directory,
      operation: "write-handler-state",
      path: target,
    });
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await verifyRetainedDirectory(retainedDirectory, "write-handler-state");
    await assertSafeFilePath({
      anchor: directory,
      operation: "write-handler-state",
      path: target,
    });
    await rename(temporary, target);
    await verifyRetainedDirectory(retainedDirectory, "write-handler-state");
    await retainedDirectory.handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await retainedDirectory.handle.close();
  }
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const readState = async (directory: string): Promise<void> => {
  const target = resolve(directory, STATE_FILE);
  const retainedDirectory = await retainTrustedDirectory(
    directory,
    "read-handler-state"
  );
  try {
    await assertSafeFilePath({
      anchor: directory,
      operation: "read-handler-state",
      path: target,
    });
    const file = await openRegularFileNoFollow(target, "read-handler-state");
    try {
      const metadata = await file.stat();
      if (metadata.size > MAX_STATE_BYTES) {
        fail("state exceeds limit");
      }
      const content = await file.readFile();
      validateStateContent(content);
      await verifyRetainedDirectory(retainedDirectory, "read-handler-state");
      process.stdout.write(content);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  } finally {
    await retainedDirectory.handle.close();
  }
};

const cleanupStaleTemporaryFiles = async (directory: string): Promise<void> => {
  const retainedDirectory = await retainTrustedDirectory(
    directory,
    "clean-handler-state"
  );
  try {
    for (const name of await readdir(directory)) {
      if (!STALE_TEMPORARY_PATTERN.test(name)) {
        continue;
      }
      const path = resolve(directory, name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail("unsafe stale temporary entry");
      }
      await rm(path);
    }
    await verifyRetainedDirectory(retainedDirectory, "clean-handler-state");
  } finally {
    await retainedDirectory.handle.close();
  }
};

const main = async (): Promise<void> => {
  const operation = process.argv[2];
  const directoryInput = process.argv[3] ?? fail("missing state directory");
  if (
    operation !== "cleanup" &&
    operation !== "read" &&
    operation !== "write" &&
    operation !== "diagnostic" &&
    operation !== "validate-utf8"
  ) {
    fail("invalid invocation");
  }
  await assertNoSymlinkPathComponents(
    directoryInput,
    "handler-state-directory"
  );
  const directory = await canonicalDirectory(
    directoryInput,
    "handler-state-directory"
  );
  if (operation === "read") {
    await readState(directory);
    return;
  }
  if (operation === "cleanup") {
    await cleanupStaleTemporaryFiles(directory);
    return;
  }
  if (operation === "write") {
    const content = await readBoundedStdin(MAX_STATE_BYTES);
    validateStateContent(content);
    await atomicWrite(directory, STATE_FILE, content);
    return;
  }
  if (operation === "validate-utf8") {
    const content = await readBoundedStdin(MAX_STATE_BYTES);
    fatalUtf8Decoder.decode(content);
    process.stdout.write(content);
    return;
  }
  await atomicWrite(directory, DIAGNOSTIC_FILE, await readDiagnosticTail());
};

await main().catch(() => fail("operation failed"));
