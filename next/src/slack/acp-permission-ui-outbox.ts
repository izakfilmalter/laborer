import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema, Semaphore } from "effect";
import { ACP_AUTHORITY_TERMINAL_RETENTION_MILLIS } from "../acp-conversation-prototype/acp-authority.ts";
import type { AcpPermissionCategory } from "../acp-conversation-prototype/acp-permission-broker.ts";
import { withApplicationFileLock } from "../prototype/application-file-lock.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  assertSafeFilePath,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";

const OUTBOX_SCHEMA_VERSION = 3;
const LEGACY_OUTBOX_SCHEMA_VERSION = 2;
const LEGACY_PERMISSION_LIFETIME_MILLIS = 5 * 60 * 1000;
const MAX_OUTBOX_BYTES = 128 * 1024;
const MAX_OUTBOX_RECORDS = 128;
export const ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES = 64;
export const ACP_PERMISSION_UI_RECONCILIATION_RETENTION_MILLIS =
  ACP_AUTHORITY_TERMINAL_RETENTION_MILLIS;
export const ACP_PERMISSION_UI_DIAGNOSTIC_RETENTION_MILLIS =
  ACP_AUTHORITY_TERMINAL_RETENTION_MILLIS;
const OutboxString = Schema.String.check(Schema.isMaxLength(512));

export class AcpPermissionTerminalUpdate extends Schema.Class<AcpPermissionTerminalUpdate>(
  "AcpPermissionTerminalUpdate"
)({
  attempts: Schema.Int,
  authorizedSlackUserId: OutboxString,
  category: Schema.Literals([
    "file edit",
    "file read",
    "guarded tool",
    "network",
    "shell",
  ]),
  channelId: OutboxString,
  createdAt: Schema.Int,
  deadlineAt: Schema.Int,
  diagnostic: Schema.NullOr(OutboxString),
  id: OutboxString,
  messageTs: Schema.NullOr(OutboxString),
  nextAttemptAt: Schema.Int,
  presentationMarker: OutboxString,
  reconciliationExpiresAt: Schema.Int,
  retentionExpiresAt: Schema.Int,
  rootTs: OutboxString,
  state: Schema.NullOr(
    Schema.Literals(["allowed", "cancelled", "expired", "rejected"])
  ),
  status: Schema.Literals([
    "pending",
    "permanent-failure",
    "posting",
    "posting-ambiguous",
  ]),
  workspaceId: OutboxString,
}) {}

class LegacyAcpPermissionTerminalUpdate extends Schema.Class<LegacyAcpPermissionTerminalUpdate>(
  "LegacyAcpPermissionTerminalUpdate"
)({
  attempts: Schema.Int,
  authorizedSlackUserId: OutboxString,
  category: Schema.Literals([
    "file edit",
    "file read",
    "guarded tool",
    "network",
    "shell",
  ]),
  channelId: OutboxString,
  createdAt: Schema.Int,
  deadlineAt: Schema.Int,
  diagnostic: Schema.NullOr(OutboxString),
  id: OutboxString,
  messageTs: Schema.NullOr(OutboxString),
  nextAttemptAt: Schema.Int,
  presentationMarker: OutboxString,
  rootTs: OutboxString,
  state: Schema.NullOr(
    Schema.Literals(["allowed", "cancelled", "expired", "rejected"])
  ),
  status: Schema.Literals([
    "pending",
    "permanent-failure",
    "posting",
    "posting-ambiguous",
  ]),
  workspaceId: OutboxString,
}) {}

class AcpPermissionTerminalOutboxState extends Schema.Class<AcpPermissionTerminalOutboxState>(
  "AcpPermissionTerminalOutboxState"
)({
  entries: Schema.Array(AcpPermissionTerminalUpdate).check(
    Schema.isMaxLength(MAX_OUTBOX_RECORDS)
  ),
  schemaVersion: Schema.Literal(OUTBOX_SCHEMA_VERSION),
}) {}

