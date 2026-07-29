/** Opt-in ACP stable-v1 conversation-agent proof for issues #234 and #236. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type ActiveSessionMessage,
  type ContentBlock,
  client,
  type McpServerStdio,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Clock, Effect, Exit, Schema, Scope, Semaphore } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import { assertNoSymlinkPathComponents } from "../prototype/path-safety.ts";
import {
  type ProcessTerminationOutcome,
  processSupervisorProxyPath,
  terminateSupervisedProcess,
} from "../prototype/process-supervisor.ts";
import type {
  ConversationAgentRequest,
  ConversationAgentSessionBinding,
  ConversationAgentShape,
  ConversationPromptAttemptOutcome,
  ConversationPromptAttemptStore,
  PublishConversationAgentMessage,
} from "../reference-coding-application.ts";
import type { AcpAuthorityRepository } from "./acp-authority.ts";
import { inventoryAcpConfigSources } from "./acp-config-source-inventory.ts";
import {
  extractAcpEffectiveMetadata,
  type SignedAcpEffectiveMetadata,
  signAcpEffectiveMetadata,
} from "./acp-effective-metadata.ts";
import type { AcpPermissionBroker } from "./acp-permission-broker.ts";
import type {
  LaborerActionMcpBridge,
  PreparedActionMcpRegistration,
} from "./action-mcp.ts";
import {
  type AcpAgentContextSources,
  loadAcpAgentContextSnapshot,
  loadAcpSlackParticipantContexts,
  renderAcpPrompt,
  renderAcpPromptWithinByteLimit,
} from "./agent-context.ts";
import {
  awaitLaborerMemoryMcpReadiness,
  clearLaborerMemoryPermissionRegistration,
  type LaborerMemoryDiagnosticCode,
  type LaborerMemoryPermissionGate,
  type LaborerMemoryPermissionRegistration,
  laborerMemoryMcpAuthority,
  observeLaborerMemoryToolCall,
  type PreparedLaborerMemoryMcpRegistration,
  prepareLaborerMemoryMcpRegistration,
  recordLaborerMemoryDiagnostic,
  recordLaborerMemoryDiagnosticForSources,
  tryAuthorizeLaborerMemoryPermission,
} from "./memory-mcp.ts";
import type { SlackParticipantLookupShape } from "./slack-participant-lookup.ts";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PROMPT_IMAGES = 4;
const MAX_PROMPT_IMAGE_BYTES = 1024 * 1024;
const MAX_PUBLIC_OUTPUT_BYTES = 1024 * 1024;
const MAX_PUBLIC_MESSAGES = 32;
const CHILD_EXIT_GRACE_MILLIS = 2000;
const MEMORY_MCP_ACTIVE_CALL_DRAIN_TIMEOUT_MILLIS = 5000;
const MEMORY_MCP_BOOTSTRAP_SESSION_TIMEOUT_MILLIS = 5000;
const MEMORY_MCP_ACTIVE_CALL_POLL_MILLIS = 10;
const MAX_ACP_NDJSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ACP_INBOUND_PROCESS_BYTES = 256 * 1024 * 1024;
const MAX_ACP_INBOUND_PROCESS_RECORDS = 250_000;
const ACP_INITIALIZE_TIMEOUT_MILLIS = 10_000;
const DEFAULT_PROMPT_DEADLINE_MILLIS = 15 * 60 * 1000;
const MAX_PROMPT_DEADLINE_MILLIS = 60 * 60 * 1000;
const PROMPT_CANCEL_SETTLEMENT_MILLIS = 2000;
const MAX_ACTIVE_SESSIONS = 128;
const MAX_SESSION_UPDATE_QUEUE_RECORDS = 1024;
const MAX_SESSION_UPDATE_QUEUE_BYTES = 4 * 1024 * 1024;
const JSON_RPC_INVALID_PARAMS = -32_602;
const JSON_RPC_INTERNAL_ERROR = -32_603;
const JSON_RPC_RESOURCE_NOT_FOUND = -32_002;
const PROMPT_EPOCH_META_KEY = "laborer.dev/prompt-epoch";
const PROMPT_EPOCH_CAPABILITY_KEY = "laborer.dev/prompt-epoch/v1";
const OPEN_CODE_ORDER_BOUNDARY_META_KEY = "laborer.dev/opencode-order-boundary";
const OPEN_CODE_MESSAGE_ID_PATTERN = /^msg_([\dA-Fa-f]{12})[\dA-Za-z]{14}$/;
const OPEN_CODE_ORDER_MODULUS = 281_474_976_710_656n;
const OPEN_CODE_SUPPORTED_VERSIONS = new Set(["1.18.4"]);
const OPEN_CODE_BOUNDARY_WAIT_MILLIS = 25;
const OPEN_CODE_SESSION_LIST_MAX_PAGES = 100;
const PROMPT_EPOCH_MARKER_TIMEOUT_MILLIS = 5000;
const PROMPT_EPOCH_POST_RESPONSE_GRACE_MILLIS = 2000;
const NEWLINE_BYTE = 0x0a;
const MAX_PROCESS_SUPERVISOR_REPORT_BYTES = 1024;
const SILENT_CONVERSATION_REPLY_TOKEN = "NO_REPLY";
const textEncoder = new TextEncoder();

class AcpConversationFailure extends Schema.TaggedErrorClass<AcpConversationFailure>()(
  "AcpConversationFailure",
  {
    operation: Schema.Literals(["initialize", "prompt", "session", "spawn"]),
  }
) {}

class AcpDurableSessionUnavailable extends Schema.TaggedErrorClass<AcpDurableSessionUnavailable>()(
  "AcpDurableSessionUnavailable",
  {}
) {}

class AcpPromptProtocolRejected extends Schema.TaggedErrorClass<AcpPromptProtocolRejected>()(
  "AcpPromptProtocolRejected",
  {}
) {}

class AcpUnknownPromptStop extends Schema.TaggedErrorClass<AcpUnknownPromptStop>()(
  "AcpUnknownPromptStop",
  {}
) {}

const promptUpdateFailure = (
  cause: unknown
):
  | AcpUnknownPromptStop
  | AcpPromptProtocolRejected
  | AcpConversationFailure => {
  if (
    cause instanceof AcpUnknownPromptStop ||
    cause instanceof AcpPromptProtocolRejected
  ) {
    return cause;
  }
  return cause instanceof RequestError
    ? AcpPromptProtocolRejected.make()
    : failure("prompt");
};

const promptCompletionFailure = (
  cause: unknown,
  runtimeIncompatibilityObserved: boolean
): unknown => {
  if (runtimeIncompatibilityObserved) {
    return AcpPromptProtocolRejected.make();
  }
  return cause instanceof RequestError ? AcpUnknownPromptStop.make() : cause;
};

export interface AcpConversationAgentOptions {
  readonly actionMcpBridge?: LaborerActionMcpBridge;
  readonly agentContext?: AcpAgentContextSources;
  readonly args?: readonly string[];
  readonly authorityRepository?: AcpAuthorityRepository;
  readonly childExitGraceMillis?: number;
  readonly command: string;
  readonly cwd: string;
  /** Skip #240's eager probe; durable new/resume requests verify memory directly. */
  readonly durableSessionMode?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly imageStorageRoot?: string;
  readonly inboundLimits?: {
    readonly maxLineBytes?: number;
    readonly maxProcessBytes?: number;
    readonly maxProcessRecords?: number;
  };
  readonly initializeTimeoutMillis?: number;
  readonly laborerSlackId?: string;
  readonly memoryMcpActiveCallDrainTimeoutMillis?: number;
  readonly memoryMcpBootstrapTimeoutMillis?: number;
  readonly memoryMcpServer?: McpServerStdio;
  readonly participantLookup?: SlackParticipantLookupShape;
  readonly permissionBroker?: AcpPermissionBroker;
  readonly processCleanupObserver?: (
    outcome: ProcessTerminationOutcome | "failed"
  ) => void;
  readonly processExitObserver?: (
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void;
  readonly processFailureObserver?: (
    classification: "deterministic" | "transient",
    cause:
      | "initialization_failed"
      | "protocol_incompatible"
      | "readiness_failed"
      | "spawn_failed"
      | "transport_lost"
  ) => void;
  readonly processGeneration?: number;
  readonly processHealthObserver?: (
    health: AcpConversationProcessHealth
  ) => void;
  readonly promptDeadlineMillis?: number;
  readonly requireDurableCapabilitiesAtStartup?: boolean;
  readonly testHooks?: {
    readonly activeSessionLimit?: number;
    readonly afterDurableBindingPersisted?: () => Promise<void>;
    readonly afterProcessPoisoned?: () => Promise<void>;
    readonly afterTerminalCommit?: () => Promise<void>;
    readonly beforeDurableBindingPersist?: () => Promise<void>;
    readonly beforePromptSubmission?: () => Promise<void>;
    readonly beforeTerminalCommit?: () => Promise<void>;
    readonly treatCommandAsOpenCode?: boolean;
  };
}

export interface AcpConversationProcessHealth {
  readonly generation: number;
  readonly status: "closed" | "quarantined" | "ready" | "starting";
}

const observeProcessHealth = (
  options: AcpConversationAgentOptions,
  status: AcpConversationProcessHealth["status"]
): void => {
  try {
    options.processHealthObserver?.({
      generation: options.processGeneration ?? 1,
      status,
    });
  } catch {
    // Health observation is diagnostic and cannot own the ACP lifecycle.
  }
};

