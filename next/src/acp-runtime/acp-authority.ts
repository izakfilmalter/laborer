import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Array as EffectArray, Schema, Semaphore } from "effect";
import { withApplicationFileLock } from "../core/application-file-lock.ts";
import { HandlerFailure } from "../core/errors.ts";
import {
  assertSafeFilePath,
  ensureOwnerOnlyDirectoryTree,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../core/path-safety.ts";

const AUTHORITY_SCHEMA_VERSION = 1;
const AUTHORITY_KEY_BYTES = 32;
export const ACP_AUTHORITY_MAX_FILE_BYTES = 1024 * 1024;
export const ACP_AUTHORITY_MAX_PENDING_PER_CONVERSATION = 16;
export const ACP_AUTHORITY_MAX_PENDING_PER_TURN = 4;
export const ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE = 64;
const MAX_TERMINAL_RECORDS = 256;
const MAX_AUTHORITY_RECORDS =
  ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE + MAX_TERMINAL_RECORDS;
const MAX_AUTHORITY_FIELD_LENGTH = 128;
export const ACP_AUTHORITY_TERMINAL_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;

const AuthorityField = Schema.NonEmptyString.check(
  Schema.isMaxLength(MAX_AUTHORITY_FIELD_LENGTH)
);

export const AcpPermissionState = Schema.Literals([
  "pending",
  "allowed",
  "rejected",
  "cancelled",
]);
export type AcpPermissionState = typeof AcpPermissionState.Type;

export class AcpPermissionAuthorityRecord extends Schema.Class<AcpPermissionAuthorityRecord>(
  "AcpPermissionAuthorityRecord"
)({
  argumentDigest: AuthorityField,
  authorizedUserDigest: AuthorityField,
  bindingGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  capabilityDigest: AuthorityField,
  category: Schema.Literals([
    "file edit",
    "file read",
    "guarded tool",
    "network",
    "shell",
  ]),
  channelDigest: AuthorityField,
  conversationDigest: AuthorityField,
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
  decisionClaimedAt: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  decisionIntent: Schema.NullOr(Schema.Literals(["allow", "reject"])).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  inputDigest: AuthorityField,
  messageDigest: Schema.NullOr(AuthorityField),
  optionAllowDigest: AuthorityField,
  optionRejectDigest: AuthorityField,
  presentationMarkerDigest: Schema.NullOr(AuthorityField).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  processGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  promptDigest: AuthorityField,
  recordId: AuthorityField,
  requestIdentityDigest: AuthorityField,
  rootDigest: AuthorityField,
  sessionDigest: AuthorityField,
  state: AcpPermissionState,
  toolCallDigest: AuthorityField,
  turnDigest: AuthorityField,
  updatedAt: Schema.Int,
  workspaceDigest: AuthorityField,
}) {}

class AcpPermissionAuthorityState extends Schema.Class<AcpPermissionAuthorityState>(
  "AcpPermissionAuthorityState"
)({
  records: Schema.Array(AcpPermissionAuthorityRecord).check(
    Schema.isMaxLength(MAX_AUTHORITY_RECORDS)
  ),
  schemaVersion: Schema.Literal(AUTHORITY_SCHEMA_VERSION),
}) {}

export interface AcpAuthorityRepository {
  readonly digest: (namespace: string, value: string) => string;
  readonly load: Effect.Effect<
    readonly AcpPermissionAuthorityRecord[],
    HandlerFailure
  >;
  readonly makeCapability: () => {
    readonly digest: string;
    readonly token: string;
  };
  readonly transact: <A>(
    update: (
      records: readonly AcpPermissionAuthorityRecord[]
    ) => readonly [A, readonly AcpPermissionAuthorityRecord[]]
  ) => Effect.Effect<A, HandlerFailure>;
}

/** Shared live turn scope. Permission and future Action capabilities derive
 * separate credentials from this scope; neither credential authorizes the other. */
export interface AcpTurnScope {
  readonly bindingGeneration: number;
  readonly channelId: string;
  readonly conversationId: string;
  readonly processGeneration: number;
  readonly promptId: string;
  readonly rootTs: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}

const authorityFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "ACP authority repository is unavailable",
  });

