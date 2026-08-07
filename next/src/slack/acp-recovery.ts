import { createHash, createHmac } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, open, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Effect, Schema, type Scope } from "effect";
import type { AcpWorkspaceSupervisorHealthSnapshot } from "../acp-conversation-prototype/acp-process-supervisor.ts";
import type { ConversationRecoveryDecisionResult } from "../application.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  assertSafeFilePath,
  assertSafeSocketPath,
} from "../prototype/path-safety.ts";
import { makePrototypeHarness, type Runner } from "../prototype/runtime.ts";
import { makeFileStoreLayer } from "../prototype/store.ts";
import {
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
} from "../reference-coding-application.ts";
import type { SlackRuntimePaths } from "./runtime-paths.ts";

const MAX_INSPECTION_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORITY_KEY_BYTES = 4 * 1024;
const MAX_CORRELATED_IDENTITIES = 64;
const MAX_SOCKET_REQUEST_BYTES = 16 * 1024;

export class AcpRecoveryError extends Schema.TaggedErrorClass<AcpRecoveryError>()(
  "AcpRecoveryError",
  {
    code: Schema.Literals([
      "conflict",
      "invalid-request",
      "not-found",
      "runtime-unavailable",
      "unsafe-runtime",
    ]),
  }
) {}

interface FileRevision {
  readonly digest: string;
  readonly present: boolean;
  readonly stable: boolean;
}

interface ReadRevision extends FileRevision {
  readonly value: unknown;
}

export interface AcpRecoveryInspection {
  readonly attemptDigest: string;
  readonly consistency: "consistent" | "incomplete" | "revision-changed";
  readonly correlations: {
    readonly agentSessionDigest: string | null;
    readonly bindingGeneration: number | null;
    readonly conversationDigest: string;
    readonly executionDigests: readonly string[];
    readonly ownerDigest: string;
    readonly processGeneration: number;
    readonly promptDigest: string;
    readonly streamDigests: readonly string[];
  };
  readonly evidence: {
    readonly action: {
      readonly capabilityCount: number;
      readonly operationCount: number;
    };
    readonly application: {
      readonly decisionCount: number;
      readonly status: string;
    };
    readonly authority: {
      readonly pendingCount: number;
      readonly terminalCount: number;
    };
    readonly execution: {
      readonly count: number;
      readonly nonterminalCount: number;
      readonly unresolvedCount: number;
    };
    readonly process: {
      readonly generation: number | null;
      readonly status: string;
    };
    readonly runner: {
      readonly blockedCount: number;
      readonly queuedCount: number;
    };
    readonly stream: {
      readonly count: number;
      readonly unresolvedCount: number;
    };
  };
  readonly revisions: Readonly<Record<string, FileRevision>>;
  readonly workspaceDigest: string;
}

export interface AcpRecoveryListItem {
  readonly attemptId: string;
  readonly conversationId: string;
  readonly ownerId: string;
  readonly ownerKind: "application-event" | "participant-turn";
  readonly promptId: string;
  readonly status: "blocked";
  readonly workspaceId: string;
}

export interface AcpRecoveryService {
  readonly abandon: (
    attemptId: string,
    decisionId: string
  ) => Effect.Effect<ConversationRecoveryDecisionResult, AcpRecoveryError>;
  readonly health: Effect.Effect<AcpRecoveryHealth, AcpRecoveryError>;
  readonly inspect: (
    attemptId: string
  ) => Effect.Effect<AcpRecoveryInspection, AcpRecoveryError>;
  readonly list: Effect.Effect<
    readonly AcpRecoveryListItem[],
    AcpRecoveryError
  >;
  readonly retry: (
    attemptId: string,
    decisionId: string,
    acknowledgeDuplicateSideEffects: boolean
  ) => Effect.Effect<ConversationRecoveryDecisionResult, AcpRecoveryError>;
}

export interface AcpRecoveryHealth {
  readonly counts: {
    readonly actionUncertain: number;
    readonly blockedPrompts: number;
    readonly executionOutboxBacklog: number;
    readonly executionUncertain: number;
    readonly pendingPermissions: number;
    readonly permissionOutboxBacklog: number;
    readonly queuedInputs: number;
    readonly unresolvedStreams: number;
  };
  readonly readiness:
    | "ready"
    | "setup-incomplete"
    | "config-incompatible"
    | "quarantined"
    | "circuit-open";
  readonly reasonCodes: readonly string[];
  readonly revisions: Readonly<Record<string, FileRevision>>;
  readonly supervisor: {
    readonly activePrompts: number;
    readonly activeSessions: number;
    readonly generation: number | null;
    readonly health: string;
    readonly queuedConversations: number;
  };
  readonly workspaceDigest: string;
}

const safeRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const safeArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const readRevision = async (
  path: string,
  trustedRoot: string
): Promise<ReadRevision> => {
  await assertSafeFilePath({
    anchor: trustedRoot,
    operation: "inspect-acp-recovery",
    path,
  });
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("unsafe inspection source");
    }
    const currentUid = process.getuid?.();
    if (
      before.size > MAX_INSPECTION_FILE_BYTES ||
      (currentUid !== undefined && before.uid !== currentUid)
    ) {
      throw new Error("unsafe inspection source");
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are combined as a bitmask.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    let after: Stats;
    try {
      const buffer = Buffer.allocUnsafe(MAX_INSPECTION_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > MAX_INSPECTION_FILE_BYTES) {
        throw new Error("unsafe inspection source");
      }
      source = buffer.toString("utf8", 0, bytesRead);
      after = await file.stat();
    } finally {
      await file.close();
    }
    const stable =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs;
    return {
      digest: createHash("sha256").update(source, "utf8").digest("base64url"),
      present: true,
      stable,
      value: JSON.parse(source) as unknown,
    };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return { digest: "missing", present: false, stable: true, value: {} };
    }
    throw cause;
  }
};

const readAuthorityKey = async (
  path: string,
  trustedRoot: string
): Promise<Buffer> => {
  await assertSafeFilePath({
    anchor: trustedRoot,
    operation: "inspect-acp-recovery-authority",
    path,
  });
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are combined as a bitmask.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_AUTHORITY_KEY_BYTES ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error("unsafe recovery authority key");
    }
    const key = Buffer.allocUnsafe(MAX_AUTHORITY_KEY_BYTES + 1);
    const { bytesRead } = await file.read(key, 0, key.byteLength, 0);
    if (bytesRead === 0 || bytesRead > MAX_AUTHORITY_KEY_BYTES) {
      throw new Error("unsafe recovery authority key");
    }
    return key.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
};

const digestId = (namespace: string, value: string): string =>
  createHash("sha256")
    .update(`laborer-recovery-inspection-v1\0${namespace}\0`, "utf8")
    .update(value, "utf8")
    .digest("base64url");

const findAttempt = (
  application: unknown,
  attemptId: string
): {
  readonly attempt: Record<string, unknown>;
  readonly conversation: Record<string, unknown>;
  readonly prompt: Record<string, unknown>;
} | null => {
  for (const rawConversation of safeArray(
    safeRecord(application).conversations
  )) {
    const conversation = safeRecord(rawConversation);
    for (const rawPrompt of safeArray(conversation.prompts)) {
      const prompt = safeRecord(rawPrompt);
      for (const rawAttempt of safeArray(prompt.attempts)) {
        const attempt = safeRecord(rawAttempt);
        if (attempt.attemptId === attemptId) {
          return { attempt, conversation, prompt };
        }
      }
    }
  }
  return null;
};

const countByState = (
  values: readonly unknown[],
  predicate: (record: Record<string, unknown>) => boolean
): number => values.map(safeRecord).filter(predicate).length;

const statusOf = (value: unknown): string => {
  const record = safeRecord(value);
  const candidate = record.status ?? record.state ?? record.recoveryClass;
  return typeof candidate === "string" ? candidate : "";
};

const uncertainStatus = (value: unknown): boolean =>
  ["ambiguous", "unknown", "uncertain", "unresolved"].some((marker) =>
    statusOf(value).includes(marker)
  );

const executionIsUnresolved = (value: unknown): boolean => {
  const execution = safeRecord(value);
  if (
    uncertainStatus(execution) ||
    statusOf(execution.attachment) === "unresolved" ||
    execution.recoveryFailure != null
  ) {
    return true;
  }
  return safeArray(execution.prompts).some((promptValue) => {
    const prompt = safeRecord(promptValue);
    return uncertainStatus(prompt) || uncertainStatus(prompt.attempt);
  });
};