class LegacyAcpPermissionTerminalOutboxState extends Schema.Class<LegacyAcpPermissionTerminalOutboxState>(
  "LegacyAcpPermissionTerminalOutboxState"
)({
  entries: Schema.Array(LegacyAcpPermissionTerminalUpdate).check(
    Schema.isMaxLength(ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES)
  ),
  schemaVersion: Schema.Literal(LEGACY_OUTBOX_SCHEMA_VERSION),
}) {}

export interface AcpPermissionTerminalOutbox {
  readonly load: Effect.Effect<
    readonly AcpPermissionTerminalUpdate[],
    HandlerFailure
  >;
  readonly remove: (id: string) => Effect.Effect<void, HandlerFailure>;
  readonly upsert: (
    entry: AcpPermissionTerminalUpdate
  ) => Effect.Effect<void, HandlerFailure>;
}

const isUnresolved = (entry: AcpPermissionTerminalUpdate): boolean =>
  entry.status !== "permanent-failure";

const compactExpiredDiagnostics = (
  entries: readonly AcpPermissionTerminalUpdate[],
  now: number
): readonly AcpPermissionTerminalUpdate[] =>
  entries.filter(
    (entry) =>
      entry.status !== "permanent-failure" || entry.retentionExpiresAt > now
  );

const failure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "permission terminal UI outbox is unavailable",
  });

export const ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL =
  "permission UI outbox unresolved capacity exceeded";

const capacityFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL,
  });

const initialState = AcpPermissionTerminalOutboxState.make({
  entries: [],
  schemaVersion: OUTBOX_SCHEMA_VERSION,
});

const migrateLegacyState = (
  state: LegacyAcpPermissionTerminalOutboxState
): AcpPermissionTerminalOutboxState =>
  AcpPermissionTerminalOutboxState.make({
    entries: state.entries.map((entry) => {
      const reconciliationExpiresAt =
        entry.createdAt +
        LEGACY_PERMISSION_LIFETIME_MILLIS +
        ACP_PERMISSION_UI_RECONCILIATION_RETENTION_MILLIS;
      const wasPrematureMissingMarkerFailure =
        entry.messageTs === null &&
        entry.diagnostic === "permission-message-not-found";
      return AcpPermissionTerminalUpdate.make({
        ...entry,
        diagnostic: wasPrematureMissingMarkerFailure ? null : entry.diagnostic,
        reconciliationExpiresAt,
        retentionExpiresAt: reconciliationExpiresAt,
        status: wasPrematureMissingMarkerFailure
          ? "posting-ambiguous"
          : entry.status,
      });
    }),
    schemaVersion: OUTBOX_SCHEMA_VERSION,
  });

const readState = async (
  path: string,
  trustedRoot: string
): Promise<AcpPermissionTerminalOutboxState> => {
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "read-permission-ui-outbox",
      path,
    });
    if ((await stat(path)).size > MAX_OUTBOX_BYTES) {
      throw new Error("permission UI outbox exceeds its byte limit");
    }
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(
        Schema.Union([
          AcpPermissionTerminalOutboxState,
          LegacyAcpPermissionTerminalOutboxState,
        ])
      )(JSON.parse(await readFile(path, "utf8")) as unknown)
    );
    return decoded.schemaVersion === LEGACY_OUTBOX_SCHEMA_VERSION
      ? migrateLegacyState(decoded)
      : decoded;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return initialState;
    }
    throw cause;
  }
};

const writeState = async (
  path: string,
  trustedRoot: string,
  entries: readonly AcpPermissionTerminalUpdate[]
): Promise<void> => {
  const retained = await retainTrustedDirectory(
    dirname(path),
    "persist-permission-ui-outbox"
  );
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "persist-permission-ui-outbox",
      path,
    });
    const serialized = JSON.stringify(
      AcpPermissionTerminalOutboxState.make({
        entries,
        schemaVersion: OUTBOX_SCHEMA_VERSION,
      })
    );
    if (Buffer.byteLength(serialized, "utf8") > MAX_OUTBOX_BYTES) {
      throw new Error("permission UI outbox exceeds its byte limit");
    }
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await verifyRetainedDirectory(retained, "persist-permission-ui-outbox");
    await rename(temporaryPath, path);
    published = true;
    await verifyRetainedDirectory(retained, "persist-permission-ui-outbox");
    await retained.handle.sync();
  } finally {
    if (!published) {
      await rm(temporaryPath, { force: true });
    }
    await retained.handle.close();
  }
};

