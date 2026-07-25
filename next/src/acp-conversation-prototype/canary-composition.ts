/** Isolated issue #235 composition; it is not part of production startup. */
import { Effect, type Layer, type Scope } from "effect";
import type { HandlerFailure, StoreError } from "../prototype/errors.ts";
import type {
  ActivationAcknowledgerShape,
  CompletionReactorShape,
  SlackGatewayShape,
} from "../prototype/runtime.ts";
import {
  makePrototypeHarness,
  type PrototypeHarness,
} from "../prototype/runtime.ts";
import type { PrototypeStore } from "../prototype/store.ts";
import { makeFileStoreLayer } from "../prototype/store.ts";
import { makeReferenceCodingApplication } from "../reference-coding-application.ts";
import { prepareSlackRuntimePaths } from "../slack/runtime-paths.ts";
import {
  type AcpConversationAgentOptions,
  makeAcpConversationAgent,
} from "./acp-conversation-agent.ts";
import { prepareAcpAgentContextSources } from "./agent-context.ts";
import { makeLaborerMemoryMcpServerConfiguration } from "./memory-mcp.ts";
import type { SlackParticipantLookupShape } from "./slack-participant-lookup.ts";

export const OPEN_CODE_ACP_COMMAND = "opencode";
export const OPEN_CODE_ACP_ARGS = ["acp"] as const;

interface OpenCodeAcpProcessOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export const openCodeAcpProcessOptions = (
  options: OpenCodeAcpProcessOptions
): AcpConversationAgentOptions => ({
  args: OPEN_CODE_ACP_ARGS,
  command: options.command ?? OPEN_CODE_ACP_COMMAND,
  cwd: options.cwd,
  ...(options.environment === undefined
    ? {}
    : { environment: options.environment }),
});

export interface AcpConversationCanaryOptions {
  readonly activationAcknowledger: ActivationAcknowledgerShape;
  readonly completionReactor: CompletionReactorShape;
  readonly configRoot?: string;
  readonly laborerSlackId: string;
  readonly participantLookup?: SlackParticipantLookupShape;
  readonly process: AcpConversationAgentOptions;
  readonly slack: SlackGatewayShape;
  readonly stateRoot?: string;
  readonly storeLayer?: Layer.Layer<PrototypeStore, StoreError>;
  readonly workspaceId?: string;
}

export type WorkspaceBoundAcpConversationCanaryOptions = Omit<
  AcpConversationCanaryOptions,
  "storeLayer" | "workspaceId"
> & {
  readonly workspaceId: string;
};

const outsideCanary = (resource: string) =>
  Effect.die(
    new Error(`${resource} is outside the isolated ACP conversation canary`)
  );

/**
 * Reuses the reference application and Runner's capability-selected publisher.
 * Actions and implementation agents intentionally remain outside this proof.
 */
export const makeAcpConversationCanary = Effect.fn("makeAcpConversationCanary")(
  function* (
    options: AcpConversationCanaryOptions
  ): Effect.fn.Return<
    PrototypeHarness,
    HandlerFailure | StoreError,
    Scope.Scope
  > {
    const agentContext =
      options.workspaceId === undefined
        ? undefined
        : yield* prepareAcpAgentContextSources({
            ...(options.configRoot === undefined
              ? {}
              : { configRoot: options.configRoot }),
            root: options.process.cwd,
            ...(options.stateRoot === undefined
              ? {}
              : { stateRoot: options.stateRoot }),
            workspaceId: options.workspaceId,
          });
    const conversationAgent = yield* makeAcpConversationAgent({
      ...options.process,
      ...(agentContext === undefined ? {} : { agentContext }),
      laborerSlackId: options.laborerSlackId,
      ...(options.participantLookup === undefined
        ? {}
        : { participantLookup: options.participantLookup }),
      ...(agentContext === undefined
        ? {}
        : {
            memoryMcpServer:
              makeLaborerMemoryMcpServerConfiguration(agentContext),
          }),
    });
    const application = yield* makeReferenceCodingApplication({
      conversationAgent,
      implementationAgent: {
        start: () => outsideCanary("Implementation agents"),
      },
      worktreeManager: {
        create: () => outsideCanary("Actions"),
      },
    });
    return yield* makePrototypeHarness({
      activationAcknowledger: options.activationAcknowledger,
      application,
      completionReactor: options.completionReactor,
      laborerSlackId: options.laborerSlackId,
      slack: options.slack,
      ...(options.storeLayer === undefined
        ? {}
        : { storeLayer: options.storeLayer }),
    });
  }
);

/** Live workspace binding with Runner and ACP durability in distinct files. */
export const makeWorkspaceBoundAcpConversationCanary = Effect.fn(
  "makeWorkspaceBoundAcpConversationCanary"
)(function* (options: WorkspaceBoundAcpConversationCanaryOptions) {
  const paths = yield* prepareSlackRuntimePaths(
    options.process.cwd,
    options.workspaceId
  );
  return yield* makeAcpConversationCanary({
    ...options,
    storeLayer: makeFileStoreLayer(
      options.laborerSlackId,
      paths.acpRunnerState,
      paths.root,
      undefined,
      { initializeNewThreads: false }
    ),
  });
});