const readOwnerOnlyKey = async (
  path: string,
  trustedRoot: string
): Promise<Buffer> => {
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "read-acp-authority-key",
      path,
    });
    const metadata = await stat(path, { bigint: false });
    if (!metadata.isFile() || metadata.mode % 64 !== 0) {
      throw new Error("ACP authority key permissions are unsafe");
    }
    const key = await readFile(path);
    if (key.byteLength !== AUTHORITY_KEY_BYTES) {
      throw new Error("ACP authority key is invalid");
    }
    return key;
  } catch (cause) {
    if (
      typeof cause !== "object" ||
      cause === null ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw cause;
    }
  }
  const key = randomBytes(AUTHORITY_KEY_BYTES);
  const directory = await retainTrustedDirectory(
    dirname(path),
    "create-acp-authority-key"
  );
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "create-acp-authority-key",
      path,
    });
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(key);
      await file.sync();
    } finally {
      await file.close();
    }
    await verifyRetainedDirectory(directory, "create-acp-authority-key");
    await directory.handle.sync();
  } finally {
    await directory.handle.close();
  }
  return key;
};

const initialAuthorityState = AcpPermissionAuthorityState.make({
  records: [],
  schemaVersion: AUTHORITY_SCHEMA_VERSION,
});

export type AcpPendingCapacityScope = "conversation" | "turn" | "workspace";

export const pendingPermissionCapacityExceeded = (
  records: readonly AcpPermissionAuthorityRecord[],
  candidate: Pick<
    AcpPermissionAuthorityRecord,
    "conversationDigest" | "turnDigest" | "workspaceDigest"
  >
): AcpPendingCapacityScope | null => {
  let conversationCount = 0;
  let turnCount = 0;
  let workspaceCount = 0;
  for (const record of records) {
    if (record.state !== "pending") {
      continue;
    }
    if (record.workspaceDigest === candidate.workspaceDigest) {
      workspaceCount += 1;
    }
    if (record.conversationDigest === candidate.conversationDigest) {
      conversationCount += 1;
    }
    if (record.turnDigest === candidate.turnDigest) {
      turnCount += 1;
    }
  }
  if (turnCount >= ACP_AUTHORITY_MAX_PENDING_PER_TURN) {
    return "turn";
  }
  if (conversationCount >= ACP_AUTHORITY_MAX_PENDING_PER_CONVERSATION) {
    return "conversation";
  }
  return workspaceCount >= ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE
    ? "workspace"
    : null;
};

const assertAuthorityRecordBounds = (
  records: readonly AcpPermissionAuthorityRecord[]
): void => {
  if (records.length > MAX_AUTHORITY_RECORDS) {
    throw new Error("ACP authority record capacity exceeded");
  }
  let pendingCount = 0;
  const conversations = new Map<string, number>();
  const turns = new Map<string, number>();
  const workspaces = new Map<string, number>();
  for (const record of records) {
    if (record.state !== "pending") {
      continue;
    }
    pendingCount += 1;
    conversations.set(
      record.conversationDigest,
      (conversations.get(record.conversationDigest) ?? 0) + 1
    );
    turns.set(record.turnDigest, (turns.get(record.turnDigest) ?? 0) + 1);
    workspaces.set(
      record.workspaceDigest,
      (workspaces.get(record.workspaceDigest) ?? 0) + 1
    );
  }
  if (pendingCount > ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE) {
    throw new Error("ACP authority pending workspace capacity exceeded");
  }
  if (
    [...conversations.values()].some(
      (count) => count > ACP_AUTHORITY_MAX_PENDING_PER_CONVERSATION
    ) ||
    [...turns.values()].some(
      (count) => count > ACP_AUTHORITY_MAX_PENDING_PER_TURN
    ) ||
    [...workspaces.values()].some(
      (count) => count > ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE
    )
  ) {
    throw new Error("ACP authority pending scope capacity exceeded");
  }
};

const readAuthorityState = async (
  path: string,
  trustedRoot: string
): Promise<AcpPermissionAuthorityState> => {
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "read-acp-authority-state",
      path,
    });
    const metadata = await stat(path, { bigint: false });
    if (metadata.size > ACP_AUTHORITY_MAX_FILE_BYTES) {
      throw new Error("ACP authority state exceeds its byte limit");
    }
    const source = await readFile(path, "utf8");
    const state = await Effect.runPromise(
      Schema.decodeUnknownEffect(AcpPermissionAuthorityState)(
        JSON.parse(source) as unknown
      )
    );
    assertAuthorityRecordBounds(state.records);
    return state;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return initialAuthorityState;
    }
    throw cause;
  }
};

