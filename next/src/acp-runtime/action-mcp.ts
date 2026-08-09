import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import type {
  McpServerStdio,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  Deferred,
  Effect,
  FiberSet,
  Schema,
  type Scope,
  Semaphore,
} from "effect";
import {
  actionDefinition,
  actionInputHash,
  productionActionCatalog,
} from "../action-catalog.ts";
import type { RegisteredActionCatalog } from "../durable-runtime/action.ts";
import {
  CancelExecutionResult,
  executionCancelOperationId,
  executionControlDefinition,
  InspectExecutionsResult,
  PromptExecutionControlResult,
  productionExecutionControlCatalog,
} from "../execution-control-catalog.ts";
import {
  makeGeneratedMutationCatalog,
  productionGeneratedMutationCatalog,
} from "../generated-mutation-catalog.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  assertSafeFilePath,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";
import type {
  ConversationAction,
  ConversationExecutionControl,
  TrustedActionInvocation,
  TrustedExecutionControlInvocation,
} from "../reference-coding-application.ts";
import type { AcpAuthorityRepository, AcpTurnScope } from "./acp-authority.ts";
import {
  laborerMcpEnvironmentIsScrubbed,
  laborerMcpServerLauncherArgs,
} from "./mcp-server-launcher-config.ts";

export const LABORER_ACTION_MCP_SERVER_NAME = "laborer-actions";
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_CAPABILITIES = 256;
const CAPABILITY_TTL_MILLIS = 2 * 60 * 1000;
const ACTIVE_CALL_DRAIN_MILLIS = 5000;
const READINESS_MILLIS = 5000;
const ACTION_CORRELATION_WAIT_MILLIS = 250;
const MAX_IN_FLIGHT_ACTION_OPERATIONS = 32;
const MAX_ACTION_WAITERS_PER_OPERATION = 256;
const MAX_ACTION_WAITERS_PER_WORKSPACE = 512;

const positiveTestLimit = (
  value: number | undefined,
  fallback: number
): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const ActionCapabilityState = Schema.Literals([
  "pending",
  "authorized",
  "consumed",
  "revoked",
]);

const PersistedActionResult = Schema.Struct({
  actionName: Schema.NonEmptyString,
  deduplicated: Schema.Boolean,
  executionId: Schema.NonEmptyString,
  status: Schema.Literals([
    "starting",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
});
const PersistedActionCapabilityResult = Schema.Union([
  PersistedActionResult,
  CancelExecutionResult,
  InspectExecutionsResult,
  PromptExecutionControlResult,
]);

class PersistedActionCapability extends Schema.Class<PersistedActionCapability>(
  "PersistedActionCapability"
)({
  actionDigest: Schema.NonEmptyString,
  actionServerGeneration: Schema.Int,
  bindingGeneration: Schema.Int,
  capabilityDigest: Schema.NonEmptyString,
  channelDigest: Schema.NonEmptyString,
  conversationDigest: Schema.NonEmptyString,
  expiresAt: Schema.Int,
  failureCode: Schema.NullOr(Schema.NonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  fullToolDigest: Schema.NonEmptyString,
  inputHash: Schema.NonEmptyString,
  issuedAt: Schema.Int,
  operationDigest: Schema.NonEmptyString,
  promptLeaseDigest: Schema.NullOr(Schema.NonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  processGeneration: Schema.Int,
  promptDigest: Schema.NonEmptyString,
  recordId: Schema.NonEmptyString,
  result: Schema.NullOr(PersistedActionCapabilityResult).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  rootAuthorityDigest: Schema.NonEmptyString,
  rootTsDigest: Schema.NonEmptyString,
  sessionDigest: Schema.NonEmptyString,
  sessionRegistrationGeneration: Schema.Int.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  state: ActionCapabilityState,
  toolCallDigest: Schema.NonEmptyString,
  turnDigest: Schema.NonEmptyString,
  workspaceDigest: Schema.NonEmptyString,
}) {}

class ActionCapabilityStateFile extends Schema.Class<ActionCapabilityStateFile>(
  "ActionCapabilityStateFile"
)({
  records: Schema.Array(PersistedActionCapability).check(
    Schema.isMaxLength(MAX_CAPABILITIES)
  ),
  schemaVersion: Schema.Literal(1),
}) {}

interface CapabilityStore {
  readonly transact: <A>(
    update: (
      records: readonly PersistedActionCapability[]
    ) => readonly [A, readonly PersistedActionCapability[]]
  ) => Effect.Effect<A, HandlerFailure>;
}

const bridgeFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const makeCapabilityStore = Effect.fn("makeActionCapabilityStore")(
  function* (options: {
    readonly path: string;
    readonly trustedRoot: string;
  }): Effect.fn.Return<CapabilityStore, HandlerFailure> {
    const gate = yield* Semaphore.make(1);
    const runDecode = Effect.runPromiseWith(yield* Effect.context<never>());
    const read = async (): Promise<ActionCapabilityStateFile> => {
      try {
        await assertSafeFilePath({
          anchor: options.trustedRoot,
          operation: "read-action-capabilities",
          path: options.path,
        });
        const metadata = await lstat(options.path);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) {
          throw new Error("Action capability state is unsafe");
        }
        return await runDecode(
          Schema.decodeUnknownEffect(ActionCapabilityStateFile)(
            JSON.parse(await readFile(options.path, "utf8")) as unknown
          )
        );
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return ActionCapabilityStateFile.make({
            records: [],
            schemaVersion: 1,
          });
        }
        throw cause;
      }
    };
    const write = async (
      records: readonly PersistedActionCapability[]
    ): Promise<void> => {
      const directory = await retainTrustedDirectory(
        dirname(options.path),
        "write-action-capabilities"
      );
      const temporary = `${options.path}.${randomUUID()}.tmp`;
      try {
        await assertSafeFilePath({
          anchor: options.trustedRoot,
          operation: "write-action-capabilities",
          path: options.path,
        });
        const serialized = JSON.stringify(
          ActionCapabilityStateFile.make({ records, schemaVersion: 1 })
        );
        if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
          throw new Error("Action capability state exceeded its limit");
        }
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(serialized, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await verifyRetainedDirectory(directory, "write-action-capabilities");
        await rename(temporary, options.path);
        await chmod(options.path, 0o600);
        await directory.handle.sync();
      } finally {
        await rm(temporary, { force: true });
        await directory.handle.close();
      }
    };
    const transact: CapabilityStore["transact"] = (update) =>
      gate.withPermit(
        Effect.tryPromise({
          try: async () => {
            const current = await read();
            const [value, records] = update(current.records);
            if (records !== current.records) {
              await write(records.slice(-MAX_CAPABILITIES));
            }
            return value;
          },
          catch: () => bridgeFailure("Action capability state is unavailable"),
        })
      );
    yield* transact((records) => [
      undefined,
      records.map((record) =>
        record.state === "pending" ||
        record.state === "authorized" ||
        record.state === "consumed"
          ? PersistedActionCapability.make({ ...record, state: "revoked" })
          : record
      ),
    ]).pipe(Effect.asVoid);
    return { transact };
  }
);

/**
 * MCP tools/call does not carry ACP session identity. This parent-owned lease
 * is therefore the caller-attribution boundary: one workspace prompt installs
 * it, one fully scoped capability binds to it, and prompt cleanup revokes it.
 * The lifetime token never crosses into model input or the MCP request body.
 */
interface ActivePromptLease {
  readonly actionServerGeneration: number;
  readonly actions: ReadonlyMap<string, ConversationAction>;
  readonly bindings: Map<string, ActivePromptLeaseBinding>;
  readonly controls: ReadonlyMap<string, ConversationExecutionControl>;
  readonly lifetimeToken: string;
  readonly rootAuthority: string;
  readonly scope: AcpTurnScope;
  state: "active" | "revoked";
}

interface ActivePromptLeaseBinding {
  readonly actionName: string;
  readonly capabilityRecordId: string;
  capabilityState: LiveCapability["state"];
  readonly expiresAt: number;
  readonly fullToolIdentity: string;
  readonly inputHash: string;
  readonly toolCallId: string;
}

interface LiveCapability {
  readonly actionName: string;
  readonly actionServerGeneration: number;
  readonly expiresAt: number;
  readonly fullToolIdentity: string;
  readonly inputHash: string;
  readonly leaseToken: string;
  readonly operationId: string;
  readonly plaintextToken: string;
  readonly recordId: string;
  readonly schemaFingerprint: string;
  readonly scope: AcpTurnScope;
  state: "authorized" | "consumed" | "pending" | "revoked";
  readonly target: ConversationAction | ConversationExecutionControl;
  readonly toolCallId: string;
}

type ToolCallSessionUpdate = Extract<
  SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" }
>;
type ToolCallProgressSessionUpdate = Extract<
  SessionNotification["update"],
  { readonly sessionUpdate: "tool_call_update" }
>;
type ObservableActionToolCallUpdate =
  | ToolCallProgressSessionUpdate
  | ToolCallSessionUpdate;

export interface PreparedActionMcpRegistration {
  readonly actionServerGeneration: number;
  readonly catalogFingerprint: string;
  readonly server: McpServerStdio;
}

export interface LaborerActionMcpBridge {
  readonly activateTurn: (options: {
    readonly actionServerGeneration: number;
    readonly actions: readonly ConversationAction[];
    readonly controls?: readonly ConversationExecutionControl[];
    readonly scope: AcpTurnScope;
  }) => Effect.Effect<Effect.Effect<void>, HandlerFailure>;
  readonly activeCallCount: Effect.Effect<number>;
  readonly awaitCallsDrained: Effect.Effect<void, HandlerFailure>;
  readonly awaitReadiness: (
    registration: PreparedActionMcpRegistration
  ) => Effect.Effect<readonly string[], HandlerFailure>;
  readonly observeToolCall: (notification: SessionNotification) => void;
  readonly prepareRegistration: Effect.Effect<PreparedActionMcpRegistration>;
  readonly serverName: string;
  readonly tryAuthorizePermission: (
    request: RequestPermissionRequest
  ) => Effect.Effect<RequestPermissionResponse | null>;
}

type BoundedActionResult = typeof PersistedActionCapabilityResult.Type;

interface InFlightActionOperation {
  readonly actionName: string;
  readonly deferred: Deferred.Deferred<BoundedActionResult, HandlerFailure>;
  readonly expiresAt: number;
  readonly inputHash: string;
  readonly operationId: string;
  waiters: number;
}

type SingleFlightClaim =
  | { readonly entry: InFlightActionOperation; readonly role: "owner" }
  | { readonly entry: InFlightActionOperation; readonly role: "waiter" };

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

export const laborerActionMcpServerName = (
  root: string,
  workspaceId: string
): string =>
  `${LABORER_ACTION_MCP_SERVER_NAME}-${createHash("sha256")
    .update(root, "utf8")
    .update("\0", "utf8")
    .update(workspaceId, "utf8")
    .digest("hex")
    .slice(0, 16)}`;

const readBoundedBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_CONTROL_BODY_BYTES) {
      throw new Error("Action control body is oversized");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown
): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body, "utf8"),
    "content-type": "application/json",
  });
  response.end(body);
};