const runnerHealthCounts = (runner: unknown) => {
  const state = safeRecord(runner);
  const threads = safeArray(state.threads).map(safeRecord);
  const ownerRecords = threads.flatMap((thread) => [
    ...safeArray(thread.turns),
    ...safeArray(thread.applicationEvents),
  ]);
  return {
    blockedPrompts: countByState(
      ownerRecords,
      (record) => record.status === "blocked"
    ),
    queuedInputs: threads.reduce(
      (count, thread) => count + safeArray(thread.applicationInputQueue).length,
      0
    ),
    unresolvedStreams: safeArray(state.conversationStreams).filter(
      (stream) => safeRecord(stream).lifecycle === "unresolved"
    ).length,
  };
};

const applicationHealthCounts = (application: unknown) => {
  const state = safeRecord(application);
  const conversations = safeArray(state.conversations).map(safeRecord);
  const attempts = conversations.flatMap((conversation) =>
    safeArray(conversation.prompts)
      .map(safeRecord)
      .flatMap((prompt) => safeArray(prompt.attempts))
  );
  const executions = safeArray(state.executions);
  return {
    executionOutboxBacklog: safeArray(state.executionEventOutbox).filter(
      (item) => safeRecord(item).status !== "settled"
    ).length,
    executionUncertain:
      executions.filter(executionIsUnresolved).length +
      attempts.filter(uncertainStatus).length,
  };
};

const emptySupervisorHealth = {
  activePrompts: 0,
  activeSessions: 0,
  generation: null,
  health: "unavailable",
  queuedConversations: 0,
} as const;

const healthSnapshot = async (options: {
  readonly paths: SlackRuntimePaths;
  readonly supervisor?: AcpWorkspaceSupervisorHealthSnapshot;
  readonly workspaceId: string;
}): Promise<AcpRecoveryHealth> => {
  const sources = {
    action: options.paths.acpActionAuthorityState,
    application: options.paths.applicationState,
    authority: options.paths.acpAuthorityState,
    permissionOutbox: options.paths.acpPermissionUiOutbox,
    process: options.paths.acpProcessState,
    runner: options.paths.runnerState,
  } as const;
  const entries = await Promise.all(
    Object.entries(sources).map(async ([name, path]) => {
      try {
        return [name, await readRevision(path, options.paths.root)] as const;
      } catch {
        return [
          name,
          {
            digest: "unavailable",
            present: false,
            stable: false,
            value: {},
          } satisfies ReadRevision,
        ] as const;
      }
    })
  );
  const revisions = Object.fromEntries(entries) as Record<string, ReadRevision>;
  const runner = runnerHealthCounts(revisions.runner?.value);
  const application = applicationHealthCounts(revisions.application?.value);
  const authorityRecords = safeArray(
    safeRecord(revisions.authority?.value).records
  );
  const permissionEntries = safeArray(
    safeRecord(revisions.permissionOutbox?.value).entries
  );
  const actionState = safeRecord(revisions.action?.value);
  const actionRecords = [
    ...safeArray(actionState.capabilities),
    ...safeArray(actionState.operations),
    ...safeArray(actionState.records),
  ];
  const hasUnsafeSource = Object.values(revisions).some(
    (revision) => !revision.stable
  );
  const hasNoCoreState = [
    revisions.application,
    revisions.process,
    revisions.runner,
  ].every((revision) => revision?.present !== true);
  const incomplete =
    hasUnsafeSource || (options.supervisor === undefined && hasNoCoreState);
  const supervisor = options.supervisor;
  const supervisorSummary =
    supervisor === undefined
      ? emptySupervisorHealth
      : {
          activePrompts: supervisor.activePrompts,
          activeSessions: supervisor.activeSessions,
          generation: supervisor.generation,
          health: supervisor.health,
          queuedConversations: supervisor.queuedConversations,
        };
  let readiness: AcpRecoveryHealth["readiness"] = incomplete
    ? "setup-incomplete"
    : "ready";
  if (supervisor?.health === "circuit_open") {
    readiness = "circuit-open";
  } else if (supervisor?.health === "quarantined") {
    readiness = "quarantined";
  } else if (supervisor !== undefined && supervisor.health !== "ready") {
    readiness = "setup-incomplete";
  }
  const reasonCodes = [
    ...(incomplete ? ["state-source-incomplete"] : []),
    ...(readiness === "circuit-open" ? ["supervisor-circuit-open"] : []),
    ...(readiness === "quarantined" ? ["supervisor-quarantined"] : []),
    ...(runner.blockedPrompts > 0 ? ["conversation-prompts-blocked"] : []),
    ...(runner.unresolvedStreams > 0 ? ["slack-streams-unresolved"] : []),
    ...(application.executionUncertain > 0
      ? ["execution-outcome-uncertain"]
      : []),
  ].slice(0, 16);
  return {
    counts: {
      actionUncertain: actionRecords.filter(uncertainStatus).length,
      blockedPrompts: runner.blockedPrompts,
      executionOutboxBacklog: application.executionOutboxBacklog,
      executionUncertain: application.executionUncertain,
      pendingPermissions: countByState(
        authorityRecords,
        (record) => record.state === "pending"
      ),
      permissionOutboxBacklog: permissionEntries.filter(
        (entry) => safeRecord(entry).status !== "permanent-failure"
      ).length,
      queuedInputs: runner.queuedInputs,
      unresolvedStreams: runner.unresolvedStreams,
    },
    readiness,
    reasonCodes,
    revisions: revisionsOnly(revisions),
    supervisor: supervisorSummary,
    workspaceDigest: digestId("workspace", options.workspaceId),
  };
};