const writeAuthorityState = async (
  path: string,
  state: AcpPermissionAuthorityState,
  trustedRoot: string,
  afterRename?: () => Promise<void>
): Promise<void> => {
  const directory = await retainTrustedDirectory(
    dirname(path),
    "persist-acp-authority-state"
  );
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "persist-acp-authority-state",
      path,
    });
    assertAuthorityRecordBounds(state.records);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > ACP_AUTHORITY_MAX_FILE_BYTES) {
      throw new Error("ACP authority state exceeds its byte limit");
    }
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(serialized, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
    await verifyRetainedDirectory(directory, "persist-acp-authority-state");
    await rename(temporaryPath, path);
    published = true;
    await afterRename?.();
    await verifyRetainedDirectory(directory, "persist-acp-authority-state");
    await directory.handle.sync();
  } finally {
    if (!published) {
      await rm(temporaryPath, { force: true });
    }
    await directory.handle.close();
  }
};

const compactRecords = (
  records: readonly AcpPermissionAuthorityRecord[],
  now: number
): readonly AcpPermissionAuthorityRecord[] => {
  const pending = EffectArray.filter(
    records,
    (record) => record.state === "pending"
  );
  const terminal = EffectArray.filter(
    records,
    (record) =>
      record.state !== "pending" &&
      now - record.updatedAt <= ACP_AUTHORITY_TERMINAL_RETENTION_MILLIS
  );
  terminal.sort((left, right) => right.updatedAt - left.updatedAt);
  const retainedTerminal = terminal.slice(0, MAX_TERMINAL_RECORDS);
  const compacted = [
    ...pending.slice(0, ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE),
    ...retainedTerminal,
  ];
  assertAuthorityRecordBounds(compacted);
  return compacted;
};

export const makeAcpAuthorityRepository = Effect.fn(
  "makeAcpAuthorityRepository"
)(function* (options: {
  readonly keyPath: string;
  readonly statePath: string;
  readonly testHooks?: {
    readonly afterStateRename?: () => Promise<void>;
  };
  readonly trustedRoot: string;
}): Effect.fn.Return<AcpAuthorityRepository, HandlerFailure> {
  const key = yield* Effect.tryPromise({
    try: async () => {
      await ensureOwnerOnlyDirectoryTree({
        anchor: options.trustedRoot,
        operation: "prepare-acp-authority",
        target: dirname(options.statePath),
      });
      return await readOwnerOnlyKey(options.keyPath, options.trustedRoot);
    },
    catch: authorityFailure,
  });
  const semaphore = yield* Semaphore.make(1);
  const digest = (namespace: string, value: string): string =>
    createHmac("sha256", key)
      .update(`${namespace}\0`, "utf8")
      .update(value, "utf8")
      .digest("base64url");
  const transact: AcpAuthorityRepository["transact"] = (update) =>
    semaphore.withPermit(
      Effect.tryPromise({
        try: (signal) =>
          withApplicationFileLock(
            {
              signal,
              targetPath: options.statePath,
              trustedRoot: options.trustedRoot,
            },
            async (assertOwned) => {
              await assertOwned();
              const current = await readAuthorityState(
                options.statePath,
                options.trustedRoot
              );
              const [value, records] = update(current.records);
              const compacted = compactRecords(records, Date.now());
              if (
                records !== current.records ||
                compacted !== current.records
              ) {
                await writeAuthorityState(
                  options.statePath,
                  AcpPermissionAuthorityState.make({
                    records: compacted,
                    schemaVersion: AUTHORITY_SCHEMA_VERSION,
                  }),
                  options.trustedRoot,
                  options.testHooks?.afterStateRename
                );
              }
              await assertOwned();
              return value;
            }
          ),
        catch: authorityFailure,
      })
    );
  yield* transact((records) => [undefined, records]);
  return {
    digest,
    load: Effect.tryPromise({
      try: () => readAuthorityState(options.statePath, options.trustedRoot),
      catch: authorityFailure,
    }).pipe(Effect.map((state) => state.records)),
    makeCapability: () => {
      const token = randomBytes(32).toString("base64url");
      return { digest: digest("permission-capability", token), token };
    },
    transact,
  };
});