const actionPermission = (serverName: string, actionName: string): string =>
  `${serverName}_${actionName}`;

const pauseForActionCorrelation = (): Effect.Effect<void> =>
  Effect.promise(
    () => new Promise<void>((resolvePause) => setTimeout(resolvePause, 5))
  );

export const makeLaborerActionMcpBridge = Effect.fn(
  "makeLaborerActionMcpBridge"
)(function* (options: {
  /** The validated user-application catalog projected into ACP. */
  readonly actionCatalog?: RegisteredActionCatalog;
  readonly authorityRepository: AcpAuthorityRepository;
  readonly bootstrapPath: string;
  readonly capabilityTtlMillis?: number;
  readonly processGeneration: number;
  readonly root: string;
  readonly rootAuthority: string;
  readonly statePath: string;
  readonly testHooks?: {
    readonly beforeInvokeLeaseValidation?: () => Promise<void>;
    readonly beforeObservationPersist?: () => Promise<void>;
    readonly beforeRunInvocation?: () => Promise<void>;
    readonly currentTimeMillis?: () => number;
    readonly maxInFlightOperations?: number;
    readonly maxWaitersPerOperation?: number;
    readonly maxWaitersPerWorkspace?: number;
  };
  readonly trustedRuntimeRoot: string;
  readonly workspaceId: string;
}): Effect.fn.Return<LaborerActionMcpBridge, HandlerFailure, Scope.Scope> {
  const actionCatalog = options.actionCatalog;
  const actionResultDocument = Schema.toJsonSchemaDocument(
    PersistedActionResult
  );
  const actionResultSchema =
    Object.keys(actionResultDocument.definitions).length === 0
      ? actionResultDocument.schema
      : {
          ...actionResultDocument.schema,
          $defs: actionResultDocument.definitions,
        };
  const actionProjection =
    actionCatalog === undefined
      ? productionActionCatalog
      : {
          fingerprint: actionCatalog.fingerprint,
          tools: actionCatalog.tools.map((tool) => ({
            annotations: tool.annotations,
            description: tool.description,
            inputSchema: tool.inputSchema,
            name: tool.name,
            // The ACP call accepts an Execution immediately. The registered
            // Action's terminal result remains private durable evidence.
            outputSchema: actionResultSchema,
          })),
        };
  const generatedMutationCatalog =
    actionCatalog === undefined
      ? productionGeneratedMutationCatalog
      : makeGeneratedMutationCatalog(actionProjection);
  const registeredActionFor = (name: string) =>
    actionCatalog?.actions.find((candidate) => candidate.name === name);
  const store = yield* makeCapabilityStore({
    path: options.statePath,
    trustedRoot: options.trustedRuntimeRoot,
  });
  const capabilityTtlMillis =
    options.capabilityTtlMillis !== undefined &&
    Number.isSafeInteger(options.capabilityTtlMillis) &&
    options.capabilityTtlMillis > 0
      ? options.capabilityTtlMillis
      : CAPABILITY_TTL_MILLIS;
  const maxInFlightOperations = positiveTestLimit(
    options.testHooks?.maxInFlightOperations,
    MAX_IN_FLIGHT_ACTION_OPERATIONS
  );
  const maxWaitersPerOperation = positiveTestLimit(
    options.testHooks?.maxWaitersPerOperation,
    MAX_ACTION_WAITERS_PER_OPERATION
  );
  const maxWaitersPerWorkspace = positiveTestLimit(
    options.testHooks?.maxWaitersPerWorkspace,
    MAX_ACTION_WAITERS_PER_WORKSPACE
  );
  const currentTimeMillis = options.testHooks?.currentTimeMillis ?? Date.now;
  const bootstrap = randomBytes(32).toString("base64url");
  const catalogPath = `${options.bootstrapPath}.catalog`;
  yield* Effect.tryPromise({
    try: async () => {
      await assertSafeFilePath({
        anchor: options.trustedRuntimeRoot,
        operation: "write-action-bootstrap",
        path: options.bootstrapPath,
      });
      const file = await open(options.bootstrapPath, "w", 0o600);
      try {
        await file.writeFile(bootstrap, "utf8");
        await file.sync();
        await file.chmod(0o600);
      } finally {
        await file.close();
      }
      await assertSafeFilePath({
        anchor: options.trustedRuntimeRoot,
        operation: "write-action-catalog",
        path: catalogPath,
      });
      const catalogFile = await open(catalogPath, "w", 0o600);
      try {
        const serialized = JSON.stringify(generatedMutationCatalog);
        if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
          throw new Error("Action catalog exceeded its limit");
        }
        await catalogFile.writeFile(serialized, "utf8");
        await catalogFile.sync();
        await catalogFile.chmod(0o600);
      } finally {
        await catalogFile.close();
      }
    },
    catch: () => bridgeFailure("Action bootstrap is unavailable"),
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      Promise.all([
        rm(options.bootstrapPath, { force: true }),
        rm(catalogPath, { force: true }),
      ])
    ).pipe(Effect.asVoid)
  );

  const serverName = laborerActionMcpServerName(
    options.root,
    options.workspaceId
  );
  const activePromptLeases = new Map<string, ActivePromptLease>();
  const capabilities = new Map<string, LiveCapability>();
  const toolCalls = new Map<string, LiveCapability>();
  const rejectedToolCalls = new Set<string>();
  const readiness = new Map<
    number,
    Deferred.Deferred<readonly string[], HandlerFailure>
  >();
  const activeCalls = new Set<string>();
  const inFlightOperations = new Map<string, InFlightActionOperation>();
  const invocationAttributionGate = yield* Semaphore.make(1);
  const singleFlightGate = yield* Semaphore.make(1);
  let totalActionWaiters = 0;
  const observationCompletions = new Map<string, Promise<void>>();
  const observationFibers = yield* FiberSet.make<void, never>();
  const runObservation =
    yield* FiberSet.runtimePromise(observationFibers)<never>();
  let acceptingObservations = true;
  const invocationControllers = new Set<AbortController>();
  const registrationGenerations = new Set<number>();
  let nextActionServerGeneration = randomInt(1, 1_000_000_000);
  let currentActionServerGeneration = 0;
  const privateContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(privateContext);

  const updateRecord = (
    capability: LiveCapability,
    state: LiveCapability["state"],
    outcome?: {
      readonly failureCode?: string | null;
      readonly result?: typeof PersistedActionCapabilityResult.Type | null;
    }
  ) =>
    store.transact((records) => [
      undefined,
      records.map((record) =>
        record.recordId === capability.recordId
          ? PersistedActionCapability.make({
              ...record,
              failureCode:
                outcome !== undefined && "failureCode" in outcome
                  ? (outcome.failureCode ?? null)
                  : record.failureCode,
              result:
                outcome !== undefined && "result" in outcome
                  ? (outcome.result ?? null)
                  : record.result,
              state,
            })
          : record
      ),
    ]);

  const sameTurnScope = (left: AcpTurnScope, right: AcpTurnScope): boolean =>
    left.bindingGeneration === right.bindingGeneration &&
    left.channelId === right.channelId &&
    left.conversationId === right.conversationId &&
    left.processGeneration === right.processGeneration &&
    left.promptId === right.promptId &&
    left.rootTs === right.rootTs &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.workspaceId === right.workspaceId;

  const soleActivePromptLease = (): ActivePromptLease | null => {
    const leases = [...activePromptLeases.values()].filter(
      (lease) => lease.state === "active"
    );
    return leases.length === 1 ? (leases[0] ?? null) : null;
  };

  const capabilityMatchesLease = (
    capability: LiveCapability,
    lease: ActivePromptLease
  ): boolean => {
    const binding = lease.bindings.get(capability.recordId);
    return (
      lease.state === "active" &&
      binding !== undefined &&
      capability.leaseToken === lease.lifetimeToken &&
      capability.actionServerGeneration === lease.actionServerGeneration &&
      capability.actionServerGeneration === currentActionServerGeneration &&
      sameTurnScope(capability.scope, lease.scope) &&
      capability.actionName === binding.actionName &&
      capability.recordId === binding.capabilityRecordId &&
      capability.state === binding.capabilityState &&
      capability.expiresAt === binding.expiresAt &&
      capability.expiresAt > currentTimeMillis() &&
      capability.fullToolIdentity === binding.fullToolIdentity &&
      capability.inputHash === binding.inputHash &&
      capability.toolCallId === binding.toolCallId
    );
  };

  const persistedCapabilityMatchesLease = Effect.fnUntraced(function* (
    capability: LiveCapability,
    lease: ActivePromptLease
  ) {
    const record = yield* store.transact((records) => [
      records.find((candidate) => candidate.recordId === capability.recordId) ??
        null,
      records,
    ]);
    if (record === null) {
      return false;
    }
    const digest = options.authorityRepository.digest;
    return (
      record.actionDigest === digest("action-name", capability.actionName) &&
      record.actionServerGeneration === lease.actionServerGeneration &&
      record.bindingGeneration === lease.scope.bindingGeneration &&
      record.capabilityDigest ===
        digest("action-capability", capability.plaintextToken) &&
      record.channelDigest === digest("slack-channel", lease.scope.channelId) &&
      record.conversationDigest ===
        digest("conversation", lease.scope.conversationId) &&
      record.expiresAt === capability.expiresAt &&
      record.fullToolDigest ===
        digest("action-tool", capability.fullToolIdentity) &&
      record.inputHash === capability.inputHash &&
      record.operationDigest ===
        digest("action-operation", capability.operationId) &&
      record.processGeneration === lease.scope.processGeneration &&
      record.promptDigest === digest("prompt", lease.scope.promptId) &&
      record.promptLeaseDigest ===
        digest("action-prompt-lease", lease.lifetimeToken) &&
      record.rootAuthorityDigest ===
        digest("action-root-authority", lease.rootAuthority) &&
      record.rootTsDigest === digest("slack-root", lease.scope.rootTs) &&
      record.sessionDigest === digest("acp-session", lease.scope.sessionId) &&
      record.sessionRegistrationGeneration === lease.actionServerGeneration &&
      record.state === capability.state &&
      record.toolCallDigest === digest("tool-call", capability.toolCallId) &&
      record.turnDigest === digest("turn", lease.scope.turnId) &&
      record.workspaceDigest === digest("workspace", lease.scope.workspaceId)
    );
  });

  const revokeCapability = Effect.fnUntraced(function* (
    capability: LiveCapability
  ) {
    if (capability.state === "revoked") {
      return;
    }
    capability.state = "revoked";
    const lease = activePromptLeases.get(capability.leaseToken);
    const binding = lease?.bindings.get(capability.recordId);
    if (binding !== undefined) {
      binding.capabilityState = "revoked";
    }
    capabilities.delete(capability.plaintextToken);
    toolCalls.delete(`${capability.scope.sessionId}\0${capability.toolCallId}`);
    yield* updateRecord(capability, "revoked").pipe(Effect.ignore);
  });

  const createCapability = Effect.fnUntraced(function* (options_: {
    readonly actionName: string;
    readonly catalogFingerprint: string;
    readonly decodedInput: unknown;
    readonly inputHash: string;
    readonly lease: ActivePromptLease;
    readonly target: ConversationAction | ConversationExecutionControl;
    readonly toolCallId: string;
  }) {
    const scope = options_.lease.scope;
    if (capabilities.size >= MAX_CAPABILITIES) {
      rejectedToolCalls.add(`${scope.sessionId}\0${options_.toolCallId}`);
      return;
    }
    if (
      soleActivePromptLease() !== options_.lease ||
      options_.lease.bindings.size >= MAX_CAPABILITIES ||
      options_.lease.actionServerGeneration !== currentActionServerGeneration
    ) {
      rejectedToolCalls.add(`${scope.sessionId}\0${options_.toolCallId}`);
      return;
    }
    const plaintextToken = randomBytes(32).toString("base64url");
    /**
     * Each accepted turn receives one catalog Action operation slot. Its
     * identity is exclusively Laborer-owned authority: root, workspace,
     * Conversation, turn, Action, and catalog contract. Input is deliberately
     * excluded and is bound separately by inputHash in the durable ledger.
     * Supporting multiple same-Action operations in one turn would require a
     * new trusted Laborer-issued slot identifier, never a model call ordinal.
     */
    const operationId =
      options_.actionName === "cancel-execution" &&
      typeof options_.decodedInput === "object" &&
      options_.decodedInput !== null &&
      "executionId" in options_.decodedInput &&
      typeof options_.decodedInput.executionId === "string"
        ? executionCancelOperationId({
            conversationId: scope.conversationId,
            executionId: options_.decodedInput.executionId,
            workspaceId: scope.workspaceId,
          })
        : `operation:${options.authorityRepository.digest(
            "action-operation-v2",
            canonical({
              actionName: options_.actionName,
              catalogFingerprint: options_.catalogFingerprint,
              conversationId: scope.conversationId,
              rootAuthority: options.rootAuthority,
              turnId: scope.turnId,
              workspaceId: scope.workspaceId,
            })
          )}`;
    const recordId = options.authorityRepository.digest(
      "action-capability-record",
      `${plaintextToken}\0${operationId}`
    );
    const issuedAt = currentTimeMillis();
    const fullToolIdentity = actionPermission(serverName, options_.actionName);
    const capability: LiveCapability = {
      actionName: options_.actionName,
      actionServerGeneration: options_.lease.actionServerGeneration,
      expiresAt: issuedAt + capabilityTtlMillis,
      fullToolIdentity,
      inputHash: options_.inputHash,
      leaseToken: options_.lease.lifetimeToken,
      operationId,
      plaintextToken,
      recordId,
      schemaFingerprint: options_.catalogFingerprint,
      scope,
      state: "pending",
      target: options_.target,
      toolCallId: options_.toolCallId,
    };
    options_.lease.bindings.set(recordId, {
      actionName: options_.actionName,
      capabilityRecordId: recordId,
      capabilityState: "pending",
      expiresAt: capability.expiresAt,
      fullToolIdentity,
      inputHash: options_.inputHash,
      toolCallId: options_.toolCallId,
    });
    const digest = options.authorityRepository.digest;
    const record = PersistedActionCapability.make({
      actionDigest: digest("action-name", options_.actionName),
      actionServerGeneration: options_.lease.actionServerGeneration,
      bindingGeneration: scope.bindingGeneration,
      capabilityDigest: digest("action-capability", plaintextToken),
      channelDigest: digest("slack-channel", scope.channelId),
      conversationDigest: digest("conversation", scope.conversationId),
      expiresAt: capability.expiresAt,
      failureCode: null,
      fullToolDigest: digest("action-tool", fullToolIdentity),
      inputHash: options_.inputHash,
      issuedAt,
      operationDigest: digest("action-operation", operationId),
      processGeneration: scope.processGeneration,
      promptDigest: digest("prompt", scope.promptId),
      promptLeaseDigest: digest(
        "action-prompt-lease",
        options_.lease.lifetimeToken
      ),
      recordId,
      result: null,
      rootAuthorityDigest: digest(
        "action-root-authority",
        options.rootAuthority
      ),
      rootTsDigest: digest("slack-root", scope.rootTs),
      sessionDigest: digest("acp-session", scope.sessionId),
      sessionRegistrationGeneration: options_.lease.actionServerGeneration,
      state: "pending",
      toolCallDigest: digest("tool-call", options_.toolCallId),
      turnDigest: digest("turn", scope.turnId),
      workspaceDigest: digest("workspace", scope.workspaceId),
    });
    const persisted = yield* Effect.result(
      store.transact((records) => [
        undefined,
        [...records.slice(-(MAX_CAPABILITIES - 1)), record],
      ])
    );
    if (persisted._tag === "Failure") {
      options_.lease.bindings.delete(capability.recordId);
      rejectedToolCalls.add(`${scope.sessionId}\0${options_.toolCallId}`);
      return;
    }
    capabilities.set(plaintextToken, capability);
    toolCalls.set(`${scope.sessionId}\0${options_.toolCallId}`, capability);
  });

  const validateInvocationAttribution = Effect.fnUntraced(function* (
    capability: LiveCapability,
    requestGeneration: number
  ) {
    if (options.testHooks?.beforeInvokeLeaseValidation !== undefined) {
      yield* Effect.tryPromise({
        try: options.testHooks.beforeInvokeLeaseValidation,
        catch: () => bridgeFailure("Action invocation attribution failed"),
      });
    }
    const lease = soleActivePromptLease();
    if (
      lease === null ||
      requestGeneration !== currentActionServerGeneration ||
      requestGeneration !== capability.actionServerGeneration ||
      !capabilityMatchesLease(capability, lease)
    ) {
      return false;
    }
    return yield* persistedCapabilityMatchesLease(capability, lease);
  });

  const attachToInFlightOperation = (entry: InFlightActionOperation) =>
    Deferred.await(entry.deferred).pipe(
      Effect.map((result) =>
        entry.actionName === "inspect-executions"
          ? result
          : { ...result, deduplicated: true }
      ),
      Effect.ensuring(
        singleFlightGate.withPermit(
          Effect.sync(() => {
            entry.waiters = Math.max(0, entry.waiters - 1);
            totalActionWaiters = Math.max(0, totalActionWaiters - 1);
          })
        )
      )
    );

  const claimSingleFlight = Effect.fnUntraced(function* (
    capability: LiveCapability
  ) {
    return yield* singleFlightGate.withPermit(
      Effect.gen(function* () {
        const existing = inFlightOperations.get(capability.operationId);
        if (existing !== undefined) {
          if (
            existing.actionName !== capability.actionName ||
            existing.inputHash !== capability.inputHash
          ) {
            return yield* bridgeFailure("Action invocation identity conflicts");
          }
          if (
            existing.waiters >= maxWaitersPerOperation ||
            totalActionWaiters >= maxWaitersPerWorkspace
          ) {
            return yield* bridgeFailure(
              "Action invocation capacity is unavailable"
            );
          }
          existing.waiters += 1;
          totalActionWaiters += 1;
          return {
            entry: existing,
            role: "waiter",
          } satisfies SingleFlightClaim;
        }
        if (inFlightOperations.size >= maxInFlightOperations) {
          return yield* bridgeFailure(
            "Action invocation capacity is unavailable"
          );
        }
        const deferred = yield* Deferred.make<
          BoundedActionResult,
          HandlerFailure
        >();
        const entry: InFlightActionOperation = {
          actionName: capability.actionName,
          deferred,
          expiresAt: capability.expiresAt,
          inputHash: capability.inputHash,
          operationId: capability.operationId,
          waiters: 0,
        };
        inFlightOperations.set(entry.operationId, entry);
        activeCalls.add(entry.operationId);
        return { entry, role: "owner" } satisfies SingleFlightClaim;
      })
    );
  });

  const runSingleFlight = Effect.fnUntraced(function* (
    capability: LiveCapability,
    runInvocation: Effect.Effect<BoundedActionResult, HandlerFailure>
  ) {
    if (options.testHooks?.beforeRunInvocation !== undefined) {
      yield* Effect.tryPromise({
        try: options.testHooks.beforeRunInvocation,
        catch: () => bridgeFailure("Action invocation attribution failed"),
      });
    }
    const remainingMillis = capability.expiresAt - currentTimeMillis();
    if (remainingMillis <= 0) {
      return yield* bridgeFailure("Action invocation attribution is invalid");
    }
    const claim = yield* claimSingleFlight(capability);
    if (claim.role === "waiter") {
      return yield* attachToInFlightOperation(claim.entry);
    }
    const { entry } = claim;
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(
        runInvocation.pipe(
          Effect.timeout(`${remainingMillis} millis`),
          Effect.mapError(() => bridgeFailure("Action invocation failed"))
        )
      ).pipe(
        Effect.onExit((exit) =>
          Deferred.done(entry.deferred, exit).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (inFlightOperations.get(entry.operationId) === entry) {
                  inFlightOperations.delete(entry.operationId);
                }
                activeCalls.delete(entry.operationId);
              })
            )
          )
        )
      )
    );
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single fail-closed decoder for generated Actions and controls.
  const decodeInvocation = Effect.fnUntraced(function* (body: unknown) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return yield* bridgeFailure("Action invocation is invalid");
    }
    const candidate = body as Record<string, unknown>;
    const actionName = candidate.toolName;
    const generation = Number(candidate.serverGeneration);
    if (
      typeof actionName !== "string" ||
      candidate.serverName !== serverName ||
      candidate.catalogFingerprint !== generatedMutationCatalog.fingerprint ||
      !Number.isSafeInteger(generation) ||
      generation !== currentActionServerGeneration ||
      Object.keys(candidate).length !== 5
    ) {
      return yield* bridgeFailure("Action invocation is invalid");
    }
    const registeredAction = registeredActionFor(actionName);
    const productionAction = actionDefinition(actionName);
    const actionExists =
      actionCatalog === undefined
        ? productionAction !== undefined
        : registeredAction !== undefined;
    const control = executionControlDefinition(actionName);
    if (!actionExists && control === undefined) {
      return yield* bridgeFailure("Action invocation is unsupported");
    }
    let decodeInput: Effect.Effect<unknown, HandlerFailure>;
    if (actionExists) {
      decodeInput =
        actionCatalog === undefined
          ? (productionAction as NonNullable<typeof productionAction>)
              .decodeInput(candidate.input)
              .pipe(
                Effect.mapError(() =>
                  bridgeFailure("Action invocation is invalid")
                )
              )
          : (registeredAction as NonNullable<typeof registeredAction>)
              .decodeInput(candidate.input)
              .pipe(
                Effect.mapError(() =>
                  bridgeFailure("Action invocation is invalid")
                )
              );
    } else {
      decodeInput = (control as NonNullable<typeof control>)
        .decodeInput(candidate.input)
        .pipe(
          Effect.mapError(() => bridgeFailure("Action invocation is invalid"))
        );
    }
    const decoded = yield* decodeInput;
    let schemaFingerprint = productionExecutionControlCatalog.fingerprint;
    if (actionExists) {
      schemaFingerprint =
        actionCatalog === undefined
          ? productionActionCatalog.fingerprint
          : (registeredAction?.fingerprint ?? actionCatalog.fingerprint);
    }
    const inputHash = yield* actionInputHash(
      actionName,
      schemaFingerprint,
      decoded
    ).pipe(
      Effect.mapError(() => bridgeFailure("Action invocation is invalid"))
    );
    const decodeResult = (
      result: unknown
    ): Effect.Effect<unknown, HandlerFailure> => {
      if (!actionExists) {
        return (control as NonNullable<typeof control>)
          .decodeResult(result)
          .pipe(
            Effect.mapError(() => bridgeFailure("Action result is invalid"))
          );
      }
      if (actionCatalog === undefined) {
        return (productionAction as NonNullable<typeof productionAction>)
          .decodeResult(result)
          .pipe(
            Effect.mapError(() => bridgeFailure("Action result is invalid"))
          );
      }
      return Schema.decodeUnknownEffect(PersistedActionResult, {
        onExcessProperty: "error",
      })(result).pipe(
        Effect.mapError(() => bridgeFailure("Action result is invalid"))
      );
    };
    const encodeResult = (
      result: unknown
    ): Effect.Effect<unknown, HandlerFailure> => {
      if (!actionExists) {
        return (control as NonNullable<typeof control>)
          .encodeResult(result)
          .pipe(
            Effect.mapError(() => bridgeFailure("Action result is invalid"))
          );
      }
      if (actionCatalog === undefined) {
        return (productionAction as NonNullable<typeof productionAction>)
          .encodeResult(result)
          .pipe(
            Effect.mapError(() => bridgeFailure("Action result is invalid"))
          );
      }
      return Schema.decodeUnknownEffect(PersistedActionResult, {
        onExcessProperty: "error",
      })(result).pipe(
        Effect.mapError(() => bridgeFailure("Action result is invalid"))
      );
    };
    return {
      actionName,
      decoded,
      decodeResult,
      encodeResult,
      generation,
      inputHash,
      schemaFingerprint,
    };
  });

  const correlateInvocationCapability = Effect.fnUntraced(function* (request: {
    readonly actionName: string;
    readonly generation: number;
    readonly inputHash: string;
  }) {
    const matchingCapabilities = (): readonly LiveCapability[] => {
      const lease = soleActivePromptLease();
      if (lease === null) {
        return [];
      }
      return [...capabilities.values()].filter(
        (capability) =>
          (capability.state === "pending" ||
            capability.state === "authorized" ||
            capability.state === "consumed") &&
          capability.leaseToken === lease.lifetimeToken &&
          capability.actionName === request.actionName &&
          capability.actionServerGeneration === request.generation &&
          capability.inputHash === request.inputHash &&
          capability.expiresAt > currentTimeMillis()
      );
    };
    const correlationDeadline = Date.now() + ACTION_CORRELATION_WAIT_MILLIS;
    let matches = matchingCapabilities();
    while (matches.length === 0 && Date.now() < correlationDeadline) {
      const observations = [...observationCompletions.values()];
      if (observations.length > 0) {
        yield* Effect.promise(() => Promise.all(observations)).pipe(
          Effect.asVoid
        );
      } else {
        yield* pauseForActionCorrelation();
      }
      matches = matchingCapabilities();
    }
    const unconsumed = matches.filter(
      (capability) => capability.state !== "consumed"
    );
    if (unconsumed.length === 1) {
      return unconsumed[0] as LiveCapability;
    }
    if (unconsumed.length > 1 || matches.length === 0) {
      return yield* bridgeFailure("Action invocation correlation is ambiguous");
    }
    /**
     * A model may issue the same generated control more than once in one turn.
     * Each observed tool call has its own capability, but an exact retry carries
     * only tool name and input across the MCP child boundary. Once every matching
     * capability is consumed they are intentionally equivalent: the active lease,
     * generation, tool, input hash, and Laborer-issued operation identity match.
     * Select the newest capability so the durable operation can return its
     * existing result instead of turning a safe duplicate into ambiguity.
     */
    const operationId = matches[0]?.operationId;
    if (
      operationId === undefined ||
      matches.some((capability) => capability.operationId !== operationId)
    ) {
      return yield* bridgeFailure("Action invocation correlation is ambiguous");
    }
    const capability = matches.at(-1);
    return yield* capability === undefined
      ? bridgeFailure("Action invocation is unavailable")
      : Effect.succeed(capability);
  });

  const consumeAttributedCapability = Effect.fnUntraced(function* (
    capability: LiveCapability,
    requestGeneration: number
  ) {
    return yield* invocationAttributionGate.withPermit(
      Effect.gen(function* () {
        if (
          !(yield* validateInvocationAttribution(capability, requestGeneration))
        ) {
          return yield* bridgeFailure(
            "Action invocation attribution is invalid"
          );
        }
        if (
          capability.state !== "pending" &&
          capability.state !== "authorized"
        ) {
          return;
        }
        yield* updateRecord(capability, "consumed");
        capability.state = "consumed";
        const lease = activePromptLeases.get(capability.leaseToken);
        const binding = lease?.bindings.get(capability.recordId);
        if (binding !== undefined) {
          binding.capabilityState = "consumed";
        }
      })
    );
  });

  const invoke = Effect.fnUntraced(function* (body: unknown) {
    const request = yield* decodeInvocation(body);
    const capability = yield* correlateInvocationCapability(request);
    yield* consumeAttributedCapability(capability, request.generation);
    const trustedInvocation:
      | TrustedActionInvocation
      | TrustedExecutionControlInvocation = {
      capabilityExpiresAt: capability.expiresAt,
      inputHash: request.inputHash,
      operationId: capability.operationId,
      schemaFingerprint: capability.schemaFingerprint,
    };
    const runInvocation = Effect.gen(function* () {
      const result = yield* capability.target.invoke(
        request.decoded,
        trustedInvocation
      );
      const validatedResult = yield* request.decodeResult(result);
      const boundedResult = yield* request.encodeResult(validatedResult);
      const persistedResult = yield* Schema.decodeUnknownEffect(
        PersistedActionCapabilityResult
      )(boundedResult).pipe(
        Effect.mapError(() => bridgeFailure("Action result is invalid"))
      );
      yield* updateRecord(capability, "consumed", {
        failureCode: null,
        result: persistedResult,
      });
      return persistedResult;
    }).pipe(
      Effect.tapError(() =>
        updateRecord(capability, "consumed", {
          failureCode: "action-invocation-failed",
        }).pipe(Effect.ignore)
      )
    );
    return yield* runSingleFlight(capability, runInvocation);
  });

  const acceptReadiness = async (body: unknown): Promise<void> => {
    if (typeof body !== "object" || body === null) {
      throw new Error("invalid readiness");
    }
    const value = body as Record<string, unknown>;
    const ready = readiness.get(Number(value.serverGeneration));
    const valid =
      ready !== undefined &&
      value.serverName === serverName &&
      value.catalogFingerprint === generatedMutationCatalog.fingerprint &&
      canonical(value.tools) === canonical(generatedMutationCatalog.tools) &&
      Array.isArray(value.environmentNames) &&
      value.environmentNames.every((name) => typeof name === "string") &&
      laborerMcpEnvironmentIsScrubbed(
        "action",
        value.environmentNames as string[]
      );
    if (!valid || ready === undefined) {
      if (ready !== undefined) {
        await runPromise(
          Deferred.fail(ready, bridgeFailure("Action MCP readiness mismatch"))
        );
      }
      throw new Error("readiness mismatch");
    }
    await runPromise(
      Deferred.succeed(ready, value.environmentNames as string[])
    );
  };
  const handleControlRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    if (
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${bootstrap}`
    ) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readBoundedBody(request);
    if (request.url === "/ready") {
      await acceptReadiness(body);
      sendJson(response, 200, { ready: true });
      return;
    }
    if (request.url === "/invoke") {
      const requestLifetime = new AbortController();
      invocationControllers.add(requestLifetime);
      const abortRequest = (): void => requestLifetime.abort();
      const abortClosedResponse = (): void => {
        if (!response.writableEnded) {
          abortRequest();
        }
      };
      request.once("aborted", abortRequest);
      response.once("close", abortClosedResponse);
      try {
        const result = await runPromise(invoke(body), {
          signal: requestLifetime.signal,
        });
        sendJson(response, 200, result);
      } finally {
        invocationControllers.delete(requestLifetime);
        request.off("aborted", abortRequest);
        response.off("close", abortClosedResponse);
      }
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  };
  const controlServer = createServer(async (request, response) => {
    try {
      await handleControlRequest(request, response);
    } catch {
      sendJson(response, 409, { error: "rejected" });
    }
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolveListen, rejectListen) => {
          const onError = (cause: Error): void => rejectListen(cause);
          controlServer.once("error", onError);
          controlServer.listen(0, "127.0.0.1", () => {
            controlServer.off("error", onError);
            resolveListen();
          });
        }),
      catch: () => bridgeFailure("Action control transport failed"),
    }),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolveClose) => {
            controlServer.close(() => resolveClose());
          })
      )
  );
  const address = controlServer.address();
  if (address === null || typeof address === "string") {
    return yield* bridgeFailure("Action control transport is unavailable");
  }
  const controlUrl = `http://127.0.0.1:${address.port}`;

  const prepareRegistration = Effect.gen(function* () {
    nextActionServerGeneration += 1;
    const actionServerGeneration = nextActionServerGeneration;
    const ready = yield* Deferred.make<readonly string[], HandlerFailure>();
    readiness.set(actionServerGeneration, ready);
    return {
      actionServerGeneration,
      catalogFingerprint: generatedMutationCatalog.fingerprint,
      server: {
        args: [...laborerMcpServerLauncherArgs("action")],
        command: process.execPath,
        env: [
          { name: "LABORER_ACTION_CONTROL_URL", value: controlUrl },
          ...(actionCatalog === undefined
            ? []
            : [{ name: "LABORER_ACTION_CATALOG_PATH", value: catalogPath }]),
          {
            name: "LABORER_ACTION_BOOTSTRAP_PATH",
            value: options.bootstrapPath,
          },
          { name: "LABORER_ACTION_SERVER_NAME", value: serverName },
          {
            name: "LABORER_ACTION_SERVER_GENERATION",
            value: String(actionServerGeneration),
          },
        ],
        name: serverName,
      },
    } satisfies PreparedActionMcpRegistration;
  });

  const activateTurn: LaborerActionMcpBridge["activateTurn"] = ({
    actionServerGeneration,
    actions,
    controls = [],
    scope,
  }) => {
    if (
      scope.workspaceId !== options.workspaceId ||
      scope.processGeneration !== options.processGeneration ||
      !registrationGenerations.has(actionServerGeneration) ||
      actionServerGeneration !== currentActionServerGeneration ||
      activePromptLeases.size !== 0 ||
      scope.bindingGeneration < 1 ||
      [
        scope.channelId,
        scope.conversationId,
        scope.promptId,
        scope.rootTs,
        scope.sessionId,
        scope.turnId,
      ].some((value) => value.trim().length === 0)
    ) {
      return bridgeFailure("Action turn authority is invalid");
    }
    const active: ActivePromptLease = {
      actions: new Map(actions.map((action) => [action.name, action])),
      actionServerGeneration,
      bindings: new Map(),
      controls: new Map(controls.map((control) => [control.name, control])),
      lifetimeToken: randomBytes(32).toString("base64url"),
      rootAuthority: options.rootAuthority,
      scope,
      state: "active",
    };
    activePromptLeases.set(active.lifetimeToken, active);
    return Effect.succeed(
      Effect.gen(function* () {
        active.state = "revoked";
        const scoped = [...capabilities.values()].filter(
          (capability) => capability.leaseToken === active.lifetimeToken
        );
        yield* Effect.forEach(scoped, revokeCapability, { discard: true });
        activePromptLeases.delete(active.lifetimeToken);
      })
    );
  };

  const settleObservedToolCall = Effect.fnUntraced(function* (
    notification: SessionNotification
  ) {
    const update = notification.update;
    if (
      update.sessionUpdate !== "tool_call_update" ||
      (update.status !== "completed" && update.status !== "failed")
    ) {
      return false;
    }
    const capability = toolCalls.get(
      `${notification.sessionId}\0${update.toolCallId}`
    );
    if (capability !== undefined && capability.state !== "consumed") {
      yield* revokeCapability(capability);
    }
    return true;
  });

  const recognizedActionFor = (update: ObservableActionToolCallUpdate) => {
    const productionAction = productionActionCatalog.actions.find(
      (candidate) =>
        update.name === actionPermission(serverName, candidate.name) ||
        update.title === actionPermission(serverName, candidate.name)
    );
    const registeredAction = actionCatalog?.actions.find(
      (candidate) =>
        update.name === actionPermission(serverName, candidate.name) ||
        update.title === actionPermission(serverName, candidate.name)
    );
    if (actionCatalog === undefined && productionAction !== undefined) {
      return {
        catalogFingerprint: productionActionCatalog.fingerprint,
        definition: {
          decodeInput: (input: unknown) =>
            productionAction
              .decodeInput(input)
              .pipe(
                Effect.mapError(() => bridgeFailure("Action input is invalid"))
              ),
          name: productionAction.name,
        },
        kind: "action" as const,
      };
    }
    if (actionCatalog !== undefined && registeredAction !== undefined) {
      return {
        catalogFingerprint: registeredAction.fingerprint,
        definition: {
          decodeInput: (input: unknown) =>
            registeredAction
              .decodeInput(input)
              .pipe(
                Effect.mapError(() => bridgeFailure("Action input is invalid"))
              ),
          name: registeredAction.name,
        },
        kind: "action" as const,
      };
    }
    const control = productionExecutionControlCatalog.controls.find(
      (candidate) =>
        update.name === actionPermission(serverName, candidate.name) ||
        update.title === actionPermission(serverName, candidate.name)
    );
    return control === undefined
      ? undefined
      : {
          catalogFingerprint: productionExecutionControlCatalog.fingerprint,
          definition: {
            decodeInput: (input: unknown) =>
              control
                .decodeInput(input)
                .pipe(
                  Effect.mapError(() =>
                    bridgeFailure("Control input is invalid")
                  )
                ),
            name: control.name,
          },
          kind: "control" as const,
        };
  };

  const hasValidToolIdentity = (
    update: ObservableActionToolCallUpdate,
    lease: ActivePromptLease | null,
    actionName: string
  ): boolean =>
    lease !== null &&
    (update.status === "pending" || update.status === "in_progress") &&
    update.kind === "other" &&
    (update.name === actionPermission(serverName, actionName) ||
      update.name === undefined);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Observation validates the complete generation-scoped capability identity before its single authoritative write.
  const observePendingActionToolCall = Effect.fnUntraced(function* (
    notification: SessionNotification,
    update: ObservableActionToolCallUpdate,
    recognizedAction: NonNullable<ReturnType<typeof recognizedActionFor>>
  ) {
    const key = `${notification.sessionId}\0${update.toolCallId}`;
    const lease = soleActivePromptLease();
    if (
      lease?.scope.sessionId !== notification.sessionId ||
      !hasValidToolIdentity(update, lease, recognizedAction.definition.name)
    ) {
      rejectedToolCalls.add(key);
      return;
    }
    if (lease === null) {
      rejectedToolCalls.add(key);
      return;
    }
    const target =
      recognizedAction.kind === "action"
        ? lease.actions.get(recognizedAction.definition.name)
        : lease.controls.get(recognizedAction.definition.name);
    if (target === undefined || update.rawInput === undefined) {
      rejectedToolCalls.add(key);
      return;
    }
    const decoded = yield* Effect.result(
      recognizedAction.definition.decodeInput(update.rawInput)
    );
    if (decoded._tag === "Failure") {
      rejectedToolCalls.add(key);
      return;
    }
    const hash = yield* Effect.result(
      actionInputHash(
        recognizedAction.definition.name,
        recognizedAction.catalogFingerprint,
        decoded.success
      )
    );
    if (hash._tag === "Failure") {
      rejectedToolCalls.add(key);
      return;
    }
    if (options.testHooks?.beforeObservationPersist !== undefined) {
      yield* Effect.tryPromise({
        try: options.testHooks.beforeObservationPersist,
        catch: () => bridgeFailure("Action observation failed"),
      }).pipe(Effect.ignore);
    }
    if (!acceptingObservations) {
      return;
    }
    const existing = toolCalls.get(key);
    if (existing !== undefined) {
      if (
        existing.actionName === recognizedAction.definition.name &&
        existing.inputHash === hash.success &&
        existing.leaseToken === lease.lifetimeToken &&
        existing.state !== "revoked"
      ) {
        return;
      }
      yield* revokeCapability(existing);
      rejectedToolCalls.add(key);
      return;
    }
    rejectedToolCalls.delete(key);
    yield* createCapability({
      actionName: recognizedAction.definition.name,
      catalogFingerprint: recognizedAction.catalogFingerprint,
      decodedInput: decoded.success,
      inputHash: hash.success,
      lease,
      target,
      toolCallId: update.toolCallId,
    });
  });

  const observeToolCallEffect = (notification: SessionNotification) =>
    Effect.gen(function* () {
      if (yield* settleObservedToolCall(notification)) {
        return;
      }
      const update = notification.update;
      const isObservableCall =
        update.sessionUpdate === "tool_call" ||
        (update.sessionUpdate === "tool_call_update" &&
          update.status === "in_progress");
      if (!isObservableCall) {
        return;
      }
      const recognizedAction = recognizedActionFor(update);
      if (recognizedAction === undefined) {
        return;
      }
      yield* observePendingActionToolCall(
        notification,
        update,
        recognizedAction
      );
    }).pipe(Effect.ignore);

  const observeToolCall: LaborerActionMcpBridge["observeToolCall"] = (
    notification
  ) => {
    if (!acceptingObservations) {
      return;
    }
    const update = notification.update;
    const key =
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
        ? `${notification.sessionId}\0${update.toolCallId}`
        : null;
    const completion = runObservation(
      observeToolCallEffect(notification)
    ).catch(() => undefined);
    if (key === null) {
      return;
    }
    const trackedCompletion: Promise<void> = completion.finally(() => {
      if (observationCompletions.get(key) === trackedCompletion) {
        observationCompletions.delete(key);
      }
    });
    observationCompletions.set(key, trackedCompletion);
  };

  const capabilityForPermission = Effect.fnUntraced(function* (
    request: RequestPermissionRequest
  ) {
    const key = `${request.sessionId}\0${request.toolCall.toolCallId}`;
    const permissionUpdate: ToolCallSessionUpdate = {
      ...(request.toolCall.name == null ? {} : { name: request.toolCall.name }),
      ...(request.toolCall.rawInput === undefined
        ? {}
        : { rawInput: request.toolCall.rawInput }),
      kind: request.toolCall.kind ?? "other",
      sessionUpdate: "tool_call",
      status: request.toolCall.status ?? "pending",
      title: request.toolCall.title ?? "",
      toolCallId: request.toolCall.toolCallId,
    };
    const recognizedAction = recognizedActionFor(permissionUpdate);
    let capability = toolCalls.get(key);
    if (capability === undefined && recognizedAction !== undefined) {
      yield* observePendingActionToolCall(
        { sessionId: request.sessionId, update: permissionUpdate },
        permissionUpdate,
        recognizedAction
      );
      capability = toolCalls.get(key);
    }
    const correlationDeadline = Date.now() + ACTION_CORRELATION_WAIT_MILLIS;
    while (
      capability === undefined &&
      recognizedAction !== undefined &&
      Date.now() < correlationDeadline
    ) {
      const observation = observationCompletions.get(key);
      if (observation !== undefined) {
        yield* Effect.promise(() => observation);
      }
      yield* pauseForActionCorrelation();
      capability = toolCalls.get(key);
    }
    return { capability, recognized: recognizedAction !== undefined };
  });

  const permissionInputMatches = Effect.fnUntraced(function* (
    capability: LiveCapability,
    request: RequestPermissionRequest
  ) {
    const rawInput = request.toolCall.rawInput;
    const rawInputIsIncompletePlaceholder =
      typeof rawInput === "object" &&
      rawInput !== null &&
      !Array.isArray(rawInput) &&
      Object.keys(rawInput).length === 0;
    if (rawInputIsIncompletePlaceholder) {
      return true;
    }
    const requestHash = yield* Effect.result(
      actionInputHash(
        capability.actionName,
        capability.schemaFingerprint,
        rawInput
      )
    );
    return (
      requestHash._tag === "Success" &&
      requestHash.success === capability.inputHash
    );
  });

  const permissionCapabilityIsUsable = Effect.fnUntraced(function* (
    capability: LiveCapability | undefined,
    request: RequestPermissionRequest
  ) {
    const lease = soleActivePromptLease();
    if (
      capability === undefined ||
      lease === null ||
      !capabilityMatchesLease(capability, lease) ||
      capability.state !== "pending" ||
      capability.expiresAt <= currentTimeMillis() ||
      request.sessionId !== lease.scope.sessionId ||
      request.toolCall.status !== "pending" ||
      request.toolCall.kind !== "other"
    ) {
      return false;
    }
    return yield* persistedCapabilityMatchesLease(capability, lease).pipe(
      Effect.orElseSucceed(() => false)
    );
  });

  const authorizePermissionCapability = Effect.fnUntraced(function* (
    capability: LiveCapability | undefined,
    request: RequestPermissionRequest
  ) {
    if (
      capability === undefined ||
      !(yield* permissionCapabilityIsUsable(capability, request))
    ) {
      if (capability !== undefined) {
        yield* revokeCapability(capability);
      }
      return { outcome: { outcome: "cancelled" as const } };
    }
    const allow = request.options.find(
      (option) => option.kind === "allow_once"
    );
    if (
      allow === undefined ||
      !(yield* permissionInputMatches(capability, request))
    ) {
      yield* revokeCapability(capability);
      return { outcome: { outcome: "cancelled" as const } };
    }
    const persistedAuthorization = yield* Effect.result(
      updateRecord(capability, "authorized")
    );
    if (persistedAuthorization._tag === "Failure") {
      yield* revokeCapability(capability);
      return { outcome: { outcome: "cancelled" as const } };
    }
    capability.state = "authorized";
    const lease = soleActivePromptLease();
    const binding = lease?.bindings.get(capability.recordId);
    if (binding !== undefined) {
      binding.capabilityState = "authorized";
    }
    return {
      outcome: { optionId: allow.optionId, outcome: "selected" as const },
    };
  });

  const tryAuthorizePermission: LaborerActionMcpBridge["tryAuthorizePermission"] =
    (request) =>
      Effect.gen(function* () {
        const key = `${request.sessionId}\0${request.toolCall.toolCallId}`;
        const observation = observationCompletions.get(key);
        if (observation !== undefined) {
          yield* Effect.promise(() => observation);
        }
        const correlated = yield* capabilityForPermission(request);
        const { capability, recognized } = correlated;
        if (
          !(
            recognized ||
            capability !== undefined ||
            rejectedToolCalls.has(key)
          )
        ) {
          return null;
        }
        rejectedToolCalls.delete(key);
        return yield* authorizePermissionCapability(capability, request);
      });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      acceptingObservations = false;
      yield* FiberSet.clear(observationFibers);
      for (const lease of activePromptLeases.values()) {
        lease.state = "revoked";
      }
      for (const controller of invocationControllers) {
        controller.abort();
      }
      const live = [...capabilities.values()];
      yield* Effect.forEach(live, revokeCapability, { discard: true });
      const inFlight = [...inFlightOperations.values()];
      yield* Effect.forEach(
        inFlight,
        (entry) =>
          Deferred.fail(
            entry.deferred,
            bridgeFailure("Action bridge is shutting down")
          ),
        { discard: true }
      );
      activePromptLeases.clear();
      capabilities.clear();
      inFlightOperations.clear();
      invocationControllers.clear();
      activeCalls.clear();
      totalActionWaiters = 0;
      toolCalls.clear();
      rejectedToolCalls.clear();
      observationCompletions.clear();
      readiness.clear();
      registrationGenerations.clear();
    })
  );

  return {
    activateTurn,
    activeCallCount: Effect.sync(() => activeCalls.size),
    awaitCallsDrained: Effect.gen(function* () {
      const deadline = Date.now() + ACTIVE_CALL_DRAIN_MILLIS;
      while (activeCalls.size > 0 && Date.now() < deadline) {
        yield* Effect.sleep("10 millis");
      }
      if (activeCalls.size > 0) {
        return yield* bridgeFailure("Action calls did not drain");
      }
    }),
    awaitReadiness: (registration) => {
      const ready = readiness.get(registration.actionServerGeneration);
      if (ready === undefined) {
        return bridgeFailure("Action MCP readiness is unavailable");
      }
      return Deferred.await(ready).pipe(
        Effect.timeout(`${READINESS_MILLIS} millis`),
        Effect.mapError((error) =>
          error instanceof HandlerFailure
            ? error
            : bridgeFailure("Action MCP readiness failed")
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            registrationGenerations.add(registration.actionServerGeneration);
            currentActionServerGeneration = Math.max(
              currentActionServerGeneration,
              registration.actionServerGeneration
            );
          })
        ),
        Effect.ensuring(
          Effect.sync(() =>
            readiness.delete(registration.actionServerGeneration)
          )
        )
      );
    },
    observeToolCall,
    prepareRegistration,
    serverName,
    tryAuthorizePermission,
  };
});
