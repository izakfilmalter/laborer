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
import { makeReferenceCodingApplication } from "../reference-coding-application.ts";
import {
  type AcpConversationAgentOptions,
  makeAcpConversationAgent,
} from "./acp-conversation-agent.ts";
import { prepareAcpAgentContextSources } from "./agent-context.ts";

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
  readonly laborerSlackId: string;
  readonly process: AcpConversationAgentOptions;
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
      ...(agentContext === undefined ? {} : { agentContext }),
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
    });
  }
);
