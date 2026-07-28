import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  Effect,
  Array as EffectArray,
  Record as EffectRecord,
  Option,
  pipe,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ExternalInputEvent } from "../application.ts";
import { ThreadId } from "../prototype/domain.ts";

const IMPORT_COMPONENT = "next-json-primary";
const IMPORT_VERSION = 1;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_COUNT = 768;
const MAX_IMPORTED_RECORDS = 32_768;
const MAX_ID_LENGTH = 512;
const MAX_RECORD_BYTES = 1024 * 1024;

const sourceNames = [
  "runner-state.json",
  "application-state.json",
  "acp-authority.json",
  "acp-action-capabilities.json",
  "acp-process-state.json",
  "acp-permission-ui-outbox.json",
] as const;
type SourceName = (typeof sourceNames)[number];

const compatibleSourceVersions: Readonly<
  Record<SourceName, ReadonlySet<number>>
> = {
  "acp-action-capabilities.json": new Set([1]),
  "acp-authority.json": new Set([1]),
  "acp-permission-ui-outbox.json": new Set([2, 3]),
  "acp-process-state.json": new Set([1]),
  "application-state.json": new Set([16]),
  "runner-state.json": new Set([1]),
};

interface LegacySource {
  readonly hash: string;
  readonly name: SourceName;
  readonly payload: Record<string, unknown>;
  readonly payloadJson: string;
  readonly workspaceId: string;
}

interface ImportedRecord {
  readonly domain: string;
  readonly payloadJson: string;
  readonly recordId: string;
  readonly sourceHash: string;
  readonly status: string | null;
  readonly workspaceId: string;
}

export class LegacyDurableStateImportError extends Schema.TaggedErrorClass<LegacyDurableStateImportError>()(
  "LegacyDurableStateImportError",
  {
    reason: Schema.Literals([
      "conflicting-sql-state",
      "incompatible-ledger",
      "invalid-source",
      "record-limit",
      "source-limit",
      "unsafe-path",
    ]),
  }
) {}

const importError = (
  reason: LegacyDurableStateImportError["reason"]
): LegacyDurableStateImportError =>
  LegacyDurableStateImportError.make({ reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" &&
    field.length > 0 &&
    field.length <= MAX_ID_LENGTH
    ? field
    : null;
};

const statusField = (value: Record<string, unknown>): string | null => {
  const status = value.status ?? value.state ?? value.lifecycle ?? value.phase;
  return typeof status === "string" && status.length <= 64 ? status : null;
};

const arrayField = (
  value: Record<string, unknown>,
  key: string
): readonly unknown[] => {
  const field = value[key];
  return Array.isArray(field) ? field : [];
};

const validatePersistedPaths = (
  value: unknown,
  depth = 0,
  budget = { records: 0 }
): void => {
  budget.records += 1;
  if (depth > 64 || budget.records > 100_000) {
    throw importError("source-limit");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validatePersistedPaths(item, depth + 1, budget);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, field] of EffectRecord.toEntries(value)) {
    if (
      (key === "workingDirectory" || key === "cwd") &&
      field !== null &&
      (typeof field !== "string" ||
        !isAbsolute(field) ||
        normalize(field) !== field)
    ) {
      throw importError("unsafe-path");
    }
    validatePersistedPaths(field, depth + 1, budget);
  }
};