export const inspectAcpRecoveryHealthOffline = (options: {
  readonly paths: SlackRuntimePaths;
  readonly workspaceId: string;
}): Promise<AcpRecoveryHealth> => healthSnapshot(options);

const revisionsOnly = (
  values: Readonly<Record<string, ReadRevision>>
): Readonly<Record<string, FileRevision>> =>
  Object.fromEntries(
    Object.entries(values).map(([name, revision]) => [
      name,
      {
        digest: revision.digest,
        present: revision.present,
        stable: revision.stable,
      },
    ])
  );

const inspectSnapshot = async (options: {
  readonly attemptId: string;
  readonly paths: SlackRuntimePaths;
  readonly workspaceId: string;
}): Promise<AcpRecoveryInspection> => {
  const sources = {
    action: options.paths.acpActionAuthorityState,
    application: options.paths.applicationState,
    authority: options.paths.acpAuthorityState,
    process: options.paths.acpProcessState,
    runner: options.paths.runnerState,
  } as const;
  const entries = await Promise.all(
    Object.entries(sources).map(
      async ([name, path]) =>
        [name, await readRevision(path, options.paths.root)] as const
    )
  );
  const revisions = Object.fromEntries(entries) as Record<string, ReadRevision>;
  const applicationRevision = revisions.application;
  const match = findAttempt(applicationRevision?.value, options.attemptId);
  if (match === null) {
    throw AcpRecoveryError.make({ code: "not-found" });
  }
  const application = safeRecord(applicationRevision?.value);
  const runner = safeRecord(revisions.runner?.value);
  const thread = safeArray(runner.threads)
    .map(safeRecord)
    .find((candidate) => candidate.id === match.conversation.conversationId);
  const ownerId = match.prompt.ownerId;
  const ownerKind = match.prompt.ownerKind;
  const ownerBlocked =
    ownerKind === "participant-turn"
      ? safeArray(thread?.turns).map(safeRecord)
      : safeArray(thread?.applicationEvents).map(safeRecord);
  const streams = [
    ...safeArray(runner.conversationStreams),
    ...safeArray(runner.conversationStreamTombstones),
  ].map(safeRecord);
  const correlatedStreams = streams.filter(
    (stream) => stream.ownerId === ownerId && stream.ownerKind === ownerKind
  );
  const authorityRecords = safeArray(
    safeRecord(revisions.authority?.value).records
  );
  const promptId =
    typeof match.prompt.promptId === "string" ? match.prompt.promptId : "";
  let promptDigest = "authority-key-unavailable";
  try {
    const authorityKey = await readAuthorityKey(
      options.paths.acpAuthorityKey,
      options.paths.root
    );
    promptDigest = createHmac("sha256", authorityKey)
      .update("prompt\0", "utf8")
      .update(promptId, "utf8")
      .digest("base64url");
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
  const correlatedAuthorityRecords = authorityRecords.filter(
    (record) => safeRecord(record).promptDigest === promptDigest
  );
  const actionState = safeRecord(revisions.action?.value);
  const actionRecords = [
    ...safeArray(actionState.capabilities),
    ...safeArray(actionState.records),
    ...safeArray(actionState.operations),
  ];
  const correlatedActionRecords = actionRecords.filter(
    (record) => safeRecord(record).promptDigest === promptDigest
  );
  const sessionBinding = safeRecord(match.conversation.agentSessionBinding);
  const sessionId = sessionBinding.sessionId;
  const correlatedExecutions = safeArray(application.executions)
    .map(safeRecord)
    .filter(
      (execution) =>
        execution.conversationId === match.conversation.conversationId
    );
  const processState = safeRecord(revisions.process?.value);
  const allStable = Object.values(revisions).every(
    (revision) => revision.stable
  );
  const allPresent = Object.values(revisions).every(
    (revision) => revision.present
  );
  let consistency: AcpRecoveryInspection["consistency"] = "revision-changed";
  if (allStable) {
    consistency = allPresent ? "consistent" : "incomplete";
  }
  return {
    attemptDigest: digestId("attempt", options.attemptId),
    consistency,
    correlations: {
      agentSessionDigest:
        typeof sessionId === "string"
          ? digestId("agent-session", sessionId)
          : null,
      bindingGeneration:
        typeof match.attempt.bindingGeneration === "number"
          ? match.attempt.bindingGeneration
          : null,
      conversationDigest: digestId(
        "conversation",
        String(match.conversation.conversationId ?? "")
      ),
      executionDigests: correlatedExecutions
        .slice(0, MAX_CORRELATED_IDENTITIES)
        .map((execution) =>
          digestId("execution", String(execution.executionId ?? ""))
        ),
      ownerDigest: digestId("owner", String(ownerId ?? "")),
      processGeneration:
        typeof match.attempt.processGeneration === "number"
          ? match.attempt.processGeneration
          : 0,
      promptDigest,
      streamDigests: correlatedStreams
        .slice(0, MAX_CORRELATED_IDENTITIES)
        .map((stream) => digestId("stream", String(stream.id ?? ""))),
    },
    evidence: {
      action: {
        capabilityCount: countByState(
          correlatedActionRecords,
          (record) => record.state === "active" || record.state === "pending"
        ),
        operationCount: correlatedActionRecords.length,
      },
      application: {
        decisionCount: safeArray(application.recoveryDecisions).filter(
          (decision) => safeRecord(decision).attemptId === options.attemptId
        ).length,
        status:
          typeof match.attempt.recoveryClass === "string"
            ? match.attempt.recoveryClass
            : "unknown",
      },
      authority: {
        pendingCount: countByState(
          correlatedAuthorityRecords,
          (record) => record.state === "pending"
        ),
        terminalCount: countByState(
          correlatedAuthorityRecords,
          (record) => record.state !== "pending"
        ),
      },
      execution: {
        count: correlatedExecutions.length,
        nonterminalCount: correlatedExecutions.filter(
          (execution) =>
            typeof execution.status === "string" &&
            !["cancelled", "completed", "failed"].includes(execution.status)
        ).length,
        unresolvedCount: correlatedExecutions.filter(executionIsUnresolved)
          .length,
      },
      process: {
        generation:
          typeof processState.activeGeneration === "number"
            ? processState.activeGeneration
            : null,
        status:
          typeof processState.health === "string"
            ? processState.health
            : "unknown",
      },
      runner: {
        blockedCount: ownerBlocked.filter((owner) => owner.status === "blocked")
          .length,
        queuedCount: safeArray(thread?.applicationInputQueue).length,
      },
      stream: {
        count: correlatedStreams.length,
        unresolvedCount: correlatedStreams.filter(
          (stream) => stream.lifecycle === "unresolved"
        ).length,
      },
    },
    revisions: revisionsOnly(revisions),
    workspaceDigest: digestId("workspace", options.workspaceId),
  };
};

export const inspectAcpRecoveryOffline = (options: {
  readonly attemptId: string;
  readonly paths: SlackRuntimePaths;
  readonly workspaceId: string;
}): Promise<AcpRecoveryInspection> => inspectSnapshot(options);

const offlineFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "offline recovery runtime cannot execute conversation work",
  });