const observeProcessFailure = (
  options: AcpConversationAgentOptions,
  classification: "deterministic" | "transient",
  cause:
    | "initialization_failed"
    | "protocol_incompatible"
    | "readiness_failed"
    | "spawn_failed"
    | "transport_lost"
): void => {
  try {
    options.processFailureObserver?.(classification, cause);
  } catch {
    // Failure classification is bounded supervisor metadata only.
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ProcessSupervisorReport {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const parseProcessSupervisorReport = (
  source: string
): ProcessSupervisorReport | null => {
  try {
    const value = JSON.parse(source) as unknown;
    if (!isRecord(value)) {
      return null;
    }
    const code = value.code;
    const signal = value.signal;
    if (
      (code !== null &&
        (typeof code !== "number" || !Number.isSafeInteger(code))) ||
      (signal !== null &&
        (typeof signal !== "string" || !signal.startsWith("SIG")))
    ) {
      return null;
    }
    return {
      code,
      signal: signal as NodeJS.Signals | null,
    };
  } catch {
    return null;
  }
};

const awaitProcessSupervisorReport = (
  control: Readable
): Promise<ProcessSupervisorReport | null> =>
  new Promise((resolveReport) => {
    let reportSource = "";
    let settled = false;
    const settle = (report: ProcessSupervisorReport | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      control.off("data", onData);
      resolveReport(report);
    };
    const onData = (chunk: Buffer | string): void => {
      reportSource += chunk.toString();
      if (
        Buffer.byteLength(reportSource, "utf8") >
        MAX_PROCESS_SUPERVISOR_REPORT_BYTES
      ) {
        settle(null);
        return;
      }
      const lineEnd = reportSource.indexOf("\n");
      if (lineEnd >= 0) {
        settle(parseProcessSupervisorReport(reportSource.slice(0, lineEnd)));
      }
    };
    control.on("data", onData);
    control.once("end", () =>
      settle(parseProcessSupervisorReport(reportSource.trim()))
    );
    control.once("error", () => settle(null));
  });

const openCodeMessageOrder = (update: SessionUpdate): bigint | null => {
  if (
    update.sessionUpdate !== "agent_message_chunk" ||
    typeof update.messageId !== "string"
  ) {
    return null;
  }
  const encodedOrder = OPEN_CODE_MESSAGE_ID_PATTERN.exec(update.messageId)?.[1];
  if (encodedOrder === undefined) {
    return null;
  }
  return BigInt(`0x${encodedOrder}`);
};

const nextOpenCodeOrderBoundary = async (): Promise<bigint> => {
  const startingMillis = Date.now();
  const deadline = startingMillis + OPEN_CODE_BOUNDARY_WAIT_MILLIS;
  while (Date.now() <= startingMillis) {
    if (Date.now() >= deadline) {
      throw new Error("OpenCode prompt boundary clock did not advance");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  return (BigInt(Date.now()) * 0x1000n - 1n) % OPEN_CODE_ORDER_MODULUS;
};

const carriesPromptEpoch = (update: SessionUpdate, epoch: string): boolean =>
  isRecord(update._meta) && update._meta[PROMPT_EPOCH_META_KEY] === epoch;

const isSettledTextlessOpenCodeResponse = (response: PromptResponse): boolean =>
  response.stopReason === "end_turn" ||
  response.stopReason === "max_tokens" ||
  response.stopReason === "refusal" ||
  response.stopReason === "cancelled";

const isDurableSessionUnavailable = (
  cause: unknown,
  sessionId: string,
  allowsPinnedOpenCodeExtension: boolean
): boolean => {
  if (!(cause instanceof RequestError)) {
    return false;
  }
  const isOpenCodeSessionNotFound =
    allowsPinnedOpenCodeExtension &&
    cause.code === JSON_RPC_INVALID_PARAMS &&
    cause.message === `Invalid params: session not found: ${sessionId}` &&
    isRecord(cause.data) &&
    cause.data.sessionId === sessionId;
  const resourceMessageIsCanonical =
    cause.message === "Resource not found" ||
    cause.message === `Resource not found: ${sessionId}`;
  const resourceIdentityConflicts =
    isRecord(cause.data) &&
    cause.data.uri !== undefined &&
    cause.data.uri !== sessionId;
  const isStableResourceNotFound =
    cause.code === JSON_RPC_RESOURCE_NOT_FOUND &&
    resourceMessageIsCanonical &&
    !resourceIdentityConflicts;
  return isOpenCodeSessionNotFound || isStableResourceNotFound;
};

const isPinnedOpenCodeSessionServiceFailure = (cause: unknown): boolean =>
  cause instanceof RequestError &&
  cause.code === JSON_RPC_INTERNAL_ERROR &&
  cause.message === "Internal error: OpenCode service failure" &&
  isRecord(cause.data) &&
  cause.data.service === "session" &&
  Object.keys(cause.data).length === 1;

interface AcpInboundLimits {
  readonly maxLineBytes: number;
  readonly maxProcessBytes: number;
  readonly maxProcessRecords: number;
}

interface AcquiredChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly commandExit: Promise<void>;
  readonly exitListener: (
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void;
  readonly ownsProcessGroup: boolean;
  readonly releaseState: {
    completion?: Promise<void>;
    requested: boolean;
  };
  readonly runtimeErrorListener: (cause: Error) => void;
}

interface ActivePrompt {
  readonly attemptId: string | null;
  readonly attemptStore: ConversationPromptAttemptStore | undefined;
  readonly cancellation: AbortController;
  readonly closePermissions: Effect.Effect<void>;
  readonly completeTerminal: (
    outcome: ConversationPromptAttemptOutcome
  ) => Effect.Effect<void, HandlerFailure>;
  readonly completion: Promise<PromptResponse>;
  readonly localCancellationIntent: {
    current: "deadline" | "local" | "shutdown" | null;
  };
  readonly notifyCancel: Effect.Effect<void>;
  readonly recordUnknownStop: Effect.Effect<void, HandlerFailure>;
  readonly terminal: { current: boolean };
}

/** Supported low-level routing used because SDK 1.3 cannot attach an
 * ActiveSession to a successful stable-v1 session/resume response. */
interface RoutedAcpSession {
  dispose(): void;
  readonly effectiveMetadata: SignedAcpEffectiveMetadata | null;
  nextUpdate(): Promise<ActiveSessionMessage>;
  prompt(
    input: readonly ContentBlock[],
    options: { readonly cancellationSignal: AbortSignal }
  ): Promise<PromptResponse>;
  readonly sessionId: string;
}

interface ManagedSession {
  actionRegistration: PreparedActionMcpRegistration | null;
  readonly durable: boolean;
  readonly generation: number;
  readonly introducedParticipantIds: Set<string>;
  needsInitialContext: boolean;
  readonly replacementParticipantIds: readonly string[];
  readonly session: RoutedAcpSession;
}

const bindingIsDefinitelyUnsubmitted = (
  binding: ConversationAgentSessionBinding | null
): boolean =>
  binding === null ||
  (binding.initializationPhase === "pending" &&
    binding.ambiguousPromptId === null);

interface SessionMessageQueue {
  readonly clear: () => void;
  readonly enqueue: (message: ActiveSessionMessage) => void;
  readonly fail: (cause: unknown) => void;
  readonly next: () => Promise<ActiveSessionMessage>;
}

const makeSessionMessageQueue = (): SessionMessageQueue => {
  const messages: {
    readonly bytes: number;
    readonly message: ActiveSessionMessage;
  }[] = [];
  const waiters: {
    readonly reject: (cause: unknown) => void;
    readonly resolve: (message: ActiveSessionMessage) => void;
  }[] = [];
  let failureCause: unknown;
  let queuedBytes = 0;
  return {
    clear: () => {
      messages.length = 0;
      queuedBytes = 0;
      failureCause = undefined;
    },
    enqueue: (message) => {
      if (failureCause !== undefined) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(message);
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (
        messages.length >= MAX_SESSION_UPDATE_QUEUE_RECORDS ||
        queuedBytes + bytes > MAX_SESSION_UPDATE_QUEUE_BYTES
      ) {
        const cause = new Error("ACP session update queue exceeded its limit");
        failureCause = cause;
        messages.length = 0;
        queuedBytes = 0;
        for (const pending of waiters.splice(0)) {
          pending.reject(cause);
        }
        return;
      }
      messages.push({ bytes, message });
      queuedBytes += bytes;
    },
    fail: (cause) => {
      failureCause = cause;
      messages.length = 0;
      queuedBytes = 0;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(cause);
      }
    },
    next: () => {
      const queued = messages.shift();
      if (queued !== undefined) {
        queuedBytes = Math.max(0, queuedBytes - queued.bytes);
        return Promise.resolve(queued.message);
      }
      if (failureCause !== undefined) {
        return Promise.reject(failureCause);
      }
      return new Promise((resolve, reject) => {
        waiters.push({ reject, resolve });
      });
    },
  };
};

interface SessionUpdateRoute {
  readonly enqueue: (message: ActiveSessionMessage) => void;
}

interface PromptEpochVerification {
  readonly hasObservedAgentMessage: () => boolean;
  readonly isVerified: () => boolean;
  readonly waitForVerification: () => Promise<boolean>;
}

interface PromptEpochGate {
  readonly begin: (
    marker: string,
    openCodeOrderBoundary: bigint | null
  ) => PromptEpochVerification;
  readonly end: () => void;
  readonly permits: (update: SessionUpdate) => boolean;
}

const schedulePromptEpochMarkerTimeout = (options: {
  readonly cancellation: AbortController;
  readonly poison: () => void;
  readonly usesOpenCodeMessageBoundary: boolean;
  readonly verification: PromptEpochVerification;
}): ReturnType<typeof setTimeout> | undefined => {
  if (options.usesOpenCodeMessageBoundary) {
    return undefined;
  }
  return setTimeout(() => {
    if (!options.verification.isVerified()) {
      options.poison();
      options.cancellation.abort(
        new Error("ACP agent did not establish a prompt epoch")
      );
    }
  }, PROMPT_EPOCH_MARKER_TIMEOUT_MILLIS);
};

const makePromptEpochGate = (
  usesOpenCodeMessageBoundary: boolean
): PromptEpochGate => {
  let latestOpenCodeMessageOrder = 0n;
  let epoch:
    | {
        readonly historicalOpenCodeOrder: bigint;
        readonly marker: string;
        openCodeEpochOrder: bigint | null;
        readonly openCodeOrderBoundary: bigint | null;
        observedAgentMessage: boolean;
        readonly resolveVerification: () => void;
        readonly verification: Promise<void>;
        verified: boolean;
      }
    | undefined;
  const retainOrder = (order: bigint | null): void => {
    if (order !== null && order > latestOpenCodeMessageOrder) {
      latestOpenCodeMessageOrder = order;
    }
  };
  const verifiesEpoch = (
    update: SessionUpdate,
    order: bigint | null
  ): boolean => {
    if (epoch === undefined) {
      return false;
    }
    if (carriesPromptEpoch(update, epoch.marker)) {
      return true;
    }
    return (
      usesOpenCodeMessageBoundary &&
      order !== null &&
      epoch.openCodeOrderBoundary !== null &&
      order > epoch.openCodeOrderBoundary &&
      order > epoch.historicalOpenCodeOrder
    );
  };
  return {
    begin: (marker, openCodeOrderBoundary) => {
      let resolveVerification: () => void = () => undefined;
      const verification = new Promise<void>((resolveVerified) => {
        resolveVerification = resolveVerified;
      });
      const started = {
        historicalOpenCodeOrder: latestOpenCodeMessageOrder,
        marker,
        openCodeEpochOrder: null,
        openCodeOrderBoundary,
        observedAgentMessage: false,
        resolveVerification,
        verification,
        verified: false,
      };
      epoch = started;
      return {
        hasObservedAgentMessage: () => started.observedAgentMessage,
        isVerified: () => started.verified,
        waitForVerification: async () => {
          if (started.verified) {
            return true;
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<false>((resolveTimeout) => {
            timeout = setTimeout(
              () => resolveTimeout(false),
              PROMPT_EPOCH_POST_RESPONSE_GRACE_MILLIS
            );
          });
          const verified = await Promise.race([
            started.verification.then(() => true as const),
            timedOut,
          ]);
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          return verified;
        },
      };
    },
    end: () => {
      epoch = undefined;
    },
    permits: (update) => {
      const order = openCodeMessageOrder(update);
      if (epoch === undefined) {
        retainOrder(order);
        return false;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        epoch.observedAgentMessage = true;
      }
      if (!(epoch.verified || verifiesEpoch(update, order))) {
        retainOrder(order);
        return false;
      }
      if (!epoch.verified) {
        epoch.verified = true;
        epoch.openCodeEpochOrder = order;
        epoch.resolveVerification();
      } else if (
        usesOpenCodeMessageBoundary &&
        update.sessionUpdate === "agent_message_chunk" &&
        (order === null ||
          epoch.openCodeEpochOrder === null ||
          order < epoch.openCodeEpochOrder)
      ) {
        retainOrder(order);
        return false;
      }
      retainOrder(order);
      return true;
    },
  };
};

const failure = (
  operation: AcpConversationFailure["operation"]
): AcpConversationFailure => AcpConversationFailure.make({ operation });

const imageInputFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const toHandlerFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "ACP Conversation agent failed",
  });

const ambiguousPromptRecoveryFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "ACP prompt submission outcome is ambiguous",
  });

type PromptSettlement =
  | { readonly _tag: "Completed"; readonly response: PromptResponse }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "TimedOut" };

const awaitPromptSettlement = (
  completion: ActivePrompt["completion"],
  timeoutMillis: number
): Promise<PromptSettlement> =>
  new Promise((resolveSettlement) => {
    const timeout = setTimeout(() => {
      resolveSettlement({ _tag: "TimedOut" });
    }, timeoutMillis);
    completion.then(
      (response) => {
        clearTimeout(timeout);
        resolveSettlement({ _tag: "Completed", response });
      },
      () => {
        clearTimeout(timeout);
        resolveSettlement({ _tag: "Failed" });
      }
    );
  });

const configuredChildExitGraceMillis = (
  options: AcpConversationAgentOptions
): number => {
  const configured = options.childExitGraceMillis;
  return configured !== undefined &&
    Number.isSafeInteger(configured) &&
    configured > 0
    ? configured
    : CHILD_EXIT_GRACE_MILLIS;
};

const positiveSafeIntegerOr = (
  candidate: number | undefined,
  fallback: number
): number =>
  candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : fallback;

const configuredInboundLimits = (
  options: AcpConversationAgentOptions
): AcpInboundLimits => ({
  maxLineBytes: positiveSafeIntegerOr(
    options.inboundLimits?.maxLineBytes,
    MAX_ACP_NDJSON_LINE_BYTES
  ),
  maxProcessBytes: positiveSafeIntegerOr(
    options.inboundLimits?.maxProcessBytes,
    MAX_ACP_INBOUND_PROCESS_BYTES
  ),
  maxProcessRecords: positiveSafeIntegerOr(
    options.inboundLimits?.maxProcessRecords,
    MAX_ACP_INBOUND_PROCESS_RECORDS
  ),
});

const configuredPromptDeadlineMillis = (
  options: AcpConversationAgentOptions
): number => {
  const candidate = options.promptDeadlineMillis;
  if (
    candidate === undefined ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0
  ) {
    return DEFAULT_PROMPT_DEADLINE_MILLIS;
  }
  return Math.min(candidate, MAX_PROMPT_DEADLINE_MILLIS);
};

const durableStartupCapabilityFailure = (options: {
  readonly required: boolean;
  readonly supportsPromptEpoch: boolean;
  readonly supportsResume: boolean;
}): "prompt-epoch-capability-missing" | "resume-capability-missing" | null => {
  if (!options.required) {
    return null;
  }
  if (!options.supportsResume) {
    return "resume-capability-missing";
  }
  return options.supportsPromptEpoch ? null : "prompt-epoch-capability-missing";
};

const terminateChild = async (
  child: ChildProcessWithoutNullStreams,
  graceMillis: number,
  ownsProcessGroup: boolean,
  commandExit?: Promise<void>
): Promise<ProcessTerminationOutcome> => {
  if (!child.stdin.destroyed) {
    child.stdin.end();
  }
  if (commandExit !== undefined) {
    await new Promise<void>((resolveWait) => {
      const timeout = setTimeout(resolveWait, graceMillis);
      commandExit.then(() => {
        clearTimeout(timeout);
        resolveWait();
      });
    });
  }
  return await terminateSupervisedProcess(child, graceMillis, ownsProcessGroup);
};

const releaseChild = (
  acquired: AcquiredChild,
  graceMillis: number,
  observeCleanup?: AcpConversationAgentOptions["processCleanupObserver"]
): Effect.Effect<void> =>
  Effect.promise(() => {
    if (acquired.releaseState.completion !== undefined) {
      return acquired.releaseState.completion;
    }
    const completion = (async () => {
      acquired.releaseState.requested = true;
      try {
        const outcome = await terminateChild(
          acquired.child,
          graceMillis,
          acquired.ownsProcessGroup,
          acquired.commandExit
        );
        observeCleanup?.(outcome);
      } catch (cause) {
        observeCleanup?.("failed");
        throw cause;
      } finally {
        acquired.child.off("exit", acquired.exitListener);
        acquired.child.off("error", acquired.runtimeErrorListener);
      }
    })();
    acquired.releaseState.completion = completion;
    return completion;
  });

