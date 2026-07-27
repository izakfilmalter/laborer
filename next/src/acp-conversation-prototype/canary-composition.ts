/** Isolated issue #235 composition; it is not part of production startup. */
import { Effect, type Scope } from "effect";
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
import {
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
} from "../reference-coding-application.ts";
import {
  type AcpConversationAgentOptions,
  makeAcpConversationAgent,
} from "./acp-conversation-agent.ts";
import { prepareAcpAgentContextSources } from "./agent-context.ts";
import { makeLaborerMemoryMcpServerConfiguration } from "./memory-mcp.ts";
import type { SlackParticipantLookupShape } from "./slack-participant-lookup.ts";

export interface AcpConversationCanaryOptions {
  readonly activationAcknowledger: ActivationAcknowledgerShape;
  readonly completionReactor: CompletionReactorShape;
  readonly laborerSlackId: string;
  readonly participantLookup?: SlackParticipantLookupShape;
  readonly process: AcpConversationAgentOptions;
  readonly repository?: ReferenceCodingApplicationRepository;
  readonly slack: SlackGatewayShape;
  readonly workspaceId?: string;
}

const outsideCanary = (resource: string) =>
  Effect.die(
    new Error(`${resource} is outside the isolated ACP conversation canary`)
  );

/**
 * Reuses the reference application and Runner's capability-selected publisher.
 * Live composition supplies native Slack streaming; Emulate omits it and uses
 * the post-then-update fallback. Actions and implementation agents intentionally
 * remain outside this proof.
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
            root: options.process.cwd,
            workspaceId: options.workspaceId,
          });
    const conversationAgent = yield* makeAcpConversationAgent({
      ...options.process,
      ...(options.repository === undefined ? {} : { durableSessionMode: true }),
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
      ...(options.repository === undefined
        ? {}
        : { repository: options.repository }),
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
    });
  }
);