export const resolveAcpRecoveryOffline = Effect.fn("resolveAcpRecoveryOffline")(
  function* (options: {
    readonly acknowledgeDuplicateSideEffects: boolean;
    readonly attemptId: string;
    readonly decisionId: string;
    readonly kind: "abandon" | "retry";
    readonly paths: SlackRuntimePaths;
    readonly workspaceId: string;
  }): Effect.fn.Return<
    ConversationRecoveryDecisionResult,
    AcpRecoveryError,
    Scope.Scope
  > {
    const repository = yield* makeFileApplicationRepository(
      options.paths.applicationState,
      options.paths.root
    ).pipe(
      Effect.mapError(() => AcpRecoveryError.make({ code: "unsafe-runtime" }))
    );
    const application = yield* makeReferenceCodingApplication({
      conversationAgent: {
        handle: () => offlineFailure(),
        recover: () => offlineFailure(),
        replaceAmbiguousSession: () => Effect.void,
      },
      implementationAgent: { start: () => offlineFailure() },
      repository,
      worktreeManager: { create: () => offlineFailure() },
    }).pipe(
      Effect.mapError(() => AcpRecoveryError.make({ code: "unsafe-runtime" }))
    );
    const harness = yield* makePrototypeHarness({
      application,
      laborerSlackId: "offline-recovery",
      slack: {
        postThreadMessage: () => Effect.never,
        readActivationContext: () => Effect.never,
      },
      storeLayer: makeFileStoreLayer(
        "offline-recovery",
        options.paths.runnerState,
        options.paths.root,
        undefined,
        { initializeNewThreads: false }
      ),
    }).pipe(
      Effect.mapError(() => AcpRecoveryError.make({ code: "unsafe-runtime" }))
    );
    const evidence = yield* (
      harness.runner.listConversationBlocks ?? Effect.succeed([])
    ).pipe(
      Effect.mapError(() => AcpRecoveryError.make({ code: "unsafe-runtime" }))
    );
    const blocked = evidence.find(
      (candidate) =>
        candidate.attemptId === options.attemptId &&
        candidate.workspaceId === options.workspaceId
    );
    if (
      blocked === undefined ||
      application.decideConversationRecovery === undefined
    ) {
      return yield* AcpRecoveryError.make({ code: "not-found" });
    }
    const decision = yield* application
      .decideConversationRecovery({
        acknowledgeDuplicateSideEffects:
          options.acknowledgeDuplicateSideEffects,
        actorUid: process.getuid?.() ?? 0,
        attemptId: blocked.attemptId,
        bindingGeneration: blocked.bindingGeneration,
        conversationId: blocked.conversationId,
        decisionId: options.decisionId,
        kind: options.kind,
        ownerId: blocked.ownerId,
        ownerKind: blocked.ownerKind,
        processGeneration: blocked.processGeneration,
        promptId: blocked.promptId,
        timestamp: Date.now(),
        workspaceId: blocked.workspaceId,
      })
      .pipe(Effect.mapError(() => AcpRecoveryError.make({ code: "conflict" })));
    yield* harness.store
      .resolveConversationBlocked({
        attemptId: decision.attemptId,
        conversationId: decision.conversationId,
        decisionId: decision.decisionId,
        kind: decision.kind,
        ownerId: decision.ownerId,
        ownerKind: decision.ownerKind,
        replacementAttemptId: decision.replacementAttemptId,
        workspaceId: decision.workspaceId,
      })
      .pipe(
        Effect.mapError(() => AcpRecoveryError.make({ code: "unsafe-runtime" }))
      );
    return decision;
  }
);