export const makeAcpPermissionTerminalOutbox = Effect.fn(
  "makeAcpPermissionTerminalOutbox"
)(function* (options: {
  readonly path: string;
  readonly trustedRoot: string;
}): Effect.fn.Return<AcpPermissionTerminalOutbox, HandlerFailure> {
  const semaphore = yield* Semaphore.make(1);
  const transact = <A>(
    update: (
      entries: readonly AcpPermissionTerminalUpdate[]
    ) => readonly [A, readonly AcpPermissionTerminalUpdate[]]
  ): Effect.Effect<A, HandlerFailure> =>
    semaphore.withPermit(
      Effect.tryPromise({
        try: (signal) =>
          withApplicationFileLock(
            {
              signal,
              targetPath: options.path,
              trustedRoot: options.trustedRoot,
            },
            async () => {
              const state = await readState(options.path, options.trustedRoot);
              const [value, updated] = update(state.entries);
              if (updated !== state.entries) {
                await writeState(options.path, options.trustedRoot, updated);
              }
              return value;
            }
          ),
        catch: (cause) => (cause instanceof HandlerFailure ? cause : failure()),
      })
    );
  yield* transact((entries) => [undefined, entries]);
  return {
    load: Effect.tryPromise({
      try: () => readState(options.path, options.trustedRoot),
      catch: failure,
    }).pipe(Effect.map((state) => state.entries)),
    remove: (id) =>
      transact((entries) => [
        undefined,
        entries.some((entry) => entry.id === id)
          ? entries.filter((entry) => entry.id !== id)
          : entries,
      ]),
    upsert: (entry) =>
      transact((entries) => {
        const compacted = compactExpiredDiagnostics(entries, Date.now());
        const existing = compacted.find(
          (candidate) => candidate.id === entry.id
        );
        const withoutCurrent = compacted.filter(
          (candidate) => candidate.id !== entry.id
        );
        const unresolvedCount = withoutCurrent.filter(isUnresolved).length;
        const addsUnresolved =
          isUnresolved(entry) &&
          (existing === undefined || !isUnresolved(existing));
        if (
          addsUnresolved &&
          unresolvedCount >= ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES
        ) {
          throw capacityFailure();
        }
        if (
          existing === undefined &&
          withoutCurrent.length >= MAX_OUTBOX_RECORDS
        ) {
          throw capacityFailure();
        }
        const next = [...withoutCurrent, entry];
        return [undefined, next] as const;
      }),
  };
});

export const makePresentationIntent = (options: {
  readonly authorizedSlackUserId: string;
  readonly category: AcpPermissionCategory;
  readonly channelId: string;
  readonly deadlineAt: number;
  readonly permissionExpiresAt: number;
  readonly presentationMarker: string;
  readonly rootTs: string;
  readonly workspaceId: string;
}): AcpPermissionTerminalUpdate => {
  const now = Date.now();
  return AcpPermissionTerminalUpdate.make({
    attempts: 0,
    authorizedSlackUserId: options.authorizedSlackUserId,
    category: options.category,
    channelId: options.channelId,
    createdAt: now,
    deadlineAt: options.deadlineAt,
    diagnostic: null,
    id: options.presentationMarker,
    messageTs: null,
    nextAttemptAt: now,
    presentationMarker: options.presentationMarker,
    reconciliationExpiresAt:
      options.permissionExpiresAt +
      ACP_PERMISSION_UI_RECONCILIATION_RETENTION_MILLIS,
    retentionExpiresAt:
      options.permissionExpiresAt +
      ACP_PERMISSION_UI_RECONCILIATION_RETENTION_MILLIS,
    rootTs: options.rootTs,
    state: null,
    status: "posting",
    workspaceId: options.workspaceId,
  });
};