const validateSourceShape = (source: LegacySource): void => {
  const version = source.payload.schemaVersion;
  if (
    !(
      Number.isSafeInteger(version) &&
      compatibleSourceVersions[source.name].has(Number(version))
    )
  ) {
    throw importError("invalid-source");
  }
  validatePersistedPaths(source.payload);
  if (source.name === "runner-state.json") {
    for (const key of [
      "acknowledgements",
      "completionReactions",
      "conversationStreams",
      "seenEventIds",
      "threads",
    ]) {
      if (!Array.isArray(source.payload[key])) {
        throw importError("invalid-source");
      }
    }
  }
  if (source.name === "application-state.json") {
    for (const key of [
      "actionOperations",
      "conversations",
      "executionEventOutbox",
      "executions",
    ]) {
      if (!Array.isArray(source.payload[key])) {
        throw importError("invalid-source");
      }
    }
  }
  if (
    (source.name === "acp-authority.json" ||
      source.name === "acp-action-capabilities.json") &&
    !Array.isArray(source.payload.records)
  ) {
    throw importError("invalid-source");
  }
  if (
    source.name === "acp-permission-ui-outbox.json" &&
    !Array.isArray(source.payload.entries)
  ) {
    throw importError("invalid-source");
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one auditable boundary owns path, file-identity, bounded-read, decode, and source-schema checks.
async function readSource(
  runtimeRoot: string,
  workspaceId: string,
  path: string,
  name: SourceName,
  unnamespaced = false
): Promise<LegacySource | null> {
  const expected = unnamespaced
    ? resolve(runtimeRoot, name)
    : resolve(
        runtimeRoot,
        "slack-workspaces",
        encodeURIComponent(workspaceId),
        name
      );
  if (resolve(path) !== expected) {
    throw importError("unsafe-path");
  }
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") {
      return null;
    }
    throw importError("unsafe-path");
  }
  const currentUserId = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_SOURCE_BYTES ||
    (currentUserId !== undefined && metadata.uid !== currentUserId) ||
    metadata.mode % 64 !== 0
  ) {
    throw importError(
      metadata.size > MAX_SOURCE_BYTES ? "source-limit" : "unsafe-path"
    );
  }
  let file: Awaited<ReturnType<typeof open>>;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: Node file flags are a bitmask; O_NOFOLLOW closes the lstat/open race.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw importError("unsafe-path");
  }
  try {
    const opened = await file.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw importError("unsafe-path");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await file.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead
      );
      if (read.bytesRead === 0) {
        break;
      }
      bytesRead += read.bytesRead;
    }
    const afterRead = await file.stat();
    if (
      bytesRead !== metadata.size ||
      afterRead.dev !== metadata.dev ||
      afterRead.ino !== metadata.ino ||
      afterRead.size !== metadata.size
    ) {
      throw importError(
        bytesRead > MAX_SOURCE_BYTES || afterRead.size > MAX_SOURCE_BYTES
          ? "source-limit"
          : "unsafe-path"
      );
    }
    const sourceBytes = bytes.subarray(0, bytesRead);
    const payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(
      sourceBytes
    );
    const payload = JSON.parse(payloadJson) as unknown;
    if (!isRecord(payload)) {
      throw importError("invalid-source");
    }
    const source = {
      hash: createHash("sha256")
        .update(name)
        .update("\0")
        .update(sourceBytes)
        .digest("base64url"),
      name,
      payload,
      payloadJson,
      workspaceId,
    } satisfies LegacySource;
    validateSourceShape(source);
    return source;
  } catch (cause) {
    if (cause instanceof LegacyDurableStateImportError) {
      throw cause;
    }
    throw importError("invalid-source");
  } finally {
    await file.close();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: discovery keeps every bounded path and file identity check in one auditable boundary.
async function discoverSources(
  runtimeRoot: string,
  legacyWorkspaceId?: string
): Promise<readonly LegacySource[]> {
  const sources: LegacySource[] = [];
  if (legacyWorkspaceId !== undefined) {
    for (const name of sourceNames) {
      let metadata: Stats;
      try {
        metadata = await lstat(join(runtimeRoot, name));
      } catch (cause) {
        if (isRecord(cause) && cause.code === "ENOENT") {
          continue;
        }
        throw importError("unsafe-path");
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw importError("unsafe-path");
      }
      const source = await readSource(
        runtimeRoot,
        legacyWorkspaceId,
        join(runtimeRoot, name),
        name,
        true
      );
      if (source !== null) {
        sources.push(source);
      }
    }
  }
  const workspaceDirectory = join(runtimeRoot, "slack-workspaces");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(workspaceDirectory, { withFileTypes: true });
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") {
      return sources;
    }
    throw importError("unsafe-path");
  }
  if (entries.length > 128) {
    throw importError("source-limit");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw importError("unsafe-path");
    }
    let workspaceId: string;
    try {
      workspaceId = decodeURIComponent(entry.name);
    } catch {
      throw importError("unsafe-path");
    }
    if (
      workspaceId.length === 0 ||
      workspaceId.length > 256 ||
      encodeURIComponent(workspaceId) !== entry.name
    ) {
      throw importError("unsafe-path");
    }
    const workspacePath = join(workspaceDirectory, entry.name);
    const workspaceMetadata = await lstat(workspacePath);
    if (
      !workspaceMetadata.isDirectory() ||
      workspaceMetadata.isSymbolicLink()
    ) {
      throw importError("unsafe-path");
    }
    for (const name of sourceNames) {
      const source = await readSource(
        runtimeRoot,
        workspaceId,
        join(workspacePath, name),
        name
      );
      if (source !== null) {
        sources.push(source);
      }
    }
  }
  if (sources.length > MAX_SOURCE_COUNT) {
    throw importError("source-limit");
  }
  return sources;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit domain projection preserves the legacy identity map without generic recursive guessing.