const mapDecisionError = (): AcpRecoveryError =>
  AcpRecoveryError.make({ code: "conflict" });

export const makeAcpRecoveryService = (options: {
  readonly paths: SlackRuntimePaths;
  readonly runner: Runner;
  readonly supervisorHealth?: Effect.Effect<AcpWorkspaceSupervisorHealthSnapshot>;
  readonly workspaceId: string;
}): AcpRecoveryService => {
  const blocks = options.runner.listConversationBlocks ?? Effect.succeed([]);
  const list = blocks.pipe(
    Effect.map((items) =>
      items
        .filter(
          (item) =>
            item.workspaceId === options.workspaceId && item.decisionId === null
        )
        .map(
          (item): AcpRecoveryListItem => ({
            attemptId: item.attemptId,
            conversationId: item.conversationId,
            ownerId: item.ownerId,
            ownerKind: item.ownerKind,
            promptId: item.promptId,
            status: "blocked",
            workspaceId: item.workspaceId,
          })
        )
    ),
    Effect.mapError(() =>
      AcpRecoveryError.make({ code: "runtime-unavailable" })
    )
  );
  const decide = Effect.fn("AcpRecoveryService.decide")(function* (
    attemptId: string,
    decisionId: string,
    kind: "abandon" | "retry",
    acknowledgeDuplicateSideEffects: boolean
  ) {
    if (
      attemptId.trim().length === 0 ||
      decisionId.trim().length === 0 ||
      (kind === "retry" && acknowledgeDuplicateSideEffects !== true)
    ) {
      return yield* AcpRecoveryError.make({ code: "invalid-request" });
    }
    const decideRecovery = options.runner.decideConversationRecovery;
    if (decideRecovery === undefined) {
      return yield* AcpRecoveryError.make({ code: "not-found" });
    }
    const blocksNow = yield* blocks.pipe(
      Effect.mapError(() =>
        AcpRecoveryError.make({ code: "runtime-unavailable" })
      )
    );
    const blocked = blocksNow.find(
      (item) =>
        item.attemptId === attemptId && item.workspaceId === options.workspaceId
    );
    if (blocked === undefined) {
      return yield* AcpRecoveryError.make({ code: "not-found" });
    }
    return yield* decideRecovery({
      acknowledgeDuplicateSideEffects,
      actorUid: process.getuid?.() ?? 0,
      attemptId: blocked.attemptId,
      bindingGeneration: blocked.bindingGeneration,
      conversationId: blocked.conversationId,
      decisionId,
      kind,
      ownerId: blocked.ownerId,
      ownerKind: blocked.ownerKind,
      processGeneration: blocked.processGeneration,
      promptId: blocked.promptId,
      timestamp: Date.now(),
      workspaceId: blocked.workspaceId,
    }).pipe(Effect.mapError(mapDecisionError));
  });
  const supervisorHealth: Effect.Effect<AcpWorkspaceSupervisorHealthSnapshot | null> =
    options.supervisorHealth === undefined
      ? Effect.succeed(null)
      : Effect.map(
          options.supervisorHealth,
          (health): AcpWorkspaceSupervisorHealthSnapshot | null => health
        );
  return {
    abandon: (attemptId, decisionId) =>
      decide(attemptId, decisionId, "abandon", false),
    inspect: (attemptId) =>
      Effect.tryPromise({
        try: () =>
          inspectSnapshot({
            attemptId,
            paths: options.paths,
            workspaceId: options.workspaceId,
          }),
        catch: (cause) =>
          cause instanceof AcpRecoveryError
            ? cause
            : AcpRecoveryError.make({ code: "unsafe-runtime" }),
      }),
    health: supervisorHealth.pipe(
      Effect.flatMap((supervisor) =>
        Effect.tryPromise({
          try: () =>
            healthSnapshot({
              paths: options.paths,
              ...(supervisor === null ? {} : { supervisor }),
              workspaceId: options.workspaceId,
            }),
          catch: () => AcpRecoveryError.make({ code: "unsafe-runtime" }),
        })
      )
    ),
    list,
    retry: (attemptId, decisionId, acknowledgeDuplicateSideEffects) =>
      decide(attemptId, decisionId, "retry", acknowledgeDuplicateSideEffects),
  };
};