const acquireChild = (
  options: AcpConversationAgentOptions
): Effect.Effect<AcquiredChild, AcpConversationFailure> =>
  Effect.callback<AcquiredChild, AcpConversationFailure>((resume) => {
    let child: ChildProcessWithoutNullStreams;
    const graceMillis = configuredChildExitGraceMillis(options);
    const ownsProcessGroup = process.platform !== "win32";
    try {
      child = spawn(
        ownsProcessGroup ? process.execPath : options.command,
        ownsProcessGroup
          ? [
              processSupervisorProxyPath,
              options.command,
              ...(options.args ?? []),
            ]
          : [...(options.args ?? [])],
        {
          cwd: options.cwd,
          detached: ownsProcessGroup,
          env: options.environment ?? process.env,
          stdio: ownsProcessGroup
            ? ["pipe", "pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe"],
        }
      ) as ChildProcessWithoutNullStreams;
    } catch {
      observeProcessFailure(options, "transient", "spawn_failed");
      resume(failure("spawn"));
      return;
    }

    let acquired: AcquiredChild | undefined;
    const onStartupError = (): void => {
      observeProcessFailure(options, "transient", "spawn_failed");
      child.off("spawn", onSpawn);
      resume(
        Effect.promise(() =>
          terminateChild(child, graceMillis, ownsProcessGroup)
        ).pipe(Effect.andThen(failure("spawn")))
      );
    };
    const onSpawn = (): void => {
      child.off("error", onStartupError);
      const releaseState = { requested: false };
      const failTransport = (cause: Error): void => {
        if (releaseState.requested) {
          return;
        }
        child.stdout.destroy(cause);
        child.stdin.destroy();
      };
      const runtimeErrorListener = (cause: Error): void => {
        failTransport(
          new Error("ACP child process failed after startup", { cause })
        );
      };
      const exitListener = (
        code: number | null,
        signal: NodeJS.Signals | null
      ): void => {
        if (releaseState.requested) {
          return;
        }
        try {
          options.processExitObserver?.(code, signal);
        } catch {
          // Exit observation cannot own process cleanup.
        }
        observeProcessFailure(options, "transient", "transport_lost");
        failTransport(
          new Error(
            `ACP child exited unexpectedly (${signal ?? String(code ?? "unknown")})`
          )
        );
      };
      const supervisorControl = child.stdio[3];
      const commandExit =
        supervisorControl instanceof Readable
          ? awaitProcessSupervisorReport(supervisorControl).then((report) => {
              if (report !== null) {
                try {
                  options.processExitObserver?.(report.code, report.signal);
                } catch {
                  // Exit observation cannot own process cleanup.
                }
              }
              if (!releaseState.requested) {
                observeProcessFailure(options, "transient", "transport_lost");
                observeProcessHealth(options, "closed");
                failTransport(
                  new Error("ACP child command exited unexpectedly")
                );
              }
            })
          : new Promise<void>((resolveCommandExit) => {
              child.once("exit", () => resolveCommandExit());
            });
      acquired = {
        child,
        commandExit,
        exitListener,
        ownsProcessGroup,
        releaseState,
        runtimeErrorListener,
      };
      child.on("error", runtimeErrorListener);
      child.on("exit", exitListener);
      if (
        supervisorControl !== undefined &&
        supervisorControl !== null &&
        "resume" in supervisorControl
      ) {
        supervisorControl.resume();
      }
      child.stderr.resume();
      resume(Effect.succeed(acquired));
    };
    child.once("error", onStartupError);
    child.once("spawn", onSpawn);
    return Effect.promise(async () => {
      const cleanupErrorListener = (): void => {
        // Interruption owns cleanup; consume a concurrent spawn error while reaping.
      };
      child.off("spawn", onSpawn);
      child.off("error", onStartupError);
      child.on("error", cleanupErrorListener);
      if (acquired !== undefined) {
        acquired.releaseState.requested = true;
        child.off("exit", acquired.exitListener);
        child.off("error", acquired.runtimeErrorListener);
      }
      try {
        await terminateChild(child, graceMillis, ownsProcessGroup);
      } finally {
        child.off("error", cleanupErrorListener);
      }
    });
  });

const boundedNdJsonInput = (
  input: ReadableStream<Uint8Array>,
  limits: AcpInboundLimits
): ReadableStream<Uint8Array> => {
  let lineBytes = 0;
  let processBytes = 0;
  let processRecords = 0;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        processBytes += chunk.byteLength;
        if (processBytes > limits.maxProcessBytes) {
          throw new Error("ACP input exceeded its process-lifetime byte limit");
        }
        for (const byte of chunk) {
          if (byte === NEWLINE_BYTE) {
            if (lineBytes > 0) {
              processRecords += 1;
              if (processRecords > limits.maxProcessRecords) {
                throw new Error(
                  "ACP input exceeded its process-lifetime record limit"
                );
              }
            }
            lineBytes = 0;
            continue;
          }
          lineBytes += 1;
          if (lineBytes > limits.maxLineBytes) {
            throw new Error("ACP NDJSON line exceeded its byte limit");
          }
        }
        controller.enqueue(chunk);
      },
    })
  );
};

const nextSessionUpdate = (
  session: RoutedAcpSession,
  signal: AbortSignal
): Promise<ActiveSessionMessage> =>
  new Promise((resolveUpdate, rejectUpdate) => {
    if (signal.aborted) {
      rejectUpdate(signal.reason);
      return;
    }
    const onAbort = (): void => {
      rejectUpdate(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    session.nextUpdate().then(
      (update) => {
        signal.removeEventListener("abort", onAbort);
        resolveUpdate(update);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectUpdate(cause);
      }
    );
  });

const publicTextChunk = (
  update: SessionUpdate
): {
  readonly messageId: string | null | undefined;
  readonly text: string;
} | null => {
  if (
    update.sessionUpdate !== "agent_message_chunk" ||
    update.content.type !== "text" ||
    update.content.text.length === 0
  ) {
    return null;
  }
  return { messageId: update.messageId, text: update.content.text };
};

type SilentConversationReplyPhase =
  | "leading-whitespace"
  | "token"
  | "trailing-whitespace"
  | "diverged";

interface SilentConversationReplyState {
  matchedTokenCodeUnits: number;
  phase: SilentConversationReplyPhase;
}

const ECMASCRIPT_WHITESPACE_CODE_UNIT = /^\s$/u;

const makeSilentConversationReplyState = (): SilentConversationReplyState => ({
  matchedTokenCodeUnits: 0,
  phase: "leading-whitespace",
});

const advanceSilentConversationReplyState = (
  state: SilentConversationReplyState,
  text: string
): boolean => {
  if (state.phase === "diverged") {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charAt(index);
    if (state.phase === "leading-whitespace") {
      if (ECMASCRIPT_WHITESPACE_CODE_UNIT.test(codeUnit)) {
        continue;
      }
      if (codeUnit !== SILENT_CONVERSATION_REPLY_TOKEN.charAt(0)) {
        state.phase = "diverged";
        return false;
      }
      state.matchedTokenCodeUnits = 1;
      state.phase = "token";
      continue;
    }
    if (state.phase === "token") {
      if (
        codeUnit !==
        SILENT_CONVERSATION_REPLY_TOKEN.charAt(state.matchedTokenCodeUnits)
      ) {
        state.phase = "diverged";
        return false;
      }
      state.matchedTokenCodeUnits += 1;
      if (
        state.matchedTokenCodeUnits === SILENT_CONVERSATION_REPLY_TOKEN.length
      ) {
        state.phase = "trailing-whitespace";
      }
      continue;
    }
    if (!ECMASCRIPT_WHITESPACE_CODE_UNIT.test(codeUnit)) {
      state.phase = "diverged";
      return false;
    }
  }
  return true;
};

const isSilentConversationReply = (
  state: SilentConversationReplyState
): boolean => state.phase === "trailing-whitespace";

const newHumanParticipantIds = (
  request: ConversationAgentRequest,
  introducedParticipantIds: ReadonlySet<string>,
  laborerSlackId: string | undefined
): string[] => {
  const pending = new Set<string>();
  for (const message of [...request.context, ...request.messages]) {
    if (
      message.authorKind !== "human" ||
      message.authorSlackId === laborerSlackId ||
      introducedParticipantIds.has(message.authorSlackId)
    ) {
      continue;
    }
    pending.add(message.authorSlackId);
  }
  return [...pending];
};

const terminalOutcomeFor = (
  stopReason: PromptResponse["stopReason"],
  localCancellationIntent: ActivePrompt["localCancellationIntent"]["current"]
): ConversationPromptAttemptOutcome => {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return stopReason;
    case "cancelled":
      return localCancellationIntent === null
        ? "cancelled_agent"
        : "cancelled_local";
    default:
      return "unknown_stop";
  }
};

const terminalStopFailure = (
  outcome: ConversationPromptAttemptOutcome
): HandlerFailure =>
  HandlerFailure.make({
    category: outcome.startsWith("cancelled") ? "signal" : "protocol",
    noticeStyle: "generic",
    safeDetail: "ACP Conversation turn stopped without completion",
  });

const settlePromptStop = Effect.fn("AcpConversationAgent.settlePromptStop")(
  function* (
    prompt: ActivePrompt,
    stopReason: PromptResponse["stopReason"],
    publicOutputObserved: boolean,
    privateSilentCompletionObserved = false
  ) {
    yield* Effect.tryPromise({
      try: () => prompt.completion,
      catch: () => failure("prompt"),
    });
    yield* prompt.closePermissions;
    const outcome = terminalOutcomeFor(
      stopReason,
      prompt.localCancellationIntent.current
    );
    if (outcome === "unknown_stop") {
      yield* prompt.recordUnknownStop;
      return yield* ambiguousPromptRecoveryFailure();
    }
    yield* prompt.completeTerminal(outcome);
    prompt.terminal.current = true;
    const boundedCompletion =
      (publicOutputObserved || privateSilentCompletionObserved) &&
      (outcome === "max_tokens" || outcome === "max_turn_requests");
    if (outcome !== "end_turn" && !boundedCompletion) {
      return yield* terminalStopFailure(outcome);
    }
    return [] as const;
  }
);

const settlePromptProtocolFailure = Effect.fn(
  "AcpConversationAgent.settlePromptProtocolFailure"
)(function* (prompt: ActivePrompt) {
  yield* prompt.closePermissions;
  yield* prompt.completeTerminal("protocol_failed");
  return yield* terminalStopFailure("protocol_failed");
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: prompt admission, bounded context rendering, durable image validation, streaming, and terminal settlement share one ACP ownership boundary
const runPrompt = Effect.fn("AcpConversationAgent.runPrompt")(function* (
  session: RoutedAcpSession,
  request: ConversationAgentRequest,
  requiredInput: string,
  agentContext: AcpAgentContextSources | undefined,
  needsInitialContext: boolean,
  participantLookup: SlackParticipantLookupShape | undefined,
  participantIds: readonly string[],
  startPrompt: (
    input: readonly ContentBlock[],
    introducedParticipantIds: readonly string[]
  ) => Effect.Effect<ActivePrompt, AcpConversationFailure | HandlerFailure>,
  publishMessage: PublishConversationAgentMessage,
  invalidate: (prompt: ActivePrompt) => Effect.Effect<void>,
  promptDeadlineMillis: number,
  imageStorageRoot: string | undefined,
  imagePromptCapable: boolean
) {
  if (textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES) {
    return yield* failure("prompt");
  }
  let input = requiredInput;
  let submittedParticipantIds = participantIds;
  if (
    agentContext !== undefined &&
    (needsInitialContext || participantIds.length > 0)
  ) {
    const initialSnapshot = needsInitialContext
      ? yield* loadAcpAgentContextSnapshot(agentContext)
      : { participants: [], soul: null, workspaceMemory: null };
    const participants = yield* loadAcpSlackParticipantContexts(
      agentContext,
      participantLookup,
      participantIds
    );
    const rendered = yield* renderAcpPromptWithinByteLimit(
      request,
      { ...initialSnapshot, participants },
      MAX_PROMPT_BYTES
    );
    if (rendered === null) {
      return yield* failure("prompt");
    }
    input = rendered.prompt;
    submittedParticipantIds = rendered.introducedParticipantIds;
  }
  const images = [...request.context, ...request.messages].flatMap(
    (message) => message.images ?? []
  );
  if (images.some((image) => "failureReason" in image)) {
    return yield* imageInputFailure(
      "required image input is unavailable; re-upload a supported image and try again"
    );
  }
  const aggregateImageBytes = images.reduce(
    (total, image) =>
      "failureReason" in image ? total : total + image.byteLength,
    0
  );
  if (
    images.length > MAX_PROMPT_IMAGES ||
    aggregateImageBytes > MAX_PROMPT_IMAGE_BYTES
  ) {
    return yield* imageInputFailure(
      "image input exceeds the supported count or aggregate byte limit"
    );
  }
  if (
    images.length > 0 &&
    (!imagePromptCapable || imageStorageRoot === undefined)
  ) {
    return yield* imageInputFailure(
      imageStorageRoot === undefined
        ? "image storage is unavailable"
        : "the selected Conversation agent does not support image input"
    );
  }
  const promptBlocks: ContentBlock[] = [];
  let remainingText = input;
  for (const image of images) {
    if ("failureReason" in image) {
      return yield* imageInputFailure("required image input is unavailable");
    }
    const root = resolve(imageStorageRoot as string);
    const path = resolve(root, image.contentPath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      return yield* imageInputFailure("accepted image storage is invalid");
    }
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        await assertNoSymlinkPathComponents(path, "read-inbound-image");
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size !== image.byteLength) {
          throw new Error("image-content-invalid");
        }
        const content = await readFile(path);
        if (
          createHash("sha256").update(content).digest("hex") !==
          image.contentDigest
        ) {
          throw new Error("image-digest-mismatch");
        }
        return content;
      },
      catch: () =>
        imageInputFailure(
          "accepted image content is unavailable; re-upload the image and try again"
        ),
    });
    const markerStart = remainingText.indexOf("<slack-image ");
    const markerEnd =
      markerStart < 0 ? -1 : remainingText.indexOf("/>", markerStart);
    if (markerEnd >= 0) {
      promptBlocks.push({
        text: remainingText.slice(0, markerEnd + 2),
        type: "text",
      });
      remainingText = remainingText.slice(markerEnd + 2);
    } else if (promptBlocks.length === 0) {
      promptBlocks.push({ text: remainingText, type: "text" });
      remainingText = "";
    }
    promptBlocks.push({
      data: bytes.toString("base64"),
      mimeType: image.mimeType,
      type: "image",
      uri: null,
    });
  }
  if (remainingText.length > 0 || promptBlocks.length === 0) {
    promptBlocks.push({ text: remainingText, type: "text" });
  }
  return yield* Effect.acquireUseRelease(
    startPrompt(promptBlocks, submittedParticipantIds),
    (prompt) =>
      Effect.gen(function* () {
        const consumeUpdates = Effect.gen(function* () {
          let outputBytes = 0;
          let publicOutputObserved = false;
          const silentReplyState = makeSilentConversationReplyState();
          let terminalUpdateObserved = false;
          const messageIds = new Set<string>();
          const fallbackMessageId = `${request.promptId}:message`;
          const heldChunks: {
            readonly messageId: string;
            readonly text: string;
          }[] = [];
          const publishChunk = Effect.fnUntraced(function* (chunk: {
            readonly messageId: string;
            readonly text: string;
          }) {
            if (
              prompt.attemptId !== null &&
              prompt.attemptStore !== undefined
            ) {
              yield* prompt.attemptStore.markPublicOutputObserved(
                prompt.attemptId
              );
            }
            publicOutputObserved = true;
            yield* publishMessage(chunk);
          });
          const flushHeldChunks = Effect.fnUntraced(function* () {
            const chunks = heldChunks.splice(0);
            yield* Effect.forEach(chunks, publishChunk, { discard: true });
          });
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Protocol routing, silent-token buffering, output bounds, and terminal ordering form one auditable prompt state machine.
          const consumeMessages = Effect.gen(function* () {
            while (true) {
              const message = yield* Effect.tryPromise({
                try: (signal) => nextSessionUpdate(session, signal),
                catch: promptUpdateFailure,
              });
              if (message.kind === "stop") {
                terminalUpdateObserved = true;
                const privateSilentCompletionObserved =
                  isSilentConversationReply(silentReplyState);
                if (!privateSilentCompletionObserved) {
                  yield* flushHeldChunks();
                }
                return yield* settlePromptStop(
                  prompt,
                  message.stopReason,
                  publicOutputObserved,
                  privateSilentCompletionObserved
                );
              }
              const chunk = publicTextChunk(message.update);
              if (chunk === null) {
                continue;
              }
              const messageId = chunk.messageId ?? fallbackMessageId;
              messageIds.add(messageId);
              outputBytes += textEncoder.encode(chunk.text).byteLength;
              if (
                messageIds.size > MAX_PUBLIC_MESSAGES ||
                outputBytes > MAX_PUBLIC_OUTPUT_BYTES
              ) {
                return yield* failure("prompt");
              }
              const publicChunk = { messageId, text: chunk.text };
              if (silentReplyState.phase !== "diverged") {
                heldChunks.push(publicChunk);
                if (
                  advanceSilentConversationReplyState(
                    silentReplyState,
                    chunk.text
                  )
                ) {
                  continue;
                }
                yield* flushHeldChunks();
                continue;
              }
              yield* publishChunk(publicChunk);
            }
          }).pipe(
            Effect.onExit(() =>
              terminalUpdateObserved &&
              isSilentConversationReply(silentReplyState)
                ? Effect.void
                : flushHeldChunks()
            )
          );
          return yield* consumeMessages;
        }).pipe(
          Effect.catchTags({
            AcpPromptProtocolRejected: () =>
              settlePromptProtocolFailure(prompt),
            AcpUnknownPromptStop: () =>
              Effect.gen(function* () {
                yield* prompt.closePermissions;
                yield* prompt.recordUnknownStop;
                return yield* ambiguousPromptRecoveryFailure();
              }),
          })
        );
        const raced = yield* Effect.raceFirst(
          consumeUpdates.pipe(
            Effect.map((value) => ({ _tag: "Completed" as const, value }))
          ),
          Effect.sleep(`${promptDeadlineMillis} millis`).pipe(
            Effect.as({ _tag: "Deadline" as const })
          )
        );
        if (raced._tag === "Completed") {
          return raced.value;
        }
        prompt.localCancellationIntent.current = "deadline";
        if (prompt.attemptId !== null && prompt.attemptStore !== undefined) {
          yield* prompt.attemptStore.markCancellationIntent(
            prompt.attemptId,
            "deadline"
          );
        }
        yield* prompt.closePermissions;
        yield* prompt.notifyCancel;
        const cancellation = yield* Effect.result(
          Effect.tryPromise({
            try: () => prompt.completion,
            catch: () => failure("prompt"),
          }).pipe(Effect.timeout(`${PROMPT_CANCEL_SETTLEMENT_MILLIS} millis`))
        );
        if (
          cancellation._tag === "Success" &&
          cancellation.success.stopReason === "cancelled"
        ) {
          return yield* settlePromptStop(prompt, "cancelled", false);
        }
        if (prompt.attemptId !== null && prompt.attemptStore !== undefined) {
          const timestamp = yield* Clock.currentTimeMillis;
          yield* prompt.attemptStore.markInterrupted(
            prompt.attemptId,
            "unresolved",
            timestamp
          );
        }
        return yield* ambiguousPromptRecoveryFailure();
      }),
    (prompt, exit) => (Exit.isSuccess(exit) ? Effect.void : invalidate(prompt))
  );
});