function recordsFromSources(
  sources: readonly LegacySource[]
): readonly ImportedRecord[] {
  const records: ImportedRecord[] = [];
  const identities = new Set<string>();
  const add = (
    source: LegacySource,
    domain: string,
    candidate: unknown,
    identityKeys: readonly string[]
  ): void => {
    if (!isRecord(candidate)) {
      throw importError("invalid-source");
    }
    const recordId = pipe(
      identityKeys,
      EffectArray.findFirst((key) => stringField(candidate, key) !== null),
      Option.flatMap((key) => Option.fromNullishOr(stringField(candidate, key)))
    );
    if (Option.isNone(recordId)) {
      throw importError("invalid-source");
    }
    const identity = `${source.workspaceId}\0${domain}\0${recordId.value}`;
    if (identities.has(identity)) {
      throw importError("invalid-source");
    }
    identities.add(identity);
    const payloadJson = JSON.stringify(candidate);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_RECORD_BYTES) {
      throw importError("record-limit");
    }
    records.push({
      domain,
      payloadJson,
      recordId: recordId.value,
      sourceHash: source.hash,
      status: statusField(candidate),
      workspaceId: source.workspaceId,
    });
    if (records.length > MAX_IMPORTED_RECORDS) {
      throw importError("record-limit");
    }
  };

  for (const source of sources) {
    if (source.name === "runner-state.json") {
      for (const threadCandidate of arrayField(source.payload, "threads")) {
        add(source, "runner-thread", threadCandidate, ["id"]);
        if (!isRecord(threadCandidate)) {
          continue;
        }
        for (const turn of arrayField(threadCandidate, "turns")) {
          add(source, "turn", turn, ["id"]);
        }
        for (const event of arrayField(threadCandidate, "applicationEvents")) {
          add(source, "runner-event", event, ["eventId"]);
        }
        for (const item of arrayField(threadCandidate, "outbox")) {
          add(source, "runner-outbox", item, ["id"]);
        }
      }
      for (const stream of arrayField(source.payload, "conversationStreams")) {
        add(source, "stream", stream, ["id"]);
      }
      for (const stream of arrayField(
        source.payload,
        "conversationStreamTombstones"
      )) {
        add(source, "stream-tombstone", stream, ["id"]);
      }
      for (const acknowledgement of arrayField(
        source.payload,
        "acknowledgements"
      )) {
        add(source, "acknowledgement", acknowledgement, ["id"]);
      }
      for (const reaction of arrayField(
        source.payload,
        "completionReactions"
      )) {
        add(source, "completion-reaction", reaction, ["id"]);
      }
    } else if (source.name === "application-state.json") {
      for (const conversationCandidate of arrayField(
        source.payload,
        "conversations"
      )) {
        add(source, "conversation", conversationCandidate, [
          "sessionId",
          "conversationId",
        ]);
        if (!isRecord(conversationCandidate)) {
          continue;
        }
        const binding = conversationCandidate.agentSessionBinding;
        if (binding !== null && binding !== undefined) {
          add(source, "acp-session", binding, ["sessionId"]);
        }
        for (const prompt of arrayField(conversationCandidate, "prompts")) {
          add(source, "conversation-prompt", prompt, ["promptId"]);
        }
      }
      for (const operation of arrayField(source.payload, "actionOperations")) {
        add(source, "action-operation", operation, ["operationId"]);
      }
      for (const operation of arrayField(
        source.payload,
        "actionOperationTombstones"
      )) {
        add(source, "action-operation-tombstone", operation, ["operationId"]);
      }
      for (const executionCandidate of arrayField(
        source.payload,
        "executions"
      )) {
        add(source, "execution", executionCandidate, ["executionId"]);
        if (!isRecord(executionCandidate)) {
          continue;
        }
        for (const event of arrayField(executionCandidate, "events")) {
          add(source, "execution-event", event, ["eventId"]);
        }
        for (const prompt of arrayField(executionCandidate, "prompts")) {
          add(source, "implementation-prompt", prompt, ["promptId"]);
        }
        const cancellation = executionCandidate.cancellation;
        if (cancellation !== null && cancellation !== undefined) {
          add(source, "execution-control", cancellation, ["operationId"]);
        }
      }
      for (const operation of arrayField(
        source.payload,
        "executionPromptOperations"
      )) {
        add(source, "execution-control", operation, ["operationId"]);
      }
      for (const item of arrayField(source.payload, "executionEventOutbox")) {
        add(source, "execution-outbox", item, ["outboxId"]);
      }
      for (const adoption of arrayField(
        source.payload,
        "conversationAdoptions"
      )) {
        add(source, "conversation-adoption", adoption, ["adoptionId"]);
      }
      for (const decision of arrayField(source.payload, "recoveryDecisions")) {
        add(source, "recovery-control", decision, ["decisionId"]);
      }
    } else if (source.name === "acp-authority.json") {
      for (const permission of arrayField(source.payload, "records")) {
        add(source, "permission", permission, ["recordId"]);
      }
    } else if (source.name === "acp-action-capabilities.json") {
      for (const capability of arrayField(source.payload, "records")) {
        add(source, "action-capability", capability, ["recordId"]);
      }
    } else if (source.name === "acp-permission-ui-outbox.json") {
      for (const item of arrayField(source.payload, "entries")) {
        add(source, "permission-outbox", item, ["id"]);
      }
    } else {
      add(source, "acp-process", { ...source.payload, id: "state" }, ["id"]);
    }
  }
  return records;
}

const initializeImportTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS laborer_migration_ledger (
      component TEXT PRIMARY KEY,
      migration_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('empty', 'in_progress', 'completed', 'incompatible')),
      source_fingerprint TEXT,
      source_count INTEGER NOT NULL,
      database_was_empty INTEGER NOT NULL CHECK (database_was_empty IN (0, 1)),
      diagnostic_code TEXT
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS laborer_imported_sources (
      workspace_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, source_name)
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS laborer_imported_durable_records (
      workspace_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      record_id TEXT NOT NULL,
      status TEXT,
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, domain, record_id)
    ) STRICT
  `;
  yield* sql`
    INSERT OR IGNORE INTO laborer_migration_ledger (
      component, migration_version, status, source_count, database_was_empty
    ) VALUES (${IMPORT_COMPONENT}, ${IMPORT_VERSION}, 'empty', 0, 1)
  `;
});

const markIncompatible = (diagnosticCode: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE laborer_migration_ledger
      SET status = 'incompatible', diagnostic_code = ${diagnosticCode}
      WHERE component = ${IMPORT_COMPONENT}
    `;
  }).pipe(Effect.ignore);

export const importExistingDurableState = Effect.fn(
  "importExistingDurableState"
)(function* (
  runtimeRoot: string,
  rootIdentity: string,
  legacyWorkspaceId?: string
) {
  const sql = yield* SqlClient;
  yield* initializeImportTables;
  const ledger = yield* sql<{
    readonly migrationVersion: number;
    readonly status: string;
  }>`
      SELECT migration_version AS migrationVersion, status
      FROM laborer_migration_ledger
      WHERE component = ${IMPORT_COMPONENT}
    `;
  const receipt = ledger[0];
  if (receipt?.migrationVersion !== IMPORT_VERSION) {
    yield* markIncompatible("incompatible-ledger");
    return yield* importError("incompatible-ledger");
  }
  if (receipt.status === "completed") {
    return;
  }
  if (receipt.status === "incompatible") {
    return yield* importError("incompatible-ledger");
  }
  yield* sql`
      UPDATE laborer_migration_ledger
      SET status = 'in_progress', diagnostic_code = NULL
      WHERE component = ${IMPORT_COMPONENT}
    `;

  const prepared = yield* Effect.tryPromise({
    try: async () => {
      const sources = await discoverSources(runtimeRoot, legacyWorkspaceId);
      const records = recordsFromSources(sources);
      return { records, sources };
    },
    catch: (cause) =>
      cause instanceof LegacyDurableStateImportError
        ? cause
        : importError("invalid-source"),
  }).pipe(Effect.tapError((error) => markIncompatible(error.reason)));
  const existing = yield* sql<{ readonly count: number }>`
      SELECT
        (SELECT COUNT(*) FROM laborer_conversations) +
        (SELECT COUNT(*) FROM laborer_conversation_events) +
        (SELECT COUNT(*) FROM laborer_executions) +
        (SELECT COUNT(*) FROM laborer_execution_events) +
        (SELECT COUNT(*) FROM laborer_execution_controls) +
        (SELECT COUNT(*) FROM laborer_execution_outbox) +
        (SELECT COUNT(*) FROM laborer_runtime_metadata) +
        (SELECT COUNT(*) FROM laborer_imported_sources) +
        (SELECT COUNT(*) FROM laborer_imported_durable_records) AS count
    `;
  if ((existing[0]?.count ?? 1) !== 0) {
    yield* markIncompatible("conflicting-sql-state");
    return yield* importError("conflicting-sql-state");
  }
  const fingerprint = createHash("sha256");
  for (const source of prepared.sources) {
    fingerprint
      .update(source.workspaceId)
      .update("\0")
      .update(source.name)
      .update("\0")
      .update(source.hash)
      .update("\0");
  }
  yield* sql
    .withTransaction(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction is the visibility boundary for sources, identities, Conversations, pending events, and the receipt.
      Effect.gen(function* () {
        yield* sql`DELETE FROM laborer_imported_sources`;
        yield* sql`DELETE FROM laborer_imported_durable_records`;
        for (const source of prepared.sources) {
          yield* sql`
            INSERT INTO laborer_imported_sources (
              workspace_id, source_name, source_hash, schema_version, payload_json
            ) VALUES (
              ${source.workspaceId}, ${source.name}, ${source.hash},
              ${Number(source.payload.schemaVersion)}, ${source.payloadJson}
            )
          `;
        }
        for (const record of prepared.records) {
          yield* sql`
            INSERT INTO laborer_imported_durable_records (
              workspace_id, domain, record_id, status, source_hash, payload_json
            ) VALUES (
              ${record.workspaceId}, ${record.domain}, ${record.recordId},
              ${record.status}, ${record.sourceHash}, ${record.payloadJson}
            )
          `;
        }
        for (const source of prepared.sources) {
          if (source.name !== "application-state.json") {
            continue;
          }
          for (const candidate of arrayField(source.payload, "conversations")) {
            if (!isRecord(candidate)) {
              return yield* importError("invalid-source");
            }
            const conversationId = stringField(candidate, "conversationId");
            if (conversationId === null) {
              return yield* importError("invalid-source");
            }
            const sessionId = `conversation:${createHash("sha256")
              .update("laborer-conversation-session-v1\0", "utf8")
              .update(rootIdentity, "utf8")
              .update("\0", "utf8")
              .update(source.workspaceId, "utf8")
              .update("\0", "utf8")
              .update(conversationId, "utf8")
              .digest("base64url")}`;
            yield* sql`
              INSERT INTO laborer_conversations (conversation_id, workspace_id, session_id)
              VALUES (${conversationId}, ${source.workspaceId}, ${sessionId})
            `;
          }
        }
        for (const source of prepared.sources) {
          if (source.name !== "runner-state.json") {
            continue;
          }
          for (const threadCandidate of arrayField(source.payload, "threads")) {
            if (!isRecord(threadCandidate)) {
              return yield* importError("invalid-source");
            }
            const conversationId = stringField(threadCandidate, "id");
            if (conversationId === null) {
              return yield* importError("invalid-source");
            }
            let sequence = 0;
            for (const eventCandidate of arrayField(
              threadCandidate,
              "applicationEvents"
            )) {
              if (!isRecord(eventCandidate)) {
                return yield* importError("invalid-source");
              }
              const eventId = stringField(eventCandidate, "eventId");
              const sourceName = stringField(eventCandidate, "source");
              const eventStatus = statusField(eventCandidate);
              if (eventStatus === "completed" || eventStatus === "failed") {
                continue;
              }
              if (
                eventId === null ||
                sourceName === null ||
                !("payload" in eventCandidate)
              ) {
                return yield* importError("invalid-source");
              }
              sequence += 1;
              const event = ExternalInputEvent.make({
                conversationId: ThreadId.make(conversationId),
                eventId,
                payload: eventCandidate.payload,
                source: sourceName,
              });
              const eventJson = JSON.stringify(event);
              if (Buffer.byteLength(eventJson, "utf8") > 64 * 1024) {
                return yield* importError("record-limit");
              }
              const requestHash = createHash("sha256")
                .update("laborer-conversation-request-v1\0", "utf8")
                .update(eventJson, "utf8")
                .digest("base64url");
              yield* sql`
                INSERT INTO laborer_conversation_events (
                  event_id, conversation_id, workspace_id, sequence,
                  request_hash, event_json, status, outputs_json
                ) VALUES (
                  ${eventId}, ${conversationId}, ${source.workspaceId},
                  ${sequence}, ${requestHash}, ${eventJson}, 'accepted', NULL
                )
              `;
            }
          }
        }
        yield* sql`
          UPDATE laborer_migration_ledger
          SET status = 'completed', source_fingerprint = ${fingerprint.digest("base64url")},
            source_count = ${prepared.sources.length}, database_was_empty = 1,
            diagnostic_code = NULL
          WHERE component = ${IMPORT_COMPONENT}
        `;
      })
    )
    .pipe(
      Effect.tapError(() => markIncompatible("conflicting-sql-state")),
      Effect.mapError(() => importError("conflicting-sql-state"))
    );
});

export const legacyRuntimeRootForDatabase = (databasePath: string): string =>
  dirname(resolve(databasePath));