type RecoverySocketRequest =
  | { readonly command: "health" }
  | { readonly command: "list" }
  | { readonly attemptId: string; readonly command: "inspect" }
  | {
      readonly attemptId: string;
      readonly command: "abandon";
      readonly decisionId: string;
    }
  | {
      readonly acknowledgeDuplicateSideEffects: boolean;
      readonly attemptId: string;
      readonly command: "retry";
      readonly decisionId: string;
    };

const nonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const commandUsesAttempt = (
  command: unknown
): command is "abandon" | "inspect" | "retry" =>
  command === "inspect" || command === "abandon" || command === "retry";

const decodeAttemptRecoverySocketRequest = (
  record: Record<string, unknown>
): RecoverySocketRequest | null => {
  if (commandUsesAttempt(record.command) && nonBlank(record.attemptId)) {
    if (record.command === "inspect") {
      return Object.keys(record).length === 2
        ? { attemptId: record.attemptId, command: "inspect" }
        : null;
    }
    if (!nonBlank(record.decisionId)) {
      return null;
    }
    if (record.command === "abandon") {
      return Object.keys(record).length === 3
        ? {
            attemptId: record.attemptId,
            command: "abandon",
            decisionId: record.decisionId,
          }
        : null;
    }
    return record.acknowledgeDuplicateSideEffects === true &&
      Object.keys(record).length === 4
      ? {
          acknowledgeDuplicateSideEffects: true,
          attemptId: record.attemptId,
          command: "retry",
          decisionId: record.decisionId,
        }
      : null;
  }
  return null;
};