export const makeAcpConversationAgent = Effect.fn("makeAcpConversationAgent")(
  function* (
    options: AcpConversationAgentOptions
  ): Effect.fn.Return<ConversationAgentShape, HandlerFailure, Scope.Scope> {
    observeProcessHealth(options, "starting");
    const constructionScope = yield* Scope.make();
    const setup = Effect.gen(function* () {
      const exitGraceMillis = configuredChildExitGraceMillis(options);
      const activeSessionLimit = positiveSafeIntegerOr(
        options.testHooks?.activeSessionLimit,
        MAX_ACTIVE_SESSIONS
      );
      const acquiredChild = yield* Effect.acquireRelease(
        acquireChild(options),
        (acquired) =>
          releaseChild(
            acquired,
            exitGraceMillis,
            options.processCleanupObserver
          )
      ).pipe(Effect.mapError(toHandlerFailure));
      const { child } = acquiredChild;
      const output = Writable.toWeb(child.stdin);
      const childOutput = Readable.toWeb(
        child.stdout
      ) as ReadableStream<Uint8Array>;
      const input = boundedNdJsonInput(
        childOutput,
        configuredInboundLimits(options)
      );
      const memoryMcpServer = options.memoryMcpServer;
      const actionMcpBridge = options.actionMcpBridge;
      const memoryMcpBootstrapTimeoutMillis = positiveSafeIntegerOr(
        options.memoryMcpBootstrapTimeoutMillis,
        MEMORY_MCP_BOOTSTRAP_SESSION_TIMEOUT_MILLIS
      );
      const memoryMcpActiveCallDrainTimeoutMillis = positiveSafeIntegerOr(
        options.memoryMcpActiveCallDrainTimeoutMillis,
        MEMORY_MCP_ACTIVE_CALL_DRAIN_TIMEOUT_MILLIS
      );
      const sessionWorkingDirectory =
        options.agentContext?.root ??
        (yield* Effect.tryPromise({
          try: () => realpath(options.cwd),
          catch: toHandlerFailure,
        }));
      const memoryTrustedRoot = sessionWorkingDirectory;
      const sessionWorkingDirectoryIdentity = yield* Effect.tryPromise({
        try: async () => {
          const metadata = await stat(sessionWorkingDirectory, {
            bigint: true,
          });
          if (!metadata.isDirectory()) {
            throw new Error("ACP session root is not a directory");
          }
          return `${metadata.dev}:${metadata.ino}`;
        },
        catch: toHandlerFailure,
      });
      const verifySessionWorkingDirectory = Effect.fn(
        "AcpConversationAgent.verifySessionWorkingDirectory"
      )(function* () {
        const current = yield* Effect.tryPromise({
          try: async () => {
            const [canonical, metadata] = await Promise.all([
              realpath(sessionWorkingDirectory),
              stat(sessionWorkingDirectory, { bigint: true }),
            ]);
            return {
              canonical,
              identity: `${metadata.dev}:${metadata.ino}`,
              isDirectory: metadata.isDirectory(),
            };
          },
          catch: toHandlerFailure,
        });
        if (
          !current.isDirectory ||
          current.canonical !== sessionWorkingDirectory ||
          current.identity !== sessionWorkingDirectoryIdentity
        ) {
          return yield* toHandlerFailure();
        }
      });
      const privateContext = yield* Effect.context<never>();
      const runPrivateEffect = Effect.runForkWith(privateContext);
      const runPrivatePromise = Effect.runPromiseWith(privateContext);
      const memoryPermissionGate: LaborerMemoryPermissionGate = {
        acceptingCalls: true,
        activeToolCallIds: new Set<string>(),
        onSafetyDenial: () => {
          runPrivateEffect(
            Effect.logWarning(
              "Memory permission denied for registration safety"
            )
          );
        },
        safetyDenialObserved: false,
      };
      const memoryAuthorizedSessionPermissions = new Map<
        string,
        LaborerMemoryPermissionRegistration
      >();
      const memoryObservedSessionLifecycles = new Map<
        string,
        LaborerMemoryPermissionRegistration
      >();
      const sessionUpdateRoutes = new Map<string, SessionUpdateRoute>();
      const connection = client({
        name: "laborer-acp-conversation-proof",
      })
        .onNotification(methods.client.session.update, ({ params }) => {
          sessionUpdateRoutes.get(params.sessionId)?.enqueue({
            kind: "session_update",
            notification: params,
            update: params.update,
          });
          observeLaborerMemoryToolCall(params, memoryObservedSessionLifecycles);
          options.actionMcpBridge?.observeToolCall(params);
          const update = params.update;
          if (
            update.sessionUpdate === "tool_call_update" &&
            (update.status === "completed" || update.status === "failed") &&
            ![...memoryPermissionGate.activeToolCallIds].some((callId) =>
              callId.startsWith(`${params.sessionId}\0`)
            ) &&
            !memoryAuthorizedSessionPermissions.has(params.sessionId)
          ) {
            memoryObservedSessionLifecycles.delete(params.sessionId);
          }
        })
        .onRequest(
          methods.client.session.requestPermission,
          async ({ params }) => {
            const actionDecision =
              options.actionMcpBridge === undefined
                ? null
                : await runPrivatePromise(
                    options.actionMcpBridge.tryAuthorizePermission(params)
                  );
            if (actionDecision !== null) {
              return actionDecision;
            }
            const memoryDecision = tryAuthorizeLaborerMemoryPermission(
              params,
              memoryAuthorizedSessionPermissions
            );
            if (memoryDecision !== null) {
              return memoryDecision;
            }
            return options.permissionBroker === undefined
              ? { outcome: { outcome: "cancelled" as const } }
              : await runPrivatePromise(
                  options.permissionBroker.request(params)
                );
          }
        )
        .connect(ndJsonStream(output, input));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          connection.close();
        })
      );
      const initialized = yield* Effect.tryPromise({
        try: () =>
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              _meta: { [PROMPT_EPOCH_CAPABILITY_KEY]: true },
            },
          }),
        catch: () => failure("initialize"),
      }).pipe(
        Effect.timeout(
          `${positiveSafeIntegerOr(
            options.initializeTimeoutMillis,
            ACP_INITIALIZE_TIMEOUT_MILLIS
          )} millis`
        ),
        Effect.mapError(toHandlerFailure)
      );
      if (
        PROTOCOL_VERSION !== 1 ||
        initialized.protocolVersion !== PROTOCOL_VERSION
      ) {
        observeProcessFailure(
          options,
          "deterministic",
          "protocol_incompatible"
        );
        return yield* toHandlerFailure();
      }

      const commandIsOpenCode =
        basename(options.command) === "opencode" ||
        basename(options.command) === "opencode.exe" ||
        options.testHooks?.treatCommandAsOpenCode === true;
      const reportsSupportedOpenCode =
        initialized.agentInfo?.name === "OpenCode" &&
        OPEN_CODE_SUPPORTED_VERSIONS.has(initialized.agentInfo.version);
      if (commandIsOpenCode && !reportsSupportedOpenCode) {
        observeProcessFailure(
          options,
          "deterministic",
          "protocol_incompatible"
        );
        yield* Effect.logWarning("OpenCode ACP contract is incompatible", {
          code: "opencode-version-unsupported",
        });
        return yield* toHandlerFailure();
      }
      const usesOpenCodeMessageBoundary = commandIsOpenCode;
      const supportsPromptEpochExtension =
        isRecord(initialized.agentCapabilities?._meta) &&
        initialized.agentCapabilities._meta[PROMPT_EPOCH_CAPABILITY_KEY] ===
          true;
      let poisonIncompatibleProcess = (): void => undefined;
      let reapFailedProcess = (): void => undefined;
      const effectiveMetadataFor = Effect.fn(
        "AcpConversationAgent.effectiveMetadataFor"
      )(function* (
        response:
          | import("@agentclientprotocol/sdk").NewSessionResponse
          | import("@agentclientprotocol/sdk").ResumeSessionResponse,
        cwd: string,
        registration: PreparedLaborerMemoryMcpRegistration | null,
        actionRegistration: PreparedActionMcpRegistration | null
      ): Effect.fn.Return<SignedAcpEffectiveMetadata | null, HandlerFailure> {
        if (options.authorityRepository === undefined) {
          return null;
        }
        const configSourceInventory = yield* inventoryAcpConfigSources({
          environment: options.environment ?? process.env,
          projectRoot: sessionWorkingDirectory,
          repository: options.authorityRepository,
        });
        return signAcpEffectiveMetadata(
          options.authorityRepository,
          extractAcpEffectiveMetadata({
            agentInfo: initialized.agentInfo,
            configSourceInventory,
            cwd,
            environment: options.environment ?? process.env,
            mcpServerNames: [
              ...(registration === null ? [] : [registration.server.name]),
              ...(actionRegistration === null
                ? []
                : [actionRegistration.server.name]),
            ],
            protocolVersion: initialized.protocolVersion,
            repository: options.authorityRepository,
            response,
          })
        );
      });
      const attachRoutedSession = (
        sessionId: string,
        effectiveMetadata: SignedAcpEffectiveMetadata | null
      ): RoutedAcpSession => {
        const queue = makeSessionMessageQueue();
        if (sessionUpdateRoutes.has(sessionId)) {
          throw new Error("ACP session is already attached");
        }
        let disposed = false;
        let promptActive = false;
        const promptEpoch = makePromptEpochGate(usesOpenCodeMessageBoundary);
        sessionUpdateRoutes.set(sessionId, {
          enqueue: (message) => {
            if (
              message.kind === "session_update" &&
              promptEpoch.permits(message.update)
            ) {
              queue.enqueue(message);
            }
          },
        });
        return {
          dispose: () => {
            if (disposed) {
              return;
            }
            disposed = true;
            promptEpoch.end();
            sessionUpdateRoutes.delete(sessionId);
            queue.fail(new Error("ACP session routing disposed"));
          },
          effectiveMetadata,
          nextUpdate: async () => {
            const message = await queue.next();
            if (message.kind === "stop") {
              promptActive = false;
              promptEpoch.end();
              queue.clear();
            }
            return message;
          },
          prompt: async (input, promptOptions) => {
            if (disposed || promptActive) {
              throw new Error("ACP session routing disposed");
            }
            queue.clear();
            promptActive = true;
            let openCodeOrderBoundary: bigint | null;
            try {
              openCodeOrderBoundary = usesOpenCodeMessageBoundary
                ? await nextOpenCodeOrderBoundary()
                : null;
              promptOptions.cancellationSignal.throwIfAborted();
            } catch (cause) {
              promptActive = false;
              promptEpoch.end();
              throw cause;
            }
            const marker = randomUUID();
            const verification = promptEpoch.begin(
              marker,
              openCodeOrderBoundary
            );
            const markerCancellation = new AbortController();
            const markerTimeout = schedulePromptEpochMarkerTimeout({
              cancellation: markerCancellation,
              poison: poisonIncompatibleProcess,
              usesOpenCodeMessageBoundary,
              verification,
            });
            const requestCompletion = connection.agent.request(
              methods.agent.session.prompt,
              {
                _meta: {
                  ...(openCodeOrderBoundary === null
                    ? {}
                    : {
                        [OPEN_CODE_ORDER_BOUNDARY_META_KEY]:
                          openCodeOrderBoundary.toString(16),
                      }),
                  [PROMPT_EPOCH_META_KEY]: marker,
                },
                prompt: [...input],
                sessionId,
              },
              {
                cancellationSignal: AbortSignal.any([
                  promptOptions.cancellationSignal,
                  markerCancellation.signal,
                ]),
              }
            );
            const completion = requestCompletion
              .then(async (response) => {
                const acceptsTextlessResponse =
                  usesOpenCodeMessageBoundary &&
                  !verification.hasObservedAgentMessage() &&
                  isSettledTextlessOpenCodeResponse(response);
                if (
                  !(
                    acceptsTextlessResponse ||
                    (await verification.waitForVerification())
                  )
                ) {
                  poisonIncompatibleProcess();
                  throw new Error("ACP agent did not establish a prompt epoch");
                }
                return response;
              })
              .finally(() => {
                if (markerTimeout !== undefined) {
                  clearTimeout(markerTimeout);
                }
              });
            completion.then(
              (response) => {
                queue.enqueue({
                  kind: "stop",
                  response,
                  stopReason: response.stopReason,
                });
              },
              (cause: unknown) => {
                promptActive = false;
                promptEpoch.end();
                const completionFailure = promptCompletionFailure(
                  cause,
                  runtimeIncompatibilityObserved
                );
                queue.fail(completionFailure);
                if (completionFailure instanceof AcpPromptProtocolRejected) {
                  reapFailedProcess();
                }
              }
            );
            return completion;
          },
          sessionId,
        };
      };

      const sessions = new Map<string, ManagedSession>();
      let promotedActionRegistration: PreparedActionMcpRegistration | null =
        null;
      const claimedSessionClosures = new WeakSet<RoutedAcpSession>();
      let memoryBootstrapSession: RoutedAcpSession | undefined;
      let nextSessionGeneration = 0;
      const allocateSessionGeneration = (): number => {
        nextSessionGeneration += 1;
        return nextSessionGeneration;
      };
      let processPoisoned = false;
      let pollutedProcessCleanup: Promise<void> | undefined;
      let shutdownRequested = false;
      const quarantinedConversations = new Set<string>();
      const memoryRegistrationGate = yield* Semaphore.make(1);
      const workspacePromptGate = yield* Semaphore.make(1);
      const supportsSessionClose =
        initialized.agentCapabilities?.sessionCapabilities?.close !==
          undefined &&
        initialized.agentCapabilities.sessionCapabilities.close !== null;
      const supportsSessionResume =
        initialized.agentCapabilities?.sessionCapabilities?.resume !==
          undefined &&
        initialized.agentCapabilities.sessionCapabilities.resume !== null;
      const supportsSessionList =
        initialized.agentCapabilities?.sessionCapabilities?.list !==
          undefined &&
        initialized.agentCapabilities.sessionCapabilities.list !== null;
      const startupCapabilityFailure = durableStartupCapabilityFailure({
        required: options.requireDurableCapabilitiesAtStartup === true,
        supportsPromptEpoch:
          usesOpenCodeMessageBoundary || supportsPromptEpochExtension,
        supportsResume: supportsSessionResume,
      });
      if (startupCapabilityFailure !== null) {
        observeProcessFailure(
          options,
          "deterministic",
          "protocol_incompatible"
        );
        observeProcessHealth(options, "quarantined");
        yield* Effect.logWarning("ACP workspace contract is incompatible", {
          code: startupCapabilityFailure,
        });
        return yield* toHandlerFailure();
      }

      const claimActiveSessionForClose = (
        session: RoutedAcpSession,
        preserveActiveToolCalls = true
      ): boolean => {
        if (claimedSessionClosures.has(session)) {
          return false;
        }
        claimedSessionClosures.add(session);
        session.dispose();
        const permissionRegistration = memoryObservedSessionLifecycles.get(
          session.sessionId
        );
        if (permissionRegistration !== undefined) {
          clearLaborerMemoryPermissionRegistration(
            session.sessionId,
            permissionRegistration,
            { preserveActiveToolCalls }
          );
        }
        memoryAuthorizedSessionPermissions.delete(session.sessionId);
        const retainsActiveToolCalls = [
          ...memoryPermissionGate.activeToolCallIds,
        ].some((callId) => callId.startsWith(`${session.sessionId}\0`));
        if (!(preserveActiveToolCalls && retainsActiveToolCalls)) {
          memoryObservedSessionLifecycles.delete(session.sessionId);
        }
        return true;
      };

      const closeClaimedSession = Effect.fn(
        "AcpConversationAgent.closeClaimedSession"
      )(function* (session: RoutedAcpSession) {
        if (supportsSessionClose) {
          yield* Effect.tryPromise({
            try: (signal) =>
              connection.agent.request(
                methods.agent.session.close,
                {
                  sessionId: session.sessionId,
                },
                { cancellationSignal: signal }
              ),
            catch: () => undefined,
          }).pipe(Effect.timeout(`${exitGraceMillis} millis`), Effect.ignore);
        }
      });

      const releaseMemoryBootstrapSession = Effect.fn(
        "AcpConversationAgent.releaseMemoryBootstrapSession"
      )(function* () {
        const session = yield* Effect.sync(() => {
          const retained = memoryBootstrapSession;
          memoryBootstrapSession = undefined;
          return retained !== undefined && claimActiveSessionForClose(retained)
            ? retained
            : undefined;
        });
        if (session === undefined) {
          return;
        }
        yield* closeClaimedSession(session);
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.sync(() => observeProcessHealth(options, "closed"));
          yield* Effect.sync(() => {
            shutdownRequested = true;
          });
          if (options.permissionBroker !== undefined) {
            yield* options.permissionBroker.cancelAll;
          }
          const claimedManagedSessions = yield* Effect.sync(() => {
            const claimed: RoutedAcpSession[] = [];
            for (const [conversationId, managed] of sessions) {
              sessions.delete(conversationId);
              if (
                claimActiveSessionForClose(managed.session, false) &&
                !managed.durable
              ) {
                claimed.push(managed.session);
              }
            }
            return claimed;
          });
          yield* Effect.forEach(claimedManagedSessions, closeClaimedSession, {
            concurrency: "unbounded",
            discard: true,
          });
          yield* releaseMemoryBootstrapSession();
          for (const [
            sessionId,
            registration,
          ] of memoryObservedSessionLifecycles) {
            clearLaborerMemoryPermissionRegistration(sessionId, registration);
          }
          memoryAuthorizedSessionPermissions.clear();
          memoryObservedSessionLifecycles.clear();
          memoryPermissionGate.activeToolCallIds.clear();
          quarantinedConversations.clear();
          sessionUpdateRoutes.clear();
          const cleanup = pollutedProcessCleanup;
          if (cleanup !== undefined) {
            yield* Effect.promise(() => cleanup);
          }
        })
      );

      const recordMemoryRegistrationDiagnostic = Effect.fn(
        "AcpConversationAgent.recordMemoryRegistrationDiagnostic"
      )(function* (
        code: LaborerMemoryDiagnosticCode,
        authority: { readonly root: string; readonly workspaceId: string }
      ) {
        yield* Effect.logWarning("Memory MCP registration failed", { code });
        if (
          options.agentContext !== undefined &&
          options.agentContext.root === authority.root &&
          options.agentContext.workspaceId === authority.workspaceId
        ) {
          yield* recordLaborerMemoryDiagnosticForSources({
            code,
            sources: options.agentContext,
          });
          return;
        }
        yield* recordLaborerMemoryDiagnostic({ code, ...authority });
      });

      const clearMemoryPermissionState = (): void => {
        for (const [
          sessionId,
          registration,
        ] of memoryObservedSessionLifecycles) {
          clearLaborerMemoryPermissionRegistration(sessionId, registration);
        }
        memoryAuthorizedSessionPermissions.clear();
        memoryObservedSessionLifecycles.clear();
        memoryPermissionGate.activeToolCallIds.clear();
        memoryPermissionGate.safetyDenialObserved = false;
      };

      const claimPollutedProcessState = (): RoutedAcpSession[] | undefined => {
        if (processPoisoned) {
          return undefined;
        }
        const claimed: RoutedAcpSession[] = [];
        processPoisoned = true;
        observeProcessHealth(options, "quarantined");
        memoryPermissionGate.acceptingCalls = false;
        for (const [conversationId, managed] of sessions) {
          sessions.delete(conversationId);
          if (
            claimActiveSessionForClose(managed.session, false) &&
            !managed.durable
          ) {
            claimed.push(managed.session);
          }
        }
        const bootstrapSession = memoryBootstrapSession;
        memoryBootstrapSession = undefined;
        if (
          bootstrapSession !== undefined &&
          claimActiveSessionForClose(bootstrapSession, false)
        ) {
          claimed.push(bootstrapSession);
        }
        clearMemoryPermissionState();
        if (options.permissionBroker !== undefined) {
          runPrivateEffect(options.permissionBroker.cancelAll);
        }
        return claimed;
      };

      const requireHealthyProcess = Effect.suspend(() =>
        processPoisoned ? toHandlerFailure() : Effect.void
      );

      const startPollutedProcessCleanup = (): Promise<void> => {
        if (pollutedProcessCleanup !== undefined) {
          return pollutedProcessCleanup;
        }
        const claimedSessions = claimPollutedProcessState();
        if (claimedSessions === undefined) {
          return Promise.resolve();
        }
        let resolveCleanup: () => void = () => undefined;
        const completion = new Promise<void>((resolveCompletion) => {
          resolveCleanup = resolveCompletion;
        });
        pollutedProcessCleanup = completion;
        runPrivateEffect(
          Effect.gen(function* () {
            if (options.testHooks?.afterProcessPoisoned !== undefined) {
              yield* Effect.promise(
                options.testHooks.afterProcessPoisoned
              ).pipe(Effect.ignore);
            }
            yield* Effect.forEach(claimedSessions, closeClaimedSession, {
              concurrency: "unbounded",
              discard: true,
            });
            connection.close();
            yield* releaseChild(
              acquiredChild,
              exitGraceMillis,
              options.processCleanupObserver
            );
          }).pipe(Effect.ensuring(Effect.sync(resolveCleanup)))
        );
        return completion;
      };

      const reapPollutedProcess = Effect.fn(
        "AcpConversationAgent.reapPollutedProcess"
      )(function* () {
        yield* Effect.promise(startPollutedProcessCleanup);
      });
      let runtimeIncompatibilityObserved = false;
      poisonIncompatibleProcess = () => {
        if (!runtimeIncompatibilityObserved) {
          runtimeIncompatibilityObserved = true;
          observeProcessFailure(
            options,
            "deterministic",
            "protocol_incompatible"
          );
        }
      };
      reapFailedProcess = () => {
        startPollutedProcessCleanup().catch(() => undefined);
      };

      runPrivateEffect(
        Effect.promise(() => connection.closed).pipe(
          Effect.flatMap(() =>
            acquiredChild.releaseState.requested || shutdownRequested
              ? Effect.void
              : reapPollutedProcess()
          ),
          Effect.ignore
        )
      );

      const prepareMemoryRegistration = Effect.fn(
        "AcpConversationAgent.prepareMemoryRegistration"
      )(function* () {
        if (memoryMcpServer === undefined) {
          return null;
        }
        const prepared = yield* Effect.result(
          prepareLaborerMemoryMcpRegistration(
            memoryMcpServer,
            memoryTrustedRoot
          )
        );
        if (prepared._tag === "Success") {
          return prepared.success;
        }
        const authority = laborerMemoryMcpAuthority(memoryMcpServer);
        if (authority !== null) {
          yield* recordMemoryRegistrationDiagnostic(
            "registration-invalid",
            authority
          );
        } else {
          yield* Effect.logWarning("Memory MCP registration failed", {
            code: "registration-invalid",
          });
        }
        return yield* toHandlerFailure();
      });

      const prepareActionRegistration = Effect.fn(
        "AcpConversationAgent.prepareActionRegistration"
      )(function* () {
        return actionMcpBridge === undefined
          ? null
          : yield* actionMcpBridge.prepareRegistration;
      });

      const promoteActionRegistration = Effect.fn(
        "AcpConversationAgent.promoteActionRegistration"
      )(function* (registration: PreparedActionMcpRegistration | null) {
        if (registration === null || actionMcpBridge === undefined) {
          return;
        }
        yield* actionMcpBridge.awaitCallsDrained;
        yield* actionMcpBridge.awaitReadiness(registration);
        yield* Effect.sync(() => {
          promotedActionRegistration = registration;
          for (const managed of sessions.values()) {
            managed.actionRegistration = registration;
          }
        });
      });

      const openVerifiedActionSession = Effect.fn(
        "AcpConversationAgent.openVerifiedActionSession"
      )(function* <E>(
        registration: PreparedActionMcpRegistration | null,
        openSession: Effect.Effect<RoutedAcpSession, E>
      ) {
        let retainedSession: RoutedAcpSession | undefined;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const session = yield* restore(openSession);
            retainedSession = session;
            yield* restore(promoteActionRegistration(registration));
            retainedSession = undefined;
            return session;
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) || retainedSession === undefined) {
                return Effect.void;
              }
              const session = retainedSession;
              retainedSession = undefined;
              return claimActiveSessionForClose(session)
                ? closeClaimedSession(session)
                : Effect.void;
            })
          )
        );
      });

      const awaitActiveMemoryCallsDrained = Effect.fn(
        "AcpConversationAgent.awaitActiveMemoryCallsDrained"
      )(function* (authority: {
        readonly root: string;
        readonly workspaceId: string;
      }) {
        const drained = Effect.gen(function* () {
          while (memoryPermissionGate.activeToolCallIds.size > 0) {
            yield* Effect.sleep(`${MEMORY_MCP_ACTIVE_CALL_POLL_MILLIS} millis`);
          }
        });
        const result = yield* Effect.result(
          drained.pipe(
            Effect.timeout(`${memoryMcpActiveCallDrainTimeoutMillis} millis`)
          )
        );
        if (result._tag === "Failure") {
          yield* recordMemoryRegistrationDiagnostic(
            "registration-active-call-timeout",
            authority
          );
          return yield* toHandlerFailure();
        }
      });

      const verifyMemoryRegistrationReadiness = Effect.fn(
        "AcpConversationAgent.verifyMemoryRegistrationReadiness"
      )(function* (registration: PreparedLaborerMemoryMcpRegistration) {
        const readiness = yield* Effect.result(
          awaitLaborerMemoryMcpReadiness(registration)
        );
        if (readiness._tag === "Failure") {
          yield* recordMemoryRegistrationDiagnostic(
            readiness.failure.reason === "collision"
              ? "registration-collision"
              : "registration-missing",
            registration.authority
          );
          return yield* toHandlerFailure();
        }
      });

      const startSession = Effect.fn("AcpConversationAgent.startSession")(
        function* (
          registration: PreparedLaborerMemoryMcpRegistration | null,
          actionRegistration: PreparedActionMcpRegistration | null = null
        ) {
          yield* verifySessionWorkingDirectory();
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              connection.agent.request(
                methods.agent.session.new,
                {
                  cwd: sessionWorkingDirectory,
                  mcpServers: [
                    ...(registration === null ? [] : [registration.server]),
                    ...(actionRegistration === null
                      ? []
                      : [actionRegistration.server]),
                  ],
                },
                { cancellationSignal: signal }
              ),
            catch: () => failure("session"),
          });
          const effectiveMetadata = yield* effectiveMetadataFor(
            response,
            sessionWorkingDirectory,
            registration,
            actionRegistration
          );
          return yield* Effect.try({
            try: () =>
              attachRoutedSession(response.sessionId, effectiveMetadata),
            catch: () => failure("session"),
          });
        }
      );

      const requireCurrentBindingRoot = (
        binding: ConversationAgentSessionBinding
      ): Effect.Effect<void, AcpConversationFailure | HandlerFailure> =>
        verifySessionWorkingDirectory().pipe(
          Effect.andThen(
            binding.cwd === sessionWorkingDirectory &&
              binding.cwdIdentity === sessionWorkingDirectoryIdentity
              ? Effect.void
              : failure("session")
          )
        );

      const pinnedOpenCodeSessionExists = Effect.fn(
        "AcpConversationAgent.pinnedOpenCodeSessionExists"
      )(function* (binding: ConversationAgentSessionBinding) {
        yield* requireCurrentBindingRoot(binding);
        let cursor: string | undefined;
        const observedCursors = new Set<string>();
        for (let page = 0; page < OPEN_CODE_SESSION_LIST_MAX_PAGES; page += 1) {
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              connection.agent.request(
                methods.agent.session.list,
                {
                  cwd: sessionWorkingDirectory,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                { cancellationSignal: signal }
              ),
            catch: () => failure("session"),
          });
          if (
            response.sessions.some(
              (session) => session.sessionId === binding.sessionId
            )
          ) {
            return true;
          }
          if (
            response.nextCursor === undefined ||
            response.nextCursor === null
          ) {
            return false;
          }
          if (observedCursors.has(response.nextCursor)) {
            return yield* failure("session");
          }
          observedCursors.add(response.nextCursor);
          cursor = response.nextCursor;
        }
        return yield* failure("session");
      });

      const resumeSession = Effect.fn("AcpConversationAgent.resumeSession")(
        function* (
          binding: ConversationAgentSessionBinding,
          registration: PreparedLaborerMemoryMcpRegistration | null,
          actionRegistration: PreparedActionMcpRegistration | null = null
        ) {
          yield* requireCurrentBindingRoot(binding);
          const resumed = yield* Effect.result(
            Effect.tryPromise({
              try: (signal) =>
                connection.agent.request(
                  methods.agent.session.resume,
                  {
                    cwd: sessionWorkingDirectory,
                    mcpServers: [
                      ...(registration === null ? [] : [registration.server]),
                      ...(actionRegistration === null
                        ? []
                        : [actionRegistration.server]),
                    ],
                    sessionId: binding.sessionId,
                  },
                  { cancellationSignal: signal }
                ),
              catch: (cause) => ({ cause }),
            })
          );
          if (resumed._tag === "Failure") {
            if (
              isDurableSessionUnavailable(
                resumed.failure.cause,
                binding.sessionId,
                usesOpenCodeMessageBoundary
              )
            ) {
              return yield* AcpDurableSessionUnavailable.make();
            }
            const canCorroboratePinnedMissingSession =
              usesOpenCodeMessageBoundary &&
              supportsSessionList &&
              isPinnedOpenCodeSessionServiceFailure(resumed.failure.cause);
            if (canCorroboratePinnedMissingSession) {
              const exists = yield* Effect.result(
                pinnedOpenCodeSessionExists(binding)
              );
              if (exists._tag === "Success" && !exists.success) {
                return yield* AcpDurableSessionUnavailable.make();
              }
            }
            return yield* failure("session");
          }
          const effectiveMetadata = yield* effectiveMetadataFor(
            resumed.success,
            sessionWorkingDirectory,
            registration,
            actionRegistration
          );
          return yield* Effect.try({
            try: () =>
              attachRoutedSession(binding.sessionId, effectiveMetadata),
            catch: () => failure("session"),
          });
        }
      );

      const startVerifiedMemorySession = Effect.fn(
        "AcpConversationAgent.startVerifiedMemorySession"
      )(function* <A>(
        registration: PreparedLaborerMemoryMcpRegistration,
        actionRegistration: PreparedActionMcpRegistration | null,
        openSession: Effect.Effect<
          RoutedAcpSession,
          AcpConversationFailure | HandlerFailure
        >,
        acceptSession: (session: RoutedAcpSession) => A
      ) {
        let retainedSession: RoutedAcpSession | undefined;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const session = yield* restore(
              openSession.pipe(
                Effect.timeout(`${memoryMcpBootstrapTimeoutMillis} millis`),
                Effect.tapError(() =>
                  recordMemoryRegistrationDiagnostic(
                    "registration-missing",
                    registration.authority
                  )
                ),
                Effect.mapError(toHandlerFailure)
              )
            );
            retainedSession = session;
            yield* restore(verifyMemoryRegistrationReadiness(registration));
            if (actionRegistration !== null && actionMcpBridge !== undefined) {
              yield* restore(promoteActionRegistration(actionRegistration));
            }
            const accepted = acceptSession(session);
            retainedSession = undefined;
            return accepted;
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) || retainedSession === undefined) {
                return Effect.void;
              }
              const session = retainedSession;
              retainedSession = undefined;
              return claimActiveSessionForClose(session)
                ? closeClaimedSession(session)
                : Effect.void;
            })
          )
        );
      });

      const resumeVerifiedMemorySession = Effect.fn(
        "AcpConversationAgent.resumeVerifiedMemorySession"
      )(function* (
        binding: ConversationAgentSessionBinding,
        registration: PreparedLaborerMemoryMcpRegistration,
        actionRegistration: PreparedActionMcpRegistration | null
      ) {
        let retainedSession: RoutedAcpSession | undefined;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const session = yield* restore(
              resumeSession(binding, registration, actionRegistration).pipe(
                Effect.timeout(`${memoryMcpBootstrapTimeoutMillis} millis`)
              )
            );
            retainedSession = session;
            yield* restore(verifyMemoryRegistrationReadiness(registration));
            if (actionRegistration !== null && actionMcpBridge !== undefined) {
              yield* restore(promoteActionRegistration(actionRegistration));
            }
            retainedSession = undefined;
            return session;
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) || retainedSession === undefined) {
                return Effect.void;
              }
              const session = retainedSession;
              retainedSession = undefined;
              return claimActiveSessionForClose(session)
                ? closeClaimedSession(session)
                : Effect.void;
            })
          )
        );
      });

      const beginMemoryRegistration = Effect.fn(
        "AcpConversationAgent.beginMemoryRegistration"
      )(function* (registration: PreparedLaborerMemoryMcpRegistration) {
        yield* Effect.sync(() => {
          memoryPermissionGate.acceptingCalls = false;
          memoryPermissionGate.safetyDenialObserved = false;
        });
        yield* awaitActiveMemoryCallsDrained(registration.authority);
        if (actionMcpBridge !== undefined) {
          yield* actionMcpBridge.awaitCallsDrained;
        }
      });

      const activateMemoryPermission = (
        session: RoutedAcpSession,
        registration: PreparedLaborerMemoryMcpRegistration
      ): void => {
        const permissionRegistration: LaborerMemoryPermissionRegistration = {
          consumedToolCallIds: new Set<string>(),
          gate: memoryPermissionGate,
          generation: registration.readinessNonce,
          observedFingerprints: new Map(),
          observedToolCallIds: new Set<string>(),
          permission: registration.permission,
          pinnedOpenCodeVersion:
            commandIsOpenCode && reportsSupportedOpenCode
              ? (initialized.agentInfo?.version as "1.18.4")
              : null,
          rejectedToolCallIds: new Set<string>(),
          rejectUncorrelatedPermissions: false,
        };
        memoryAuthorizedSessionPermissions.set(
          session.sessionId,
          permissionRegistration
        );
        memoryObservedSessionLifecycles.set(
          session.sessionId,
          permissionRegistration
        );
        memoryPermissionGate.acceptingCalls = true;
        memoryPermissionGate.safetyDenialObserved = false;
      };

      const createManagedSession = Effect.fn(
        "AcpConversationAgent.createManagedSession"
      )(function* (conversationId: string, memoryEnabled: boolean) {
        yield* requireHealthyProcess;
        if (sessions.size >= activeSessionLimit) {
          return yield* toHandlerFailure();
        }
        const actionRegistration = yield* prepareActionRegistration();
        if (!memoryEnabled) {
          const session = yield* openVerifiedActionSession(
            actionRegistration,
            startSession(null, actionRegistration)
          );
          const created: ManagedSession = {
            actionRegistration,
            durable: false,
            generation: allocateSessionGeneration(),
            introducedParticipantIds: new Set<string>(),
            needsInitialContext: options.agentContext !== undefined,
            replacementParticipantIds: [],
            session,
          };
          sessions.set(conversationId, created);
          return created;
        }
        return yield* memoryRegistrationGate.withPermit(
          Effect.gen(function* () {
            yield* requireHealthyProcess;
            const registration = yield* prepareMemoryRegistration();
            if (registration === null) {
              return yield* toHandlerFailure();
            }
            yield* beginMemoryRegistration(registration);
            return yield* startVerifiedMemorySession(
              registration,
              actionRegistration,
              startSession(registration, actionRegistration),
              (session) => {
                const created: ManagedSession = {
                  actionRegistration,
                  durable: false,
                  generation: allocateSessionGeneration(),
                  introducedParticipantIds: new Set<string>(),
                  needsInitialContext: options.agentContext !== undefined,
                  replacementParticipantIds: [],
                  session,
                };
                activateMemoryPermission(session, registration);
                sessions.set(conversationId, created);
                return created;
              }
            );
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? reapPollutedProcess() : Effect.void
            )
          )
        );
      });

      const bootstrapMemoryRegistration = Effect.fn(
        "AcpConversationAgent.bootstrapMemoryRegistration"
      )(function* () {
        const registration = yield* prepareMemoryRegistration();
        if (registration === null) {
          return false;
        }
        yield* beginMemoryRegistration(registration);
        return yield* startVerifiedMemorySession(
          registration,
          null,
          startSession(registration),
          (session) => {
            memoryBootstrapSession = session;
            memoryPermissionGate.acceptingCalls = true;
            memoryPermissionGate.safetyDenialObserved = false;
            return true;
          }
        );
      });

      const memoryEnabled =
        options.durableSessionMode === true
          ? memoryMcpServer !== undefined
          : yield* memoryRegistrationGate.withPermit(
              bootstrapMemoryRegistration().pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? releaseMemoryBootstrapSession()
                    : Effect.void
                )
              )
            );

      const persistDurableSession = Effect.fn(
        "AcpConversationAgent.persistDurableSession"
      )(function* (
        request: ConversationAgentRequest,
        previous: ConversationAgentSessionBinding | null,
        session: RoutedAcpSession
      ) {
        const store = request.sessionBindingStore;
        if (store === undefined) {
          return yield* toHandlerFailure();
        }
        yield* verifySessionWorkingDirectory();
        return yield* store.replace(previous?.generation ?? null, {
          ambiguousPromptId:
            request.recovery === undefined
              ? (previous?.ambiguousPromptId ?? null)
              : null,
          cwd: sessionWorkingDirectory,
          cwdIdentity: sessionWorkingDirectoryIdentity,
          effectiveMetadata:
            session.effectiveMetadata?.metadata ??
            previous?.effectiveMetadata ??
            null,
          effectiveMetadataFingerprint:
            session.effectiveMetadata?.fingerprint ??
            previous?.effectiveMetadataFingerprint ??
            null,
          initializationPhase: "pending",
          introducedParticipantIds: [],
          lastAttachedProcessGeneration: options.processGeneration ?? 1,
          pendingParticipantIds:
            previous === null
              ? []
              : [
                  ...new Set([
                    ...previous.introducedParticipantIds,
                    ...previous.pendingParticipantIds,
                  ]),
                ],
          requiresReplacement: false,
          sessionId: session.sessionId,
        });
      });

      const retainDurableManagedSession = (options: {
        readonly actionRegistration: PreparedActionMcpRegistration | null;
        readonly binding: ConversationAgentSessionBinding;
        readonly conversationId: string;
        readonly registration: PreparedLaborerMemoryMcpRegistration | null;
        readonly session: RoutedAcpSession;
      }): ManagedSession => {
        const initializationIsPending =
          options.binding.initializationPhase === "pending";
        const introducedParticipantIds = initializationIsPending
          ? options.binding.introducedParticipantIds
          : [
              ...new Set([
                ...options.binding.introducedParticipantIds,
                ...options.binding.pendingParticipantIds,
              ]),
            ];
        const managed: ManagedSession = {
          actionRegistration: options.actionRegistration,
          durable: true,
          generation: options.binding.generation,
          introducedParticipantIds: new Set(introducedParticipantIds),
          needsInitialContext: initializationIsPending,
          replacementParticipantIds: initializationIsPending
            ? options.binding.pendingParticipantIds
            : [],
          session: options.session,
        };
        if (options.registration !== null) {
          activateMemoryPermission(options.session, options.registration);
        }
        sessions.set(options.conversationId, managed);
        return managed;
      };

      const openDurableReplacement = Effect.fn(
        "AcpConversationAgent.openDurableReplacement"
      )(function* (
        request: ConversationAgentRequest,
        previous: ConversationAgentSessionBinding | null,
        openNew: Effect.Effect<
          RoutedAcpSession,
          AcpConversationFailure | HandlerFailure
        >,
        registration: PreparedLaborerMemoryMcpRegistration | null,
        actionRegistration: PreparedActionMcpRegistration | null
      ) {
        let retainedSession: RoutedAcpSession | undefined;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const session = yield* restore(openNew);
            retainedSession = session;
            if (options.testHooks?.beforeDurableBindingPersist !== undefined) {
              yield* restore(
                Effect.tryPromise({
                  try: options.testHooks.beforeDurableBindingPersist,
                  catch: toHandlerFailure,
                })
              );
            }
            const binding = yield* restore(
              persistDurableSession(request, previous, session)
            );
            if (options.testHooks?.afterDurableBindingPersisted !== undefined) {
              yield* restore(
                Effect.tryPromise({
                  try: options.testHooks.afterDurableBindingPersisted,
                  catch: toHandlerFailure,
                })
              );
            }
            const managed = retainDurableManagedSession({
              actionRegistration,
              binding,
              conversationId: request.conversationId,
              registration,
              session,
            });
            retainedSession = undefined;
            return managed;
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) || retainedSession === undefined) {
                return Effect.void;
              }
              const session = retainedSession;
              retainedSession = undefined;
              return claimActiveSessionForClose(session)
                ? closeClaimedSession(session)
                : Effect.void;
            })
          )
        );
      });

      const refreshEffectiveMetadata = Effect.fn(
        "AcpConversationAgent.refreshEffectiveMetadata"
      )(function* (
        request: ConversationAgentRequest,
        persisted: ConversationAgentSessionBinding,
        resumedSession: RoutedAcpSession
      ) {
        const effectiveMetadata = resumedSession.effectiveMetadata;
        if (effectiveMetadata === null) {
          return persisted;
        }
        if (
          persisted.effectiveMetadataFingerprint != null &&
          persisted.effectiveMetadataFingerprint !==
            effectiveMetadata.fingerprint
        ) {
          yield* Effect.logWarning("ACP effective configuration drifted", {
            code: "effective-configuration-drift",
          });
        }
        const store = request.sessionBindingStore;
        if (store === undefined) {
          return yield* toHandlerFailure();
        }
        return yield* store.recordEffectiveMetadata(
          persisted.generation,
          effectiveMetadata.metadata,
          effectiveMetadata.fingerprint
        );
      });

      const resumeOrReplaceDurableSession = Effect.fn(
        "AcpConversationAgent.resumeOrReplaceDurableSession"
      )(function* (
        request: ConversationAgentRequest,
        persisted: ConversationAgentSessionBinding,
        openNew: Effect.Effect<
          RoutedAcpSession,
          AcpConversationFailure | HandlerFailure
        >,
        registration: PreparedLaborerMemoryMcpRegistration | null,
        actionRegistration: PreparedActionMcpRegistration | null
      ) {
        const resumeEffect =
          registration === null
            ? openVerifiedActionSession(
                actionRegistration,
                resumeSession(persisted, null, actionRegistration)
              )
            : resumeVerifiedMemorySession(
                persisted,
                registration,
                actionRegistration
              );
        const resumed = yield* Effect.result(resumeEffect);
        if (resumed._tag === "Success") {
          const metadataBinding = yield* refreshEffectiveMetadata(
            request,
            persisted,
            resumed.success
          );
          const binding =
            request.sessionBindingStore === undefined
              ? metadataBinding
              : yield* request.sessionBindingStore.recordProcessAttachment(
                  metadataBinding.generation,
                  options.processGeneration ?? 1
                );
          return retainDurableManagedSession({
            actionRegistration,
            binding,
            conversationId: request.conversationId,
            registration,
            session: resumed.success,
          });
        }
        if (resumed.failure._tag === "AcpDurableSessionUnavailable") {
          if (
            request.adoptionHistory !== undefined &&
            request.recovery === undefined
          ) {
            return yield* toHandlerFailure();
          }
          return yield* openDurableReplacement(
            request,
            persisted,
            openNew,
            registration,
            actionRegistration
          );
        }
        quarantinedConversations.add(request.conversationId);
        yield* Effect.logWarning("ACP durable session quarantined", {
          code: "resume-failed",
        });
        yield* reapPollutedProcess();
        return yield* toHandlerFailure();
      });

      const prepareDurableSessionOpen = Effect.fn(
        "AcpConversationAgent.prepareDurableSessionOpen"
      )(function* () {
        const registration = memoryEnabled
          ? yield* prepareMemoryRegistration()
          : null;
        const actionRegistration = yield* prepareActionRegistration();
        if (memoryEnabled && registration === null) {
          return yield* toHandlerFailure();
        }
        if (registration !== null) {
          yield* beginMemoryRegistration(registration);
        } else if (actionMcpBridge !== undefined) {
          yield* actionMcpBridge.awaitCallsDrained;
        }
        const openNew =
          registration === null
            ? openVerifiedActionSession(
                actionRegistration,
                startSession(null, actionRegistration)
              )
            : startVerifiedMemorySession(
                registration,
                actionRegistration,
                startSession(registration, actionRegistration),
                (session) => session
              );
        return { actionRegistration, openNew, registration };
      });

      const openDurableSession = Effect.fn(
        "AcpConversationAgent.openDurableSession"
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Durable session replacement keeps adoption, recovery, root authority, and resume ordering in one state-machine boundary.
      )(function* (
        request: ConversationAgentRequest,
        persisted: ConversationAgentSessionBinding | null
      ) {
        yield* requireHealthyProcess;
        yield* verifySessionWorkingDirectory();
        const { actionRegistration, openNew, registration } =
          yield* prepareDurableSessionOpen();
        if (persisted === null) {
          if (request.sessionBindingStore?.beginSessionCreation !== undefined) {
            yield* request.sessionBindingStore.beginSessionCreation();
          }
          return yield* openDurableReplacement(
            request,
            null,
            openNew,
            registration,
            actionRegistration
          );
        }
        const replacementRequested =
          persisted.requiresReplacement === true ||
          (request.recovery !== undefined &&
            persisted.generation ===
              request.recovery.previousBindingGeneration);
        const bindingRootChanged =
          persisted.cwd !== sessionWorkingDirectory ||
          persisted.cwdIdentity !== sessionWorkingDirectoryIdentity;
        const adoptionBlocksAutomaticReplacement =
          request.adoptionHistory !== undefined &&
          request.recovery === undefined;
        if (
          adoptionBlocksAutomaticReplacement &&
          (replacementRequested || bindingRootChanged)
        ) {
          return yield* toHandlerFailure();
        }
        if (replacementRequested) {
          yield* options.permissionBroker?.cancelAll ?? Effect.void;
          yield* Effect.tryPromise({
            try: () =>
              connection.agent.notify(methods.agent.session.close, {
                sessionId: persisted.sessionId,
              }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
          return yield* openDurableReplacement(
            request,
            persisted,
            openNew,
            registration,
            actionRegistration
          );
        }
        if (bindingRootChanged) {
          yield* Effect.logWarning(
            "ACP durable session root authority changed",
            { code: "session-root-changed" }
          );
          return yield* openDurableReplacement(
            request,
            persisted,
            openNew,
            registration,
            actionRegistration
          );
        }
        return yield* resumeOrReplaceDurableSession(
          request,
          persisted,
          openNew,
          registration,
          actionRegistration
        );
      });

      const createDurableManagedSession = Effect.fn(
        "AcpConversationAgent.createDurableManagedSession"
      )(function* (request: ConversationAgentRequest) {
        const store = request.sessionBindingStore;
        if (store === undefined) {
          return yield* toHandlerFailure();
        }
        if (quarantinedConversations.has(request.conversationId)) {
          return yield* toHandlerFailure();
        }
        if (sessions.size >= activeSessionLimit) {
          return yield* toHandlerFailure();
        }
        if (!(usesOpenCodeMessageBoundary || supportsPromptEpochExtension)) {
          quarantinedConversations.add(request.conversationId);
          yield* Effect.logWarning("ACP durable session quarantined", {
            code: "prompt-epoch-capability-missing",
          });
          return yield* toHandlerFailure();
        }
        if (!supportsSessionResume) {
          quarantinedConversations.add(request.conversationId);
          yield* Effect.logWarning("ACP durable session quarantined", {
            code: "resume-capability-missing",
          });
          return yield* toHandlerFailure();
        }
        const persisted = yield* store.load;

        return yield* memoryRegistrationGate.withPermit(
          openDurableSession(request, persisted).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? reapPollutedProcess() : Effect.void
            )
          )
        );
      });

      const mustReplaceExistingSession = Effect.fnUntraced(function* (
        request: ConversationAgentRequest,
        existing: ManagedSession
      ) {
        const persisted =
          request.sessionBindingStore === undefined
            ? null
            : yield* request.sessionBindingStore.load;
        return (
          persisted?.requiresReplacement === true ||
          (request.recovery !== undefined &&
            existing.generation === request.recovery.previousBindingGeneration)
        );
      });

      const sessionFor = Effect.fn("AcpConversationAgent.sessionFor")(
        function* (request: ConversationAgentRequest) {
          yield* requireHealthyProcess;
          const existing = sessions.get(request.conversationId);
          if (existing !== undefined) {
            if (yield* mustReplaceExistingSession(request, existing)) {
              sessions.delete(request.conversationId);
              if (claimActiveSessionForClose(existing.session)) {
                yield* options.permissionBroker?.cancelAll ?? Effect.void;
                yield* closeClaimedSession(existing.session);
              }
            } else {
              return existing;
            }
          }
          const usesDurableBinding =
            options.durableSessionMode === true &&
            request.sessionBindingStore !== undefined;
          return yield* usesDurableBinding
            ? createDurableManagedSession(request)
            : createManagedSession(request.conversationId, memoryEnabled);
        }
      );

      const invalidateSession = (
        conversationId: string,
        managed: ManagedSession
      ) =>
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation, authority revocation, routing disposal, and process poisoning must retain this cleanup order.
        Effect.fnUntraced(function* (prompt: ActivePrompt) {
          const { session } = managed;
          if (prompt.terminal.current) {
            return;
          }
          if (prompt.localCancellationIntent.current === null) {
            prompt.localCancellationIntent.current = "local";
            if (
              prompt.attemptId !== null &&
              prompt.attemptStore !== undefined
            ) {
              yield* prompt.attemptStore
                .markCancellationIntent(prompt.attemptId, "local")
                .pipe(Effect.ignore);
            }
          }
          yield* prompt.closePermissions;
          const claimed = yield* Effect.sync(() => {
            prompt.cancellation.abort();
            if (sessions.get(conversationId)?.session === session) {
              sessions.delete(conversationId);
            }
            return claimActiveSessionForClose(session);
          });
          if (claimed) {
            yield* Effect.tryPromise({
              try: () =>
                connection.agent.notify(methods.agent.session.cancel, {
                  sessionId: session.sessionId,
                }),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            if (!managed.durable) {
              yield* closeClaimedSession(session);
            }
          }
          const settlement = yield* Effect.promise(() =>
            awaitPromptSettlement(prompt.completion, CHILD_EXIT_GRACE_MILLIS)
          );
          if (
            settlement._tag === "Completed" &&
            settlement.response.stopReason === "cancelled"
          ) {
            yield* prompt
              .completeTerminal("cancelled_local")
              .pipe(Effect.ignore);
            prompt.terminal.current = true;
            return;
          }
          if (settlement._tag === "TimedOut") {
            yield* reapPollutedProcess();
          }
          if (prompt.attemptId !== null && prompt.attemptStore !== undefined) {
            const timestamp = yield* Clock.currentTimeMillis;
            yield* prompt.attemptStore
              .markInterrupted(prompt.attemptId, "unresolved", timestamp)
              .pipe(Effect.ignore);
          }
        });

      const preparePromptBinding = Effect.fnUntraced(function* (
        request: ConversationAgentRequest,
        managed: ManagedSession,
        introducedParticipantIds: readonly string[]
      ) {
        const initializesSession = managed.needsInitialContext;
        if (!managed.durable || request.sessionBindingStore === undefined) {
          return { completeBinding: Effect.void };
        }
        yield* request.sessionBindingStore.beginPrompt(
          managed.generation,
          introducedParticipantIds,
          initializesSession,
          request.promptId
        );
        return {
          completeBinding: request.sessionBindingStore
            .completePrompt(managed.generation)
            .pipe(Effect.asVoid),
        };
      });

      const activatePromptPermissions = Effect.fnUntraced(function* (
        request: ConversationAgentRequest,
        managed: ManagedSession
      ) {
        const turnScope =
          request.turnAuthority == null
            ? null
            : {
                bindingGeneration: managed.generation,
                channelId: request.turnAuthority.channelId,
                conversationId: request.conversationId,
                processGeneration: options.processGeneration ?? 1,
                promptId: request.promptId,
                rootTs: request.turnAuthority.rootTs,
                sessionId: managed.session.sessionId,
                turnId: request.turnId,
                workspaceId: options.agentContext?.workspaceId ?? "local",
              };
        const closeHumanPermissions =
          options.permissionBroker === undefined || turnScope === null
            ? Effect.void
            : yield* options.permissionBroker.activateTurn({
                ...turnScope,
                authorizedSlackUserId:
                  request.turnAuthority?.authorizedSlackUserId ?? null,
              });
        const closeActionCapabilities =
          actionMcpBridge === undefined || turnScope === null
            ? Effect.void
            : yield* Effect.gen(function* () {
                const actionRegistration = promotedActionRegistration;
                if (actionRegistration === null) {
                  return yield* toHandlerFailure();
                }
                yield* Effect.sync(() => {
                  managed.actionRegistration = actionRegistration;
                });
                return yield* actionMcpBridge.activateTurn({
                  actionServerGeneration:
                    actionRegistration.actionServerGeneration,
                  actions: request.actions,
                  controls: request.executionControls,
                  scope: turnScope,
                });
              });
        return {
          closePermissions: Effect.all(
            [closeActionCapabilities, closeHumanPermissions],
            { discard: true }
          ),
        };
      });

      const completePromptTerminal = Effect.fnUntraced(function* (options_: {
        readonly attemptId: string | null;
        readonly attemptStore: ConversationPromptAttemptStore | undefined;
        readonly bindingGeneration: number | null;
        readonly completeBinding: Effect.Effect<void, HandlerFailure>;
        readonly outcome: ConversationPromptAttemptOutcome;
      }) {
        if (
          options_.attemptId === null ||
          options_.attemptStore === undefined
        ) {
          yield* options_.completeBinding;
          return;
        }
        if (options.testHooks?.beforeTerminalCommit !== undefined) {
          yield* Effect.tryPromise({
            try: options.testHooks.beforeTerminalCommit,
            catch: toHandlerFailure,
          });
        }
        const timestamp = yield* Clock.currentTimeMillis;
        yield* options_.attemptStore.markTerminalAndCompleteBinding(
          options_.attemptId,
          options_.outcome,
          timestamp,
          options_.bindingGeneration
        );
        if (options.testHooks?.afterTerminalCommit !== undefined) {
          yield* Effect.tryPromise({
            try: options.testHooks.afterTerminalCommit,
            catch: toHandlerFailure,
          });
        }
      });

      const submitOwnedPrompt = (
        request: ConversationAgentRequest,
        managed: ManagedSession,
        input: readonly ContentBlock[],
        introducedParticipantIds: readonly string[],
        attemptId: string | null,
        attemptStore: ConversationPromptAttemptStore | undefined,
        completeBinding: Effect.Effect<void, HandlerFailure>,
        closePermissions: Effect.Effect<void>
      ): Effect.Effect<ActivePrompt, AcpConversationFailure> =>
        Effect.try({
          try: () => {
            const registered = sessions.get(request.conversationId);
            const sessionIsOwned =
              !processPoisoned &&
              registered === managed &&
              registered.session === managed.session &&
              registered.generation === managed.generation &&
              !claimedSessionClosures.has(managed.session);
            if (!sessionIsOwned) {
              throw new Error("ACP session ownership changed before prompt");
            }
            const cancellation = new AbortController();
            const localCancellationIntent = { current: null } satisfies {
              current: "deadline" | "local" | "shutdown" | null;
            };
            const completion = managed.session.prompt(input, {
              cancellationSignal: cancellation.signal,
            });
            managed.needsInitialContext = false;
            for (const participantId of introducedParticipantIds) {
              managed.introducedParticipantIds.add(participantId);
            }
            completion.catch(() => undefined);
            return {
              attemptId,
              attemptStore,
              cancellation,
              closePermissions,
              completeTerminal: (outcome) =>
                completePromptTerminal({
                  attemptId,
                  attemptStore,
                  bindingGeneration: managed.durable
                    ? managed.generation
                    : null,
                  completeBinding,
                  outcome,
                }),
              completion,
              localCancellationIntent,
              notifyCancel: Effect.tryPromise({
                try: () =>
                  connection.agent.notify(methods.agent.session.cancel, {
                    sessionId: managed.session.sessionId,
                  }),
                catch: () => undefined,
              }).pipe(Effect.ignore),
              recordUnknownStop:
                attemptId !== null && attemptStore !== undefined
                  ? Effect.gen(function* () {
                      const timestamp = yield* Clock.currentTimeMillis;
                      yield* attemptStore.markUnknownStop(attemptId, timestamp);
                    })
                  : Effect.void,
              terminal: { current: false },
            };
          },
          catch: () => failure("prompt"),
        });

      const startOwnedPrompt = (
        request: ConversationAgentRequest,
        managed: ManagedSession,
        input: readonly ContentBlock[],
        introducedParticipantIds: readonly string[]
      ): Effect.Effect<
        ActivePrompt,
        AcpConversationFailure | HandlerFailure
      > => {
        const attemptStore = request.promptAttemptStore;
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Prepared/submitting publication and capability activation are one crash-boundary state machine.
        return Effect.gen(function* () {
          const attemptId =
            attemptStore === undefined
              ? null
              : (request.recovery?.replacementAttemptId ??
                request.promptAttemptId ??
                randomUUID());
          if (attemptStore !== undefined && attemptId !== null) {
            const preparedAt = yield* Clock.currentTimeMillis;
            yield* attemptStore.prepare({
              attemptId,
              bindingGeneration: managed.durable ? managed.generation : null,
              preparedAt,
              processGeneration: options.processGeneration ?? 1,
              ...(request.recovery === undefined
                ? {}
                : { recoveryDecisionId: request.recovery.decisionId }),
              sessionDigest: createHash("sha256")
                .update("acp-session\0", "utf8")
                .update(managed.session.sessionId, "utf8")
                .digest("base64url"),
            });
          }
          const { completeBinding } = yield* preparePromptBinding(
            request,
            managed,
            introducedParticipantIds
          );
          if (options.testHooks?.beforePromptSubmission !== undefined) {
            yield* Effect.tryPromise({
              try: options.testHooks.beforePromptSubmission,
              catch: toHandlerFailure,
            });
          }
          const { closePermissions } = yield* activatePromptPermissions(
            request,
            managed
          );
          if (attemptStore !== undefined && attemptId !== null) {
            const submittedAt = yield* Clock.currentTimeMillis;
            yield* attemptStore.markSubmitting(attemptId, submittedAt);
          }
          return yield* submitOwnedPrompt(
            request,
            managed,
            input,
            introducedParticipantIds,
            attemptId,
            attemptStore,
            completeBinding,
            closePermissions
          ).pipe(Effect.tapError(() => closePermissions));
        }).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || attemptStore === undefined) {
              return Effect.void;
            }
            return Effect.gen(function* () {
              const attempt = yield* attemptStore.latest;
              if (attempt === null || attempt.phase === "terminal") {
                return;
              }
              const timestamp = yield* Clock.currentTimeMillis;
              yield* attemptStore
                .markInterrupted(
                  attempt.attemptId,
                  attempt.phase === "submitting" ? "unresolved" : "retryable",
                  timestamp
                )
                .pipe(Effect.asVoid);
            }).pipe(Effect.ignore);
          })
        );
      };

      const handle: ConversationAgentShape["handle"] = (
        request,
        publishMessage
      ) => {
        if (publishMessage === undefined) {
          return toHandlerFailure();
        }
        return Effect.gen(function* () {
          yield* requireHealthyProcess;
          return yield* workspacePromptGate.withPermit(
            Effect.gen(function* () {
              yield* requireHealthyProcess;
              const requiredInput =
                options.agentContext === undefined
                  ? request.input
                  : renderAcpPrompt(request);
              if (
                textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES
              ) {
                return yield* failure("prompt");
              }
              const managed = yield* sessionFor(request);
              if (managed === null) {
                return [];
              }
              const participantIds =
                options.agentContext === undefined
                  ? []
                  : [
                      ...new Set([
                        ...managed.replacementParticipantIds.filter(
                          (participantId) =>
                            !managed.introducedParticipantIds.has(participantId)
                        ),
                        ...newHumanParticipantIds(
                          request,
                          managed.introducedParticipantIds,
                          options.laborerSlackId
                        ),
                      ]),
                    ];
              return yield* runPrompt(
                managed.session,
                request,
                requiredInput,
                options.agentContext,
                managed.needsInitialContext,
                options.participantLookup,
                participantIds,
                (input, introducedParticipantIds) =>
                  startOwnedPrompt(
                    request,
                    managed,
                    input,
                    introducedParticipantIds
                  ),
                publishMessage,
                invalidateSession(request.conversationId, managed),
                configuredPromptDeadlineMillis(options),
                options.imageStorageRoot,
                initialized.agentCapabilities?.promptCapabilities?.image ===
                  true
              );
            })
          );
        }).pipe(
          Effect.catchTag("AcpConversationFailure", () => toHandlerFailure())
        );
      };

      const recover: NonNullable<ConversationAgentShape["recover"]> = (
        request,
        publishMessage
      ) => {
        if (publishMessage === undefined) {
          return toHandlerFailure();
        }
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery deliberately makes every terminal, retryable, unresolved, and legacy binding branch explicit.
        return Effect.gen(function* () {
          yield* requireHealthyProcess;
          const latestAttempt =
            request.promptAttemptStore === undefined
              ? null
              : yield* request.promptAttemptStore.latest;
          if (request.recovery !== undefined) {
            if (
              latestAttempt?.attemptId ===
                request.recovery.replacementAttemptId &&
              latestAttempt.recoveryClass === "unresolved"
            ) {
              return yield* ambiguousPromptRecoveryFailure();
            }
            return yield* handle(request, publishMessage);
          }
          if (latestAttempt?.recoveryClass === "unresolved") {
            return yield* ambiguousPromptRecoveryFailure();
          }
          if (
            latestAttempt?.phase === "terminal" &&
            latestAttempt.outcome !== null
          ) {
            if (request.promptAttemptStore !== undefined) {
              const timestamp =
                latestAttempt.terminalAt ?? (yield* Clock.currentTimeMillis);
              yield* request.promptAttemptStore.markTerminalAndCompleteBinding(
                latestAttempt.attemptId,
                latestAttempt.outcome,
                timestamp,
                latestAttempt.bindingGeneration
              );
            }
            return latestAttempt.outcome === "end_turn"
              ? ([] as const)
              : yield* terminalStopFailure(latestAttempt.outcome);
          }
          if (latestAttempt?.recoveryClass === "retryable") {
            return yield* handle(request, publishMessage);
          }
          const store = request.sessionBindingStore;
          if (options.durableSessionMode !== true || store === undefined) {
            return yield* ambiguousPromptRecoveryFailure();
          }
          const persisted = yield* store.load;
          if (bindingIsDefinitelyUnsubmitted(persisted)) {
            return yield* handle(request, publishMessage);
          }
          const definitelyUnsubmitted = yield* workspacePromptGate.withPermit(
            Effect.gen(function* () {
              yield* requireHealthyProcess;
              const latest = yield* store.load;
              if (bindingIsDefinitelyUnsubmitted(latest)) {
                return true;
              }
              const managed = yield* sessionFor(request);
              if (managed === null) {
                return yield* toHandlerFailure();
              }
              return false;
            })
          );
          if (definitelyUnsubmitted) {
            return yield* handle(request, publishMessage);
          }
          yield* Effect.logWarning("ACP prompt recovery requires resolution", {
            code: "prompt-submission-ambiguous",
          });
          return yield* ambiguousPromptRecoveryFailure();
        }).pipe(
          Effect.catchTag("AcpConversationFailure", () => toHandlerFailure())
        );
      };

      const replaceAmbiguousSession: NonNullable<
        ConversationAgentShape["replaceAmbiguousSession"]
      > = (request) =>
        workspacePromptGate
          .withPermit(sessionFor(request).pipe(Effect.asVoid))
          .pipe(
            Effect.catchTag("AcpConversationFailure", () => toHandlerFailure())
          );

      observeProcessHealth(options, "ready");
      return {
        handle,
        recover,
        replaceAmbiguousSession,
      };
    }).pipe(Effect.provideService(Scope.Scope, constructionScope));
    return yield* setup.pipe(
      Effect.tap(() =>
        Effect.addFinalizer((exit) => Scope.close(constructionScope, exit))
      ),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.sync(() =>
              observeProcessHealth(options, "quarantined")
            ).pipe(Effect.andThen(Scope.close(constructionScope, exit)))
          : Effect.void
      )
    );
  }
);
