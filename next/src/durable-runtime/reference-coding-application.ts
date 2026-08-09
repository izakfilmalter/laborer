import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  CreateFeatureActionInput,
  DealWithBugActionInput,
} from "../action-catalog.ts";
import { makeGitWorktreeManager } from "../adapters/git-worktree-manager.ts";
import { ThreadId } from "../prototype/domain.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  ActionInvocationAccepted,
  ConversationAction,
  ConversationExecutionControl,
  ImplementationAgentSession,
  TrustedActionInvocation,
  TrustedExecutionControlInvocation,
} from "../reference-coding-application.ts";
import {
  makeLazyOpenCodeImplementationAgent,
  type ReferenceCodingWorkspaceApplicationDependencies,
  type ReferenceCodingWorkspaceApplicationOptions,
} from "../slack/workspace-runner.ts";
import { defineAction, defineApplication } from "./action.ts";
import type {
  ExecutionSnapshot,
  RootDurableRuntimeShape,
} from "./root-runtime.ts";

const ReferenceCodingActionResult = Schema.Struct({
  outcome: Schema.Literal("completed"),
});

interface ActiveImplementation {
  readonly actionName: "create-feature" | "deal-with-bug";
  readonly reportProgress: (
    progressId: string,
    payload: unknown
  ) => Effect.Effect<void, unknown>;
  readonly session: ImplementationAgentSession;
  readonly workingDirectory: string;
}

const stableOpenCodeId = (
  prefix: "msg" | "ses",
  purpose: string,
  identity: string
): string => {
  const digest = createHash("sha256")
    .update(`laborer-cluster-reference-coding-${purpose}-v1\0`, "utf8")
    .update(identity, "utf8")
    .digest("hex");
  return `${prefix}_${prefix === "ses" ? digest.slice(0, 60) : digest}`;
};

/**
 * The repository's coding workflows are ordinary user-application
 * registrations. Laborer core dispatches them only through the generic durable
 * Action catalog and Cluster Execution workflow.
 */
export const makeReferenceCodingRootApplication = Effect.fn(
  "makeReferenceCodingRootApplication"
)(function* (
  options: ReferenceCodingWorkspaceApplicationOptions,
  dependencies: ReferenceCodingWorkspaceApplicationDependencies = {}
) {
  const implementationAgent = yield* makeLazyOpenCodeImplementationAgent(
    options,
    dependencies
  );
  dependencies.observeImplementationAgent?.(implementationAgent);
  const worktreeManager = (
    dependencies.makeWorktreeManager ?? makeGitWorktreeManager
  )({ repository: options.root });
  const active = new Map<string, ActiveImplementation>();

  const makeAction = (
    actionName: "create-feature" | "deal-with-bug",
    description: string,
    input: typeof CreateFeatureActionInput | typeof DealWithBugActionInput
  ) =>
    defineAction({
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      controls: {
        cancel: (context) => {
          const implementation = active.get(context.executionId);
          if (implementation?.session.control === undefined) {
            return Effect.fail(
              capabilityFailure("Implementation control unavailable")
            );
          }
          return implementation.session.control({
            control: "cancel",
            conversationId: ThreadId.make(context.conversationId),
            executionId: context.executionId,
            implementationSessionId: implementation.session.sessionId,
            workingDirectory: implementation.workingDirectory,
          });
        },
        followUp: (content, context) => {
          const implementation = active.get(context.executionId);
          if (implementation === undefined) {
            return Effect.fail(
              capabilityFailure("Implementation session unavailable")
            );
          }
          return implementation.session.resume(
            {
              conversationId: context.conversationId,
              executionId: context.executionId,
              implementationSessionId: implementation.session.sessionId,
              prompt: content,
              promptId: stableOpenCodeId(
                "msg",
                "follow-up",
                `${context.executionId}\0${context.controlId}`
              ),
              workingDirectory: implementation.workingDirectory,
            },
            (response) =>
              implementation
                .reportProgress(response.responseId, {
                  actionName: implementation.actionName,
                  kind: "implementation-message",
                  text: response.text,
                })
                .pipe(
                  Effect.mapError(() =>
                    capabilityFailure("Implementation progress was rejected")
                  )
                )
          );
        },
      },
      description,
      input,
      name: actionName,
      result: ReferenceCodingActionResult,
      revision: `reference-coding/${actionName}/cluster-v1`,
      run: (request, context) =>
        Effect.gen(function* () {
          const worktree = yield* worktreeManager.create({
            conversationId: context.conversationId,
            executionId: context.executionId,
            worktreeName: request.worktreeName,
          });
          const acceptResponse = (response: {
            readonly responseId: string;
            readonly text: string;
          }) =>
            context
              .reportProgress(response.responseId, {
                actionName,
                kind: "implementation-message",
                text: response.text,
              })
              .pipe(
                Effect.mapError(() =>
                  capabilityFailure("Implementation progress was rejected")
                )
              );
          const session = yield* implementationAgent.start(
            {
              actionName,
              conversationId: context.conversationId,
              executionId: context.executionId,
              implementationSessionId: stableOpenCodeId(
                "ses",
                "implementation-session",
                context.executionId
              ),
              prompt: request.prompt,
              promptId: stableOpenCodeId(
                "msg",
                "implementation-prompt",
                context.executionId
              ),
              workingDirectory: worktree.workingDirectory,
            },
            acceptResponse
          );
          active.set(context.executionId, {
            actionName,
            reportProgress: context.reportProgress,
            session,
            workingDirectory: worktree.workingDirectory,
          });
          yield* session.completion.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(context.executionId);
              })
            )
          );
          return { outcome: "completed" as const };
        }),
    });

  return defineApplication({
    actions: [
      makeAction(
        "create-feature",
        "Implement a feature asynchronously in a new isolated named worktree.",
        CreateFeatureActionInput
      ),
      makeAction(
        "deal-with-bug",
        "Diagnose and fix a bug asynchronously in a new isolated named worktree.",
        DealWithBugActionInput
      ),
    ],
  });
});