const decodeRecoverySocketRequest = (
  value: unknown
): RecoverySocketRequest | null => {
  const record = safeRecord(value);
  const noArgumentRequest =
    (record.command === "health" || record.command === "list") &&
    Object.keys(record).length === 1
      ? ({ command: record.command } as const)
      : null;
  return noArgumentRequest ?? decodeAttemptRecoverySocketRequest(record);
};

const executeSocketRequest = (
  service: AcpRecoveryService,
  request: RecoverySocketRequest
): Effect.Effect<unknown, AcpRecoveryError> => {
  switch (request.command) {
    case "health":
      return service.health;
    case "list":
      return service.list;
    case "inspect":
      return service.inspect(request.attemptId);
    case "abandon":
      return service.abandon(request.attemptId, request.decisionId);
    case "retry":
      return service.retry(
        request.attemptId,
        request.decisionId,
        request.acknowledgeDuplicateSideEffects
      );
    default:
      return AcpRecoveryError.make({ code: "invalid-request" });
  }
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => server.close(() => resolveClose()));

export const startAcpRecoverySocket = Effect.fn("startAcpRecoverySocket")(
  function* (options: {
    readonly path: string;
    readonly service: AcpRecoveryService;
    readonly trustedRoot: string;
  }): Effect.fn.Return<void, AcpRecoveryError, Scope.Scope> {
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await assertSafeSocketPath({
            anchor: options.trustedRoot,
            operation: "start-acp-recovery-socket",
            path: options.path,
          });
          try {
            const stale = await lstat(options.path);
            const currentUid = process.getuid?.();
            if (
              !stale.isSocket() ||
              (currentUid !== undefined && stale.uid !== currentUid)
            ) {
              throw new Error("unsafe recovery socket path");
            }
            await rm(options.path);
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
          const server = createServer((socket: Socket) => {
            let source = "";
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => {
              source += chunk;
              if (
                Buffer.byteLength(source, "utf8") > MAX_SOCKET_REQUEST_BYTES
              ) {
                socket.end(`${JSON.stringify({ error: "invalid-request" })}\n`);
                return;
              }
              const newline = source.indexOf("\n");
              if (newline < 0) {
                return;
              }
              let request: RecoverySocketRequest;
              try {
                const decoded = decodeRecoverySocketRequest(
                  JSON.parse(source.slice(0, newline)) as unknown
                );
                if (decoded === null) {
                  socket.end(
                    `${JSON.stringify({ error: "invalid-request" })}\n`
                  );
                  return;
                }
                request = decoded;
              } catch {
                socket.end(`${JSON.stringify({ error: "invalid-request" })}\n`);
                return;
              }
              run(
                Effect.result(executeSocketRequest(options.service, request))
              ).then((result) => {
                socket.end(
                  `${JSON.stringify(
                    result._tag === "Success"
                      ? { ok: true, result: result.success }
                      : { error: result.failure.code, ok: false }
                  )}\n`
                );
              });
            });
          });
          await new Promise<void>((resolveListen, rejectListen) => {
            server.once("error", rejectListen);
            server.listen(options.path, () => {
              server.removeListener("error", rejectListen);
              resolveListen();
            });
          });
          await chmod(options.path, 0o600);
          return server;
        },
        catch: () => AcpRecoveryError.make({ code: "runtime-unavailable" }),
      }),
      (server) =>
        Effect.promise(async () => {
          await closeServer(server);
          await rm(options.path, { force: true });
        })
    );
  }
);