const capabilityFailure = (detail: string): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: detail,
  });

const lifecycleStatus = (
  status: ExecutionSnapshot["status"]
):
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled" => {
  if (status === "queued") {
    return "starting";
  }
  if (status === "needs-attention") {
    return "failed";
  }
  return status;
};

export interface RootRuntimeConversationCapabilities {
  readonly actionsFor: (
    conversationId: string
  ) => readonly ConversationAction[];
  readonly controlsFor: (
    conversationId: string
  ) => readonly ConversationExecutionControl[];
}

/** Projects the generic root RPC contract into the private ACP Action surface. */
export const conversationCapabilitiesForRootRuntime = (options: {
  readonly rootIdentity: string;
  readonly runtime: RootDurableRuntimeShape;
  readonly workspaceId: string;
}): RootRuntimeConversationCapabilities => {
  const requireActionInvocation = (
    trusted: TrustedActionInvocation | undefined
  ): Effect.Effect<TrustedActionInvocation, HandlerFailure> =>
    trusted === undefined
      ? Effect.fail(capabilityFailure("Action authority is unavailable"))
      : Effect.succeed(trusted);
  const requireControlInvocation = (
    trusted: TrustedExecutionControlInvocation | undefined
  ): Effect.Effect<TrustedExecutionControlInvocation, HandlerFailure> =>
    trusted === undefined
      ? Effect.fail(
          capabilityFailure("Execution control authority is unavailable")
        )
      : Effect.succeed(trusted);

  return {
    actionsFor: (conversationId) =>
      options.runtime.actions.tools.map((tool) => ({
        description: tool.description,
        invoke: (input, trusted) =>
          requireActionInvocation(trusted).pipe(
            Effect.flatMap((invocation) =>
              options.runtime.startExecution({
                actionName: tool.name,
                conversationId,
                input,
                invocationId: invocation.operationId,
                rootIdentity: options.rootIdentity,
                workspaceId: options.workspaceId,
              })
            ),
            Effect.map((execution) => ({
              actionName: execution.actionName,
              deduplicated: false,
              executionId: execution.executionId,
              status: lifecycleStatus(execution.status),
            })),
            Effect.mapError(() => capabilityFailure("Action invocation failed"))
          ),
        name: tool.name,
      })),
    controlsFor: (conversationId) => [
      {
        description:
          "Inspect a bounded lifecycle snapshot for an owned Execution.",
        invoke: (input, trusted) =>
          Effect.gen(function* () {
            const invocation = yield* requireControlInvocation(trusted);
            const executionId =
              typeof input === "object" &&
              input !== null &&
              "executionId" in input &&
              typeof input.executionId === "string"
                ? input.executionId
                : undefined;
            if (executionId === undefined) {
              return { executions: [], schemaVersion: 1, truncated: false };
            }
            const receipt = yield* options.runtime
              .inspectExecution({
                controlId: invocation.operationId,
                conversationId,
                executionId,
                workspaceId: options.workspaceId,
              })
              .pipe(
                Effect.mapError(() =>
                  capabilityFailure("Execution inspection failed")
                )
              );
            const actionName = receipt.execution.actionName;
            if (
              actionName !== "create-feature" &&
              actionName !== "deal-with-bug"
            ) {
              return yield* capabilityFailure(
                "Execution inspection returned an unknown Action"
              );
            }
            return {
              executions: [
                {
                  actionName,
                  canCancel: receipt.execution.canCancel,
                  canPrompt: receipt.execution.canFollowUp,
                  executionId: receipt.execution.executionId,
                  status: lifecycleStatus(receipt.execution.status),
                  worktreeName: "cluster-managed",
                },
              ],
              schemaVersion: 1 as const,
              truncated: false,
            };
          }) as unknown as Effect.Effect<
            ActionInvocationAccepted,
            HandlerFailure
          >,
        name: "inspect-executions",
      },
      {
        description: "Send a durable follow-up to an owned active Execution.",
        invoke: (input, trusted) =>
          Effect.gen(function* () {
            const invocation = yield* requireControlInvocation(trusted);
            if (
              typeof input !== "object" ||
              input === null ||
              !("executionId" in input) ||
              typeof input.executionId !== "string" ||
              !("prompt" in input) ||
              typeof input.prompt !== "string"
            ) {
              return yield* capabilityFailure("Execution follow-up is invalid");
            }
            const receipt = yield* options.runtime
              .followUpExecution({
                content: input.prompt,
                controlId: invocation.operationId,
                conversationId,
                executionId: input.executionId,
                workspaceId: options.workspaceId,
              })
              .pipe(
                Effect.mapError(() =>
                  capabilityFailure("Execution follow-up failed")
                )
              );
            return {
              deduplicated: receipt.deduplicated,
              executionId: receipt.execution.executionId,
              status: lifecycleStatus(receipt.execution.status),
            };
          }),
        name: "prompt-execution",
      },
      {
        description: "Durably cancel one owned active Execution.",
        invoke: (input, trusted) =>
          Effect.gen(function* () {
            const invocation = yield* requireControlInvocation(trusted);
            if (
              typeof input !== "object" ||
              input === null ||
              !("executionId" in input) ||
              typeof input.executionId !== "string"
            ) {
              return yield* capabilityFailure(
                "Execution cancellation is invalid"
              );
            }
            const receipt = yield* options.runtime
              .cancelExecution({
                controlId: invocation.operationId,
                conversationId,
                executionId: input.executionId,
                workspaceId: options.workspaceId,
              })
              .pipe(
                Effect.mapError(() =>
                  capabilityFailure("Execution cancellation failed")
                )
              );
            const actionName = receipt.execution.actionName;
            if (
              actionName !== "create-feature" &&
              actionName !== "deal-with-bug"
            ) {
              return yield* capabilityFailure(
                "Execution cancellation returned an unknown Action"
              );
            }
            return {
              deduplicated: receipt.deduplicated,
              execution: {
                actionName,
                canCancel: false as const,
                canPrompt: false as const,
                executionId: receipt.execution.executionId,
                status: "cancelled" as const,
                worktreeName: "cluster-managed",
              },
              schemaVersion: 1 as const,
            };
          }) as unknown as Effect.Effect<
            ActionInvocationAccepted,
            HandlerFailure
          >,
        name: "cancel-execution",
      },
    ],
  };
};
