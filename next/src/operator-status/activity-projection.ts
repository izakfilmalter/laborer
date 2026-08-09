import type { DurableWorkThreadActivity } from "../durable-runtime/root-runtime.ts";
import type {
  OperatorWorkspaceBinding,
  OperatorWorkThread,
} from "./protocol.ts";

const MAX_EXCERPT_LENGTH = 120;
const MAX_RECENT_DORMANT_THREADS = 4;
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]+$/;
const SLACK_TIMESTAMP_PATTERN = /^\d{1,16}(?:\.\d{1,9})?$/;

const boundedExcerpt = (source: string): string => {
  const normalized = source
    .replace(/<@[A-Z0-9]+>/gu, "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) {
    return "Slack work thread";
  }
  if (normalized.length <= MAX_EXCERPT_LENGTH) {
    return normalized;
  }
  let bounded = "";
  for (const character of normalized) {
    if (bounded.length + character.length > MAX_EXCERPT_LENGTH - 1) {
      break;
    }
    bounded += character;
  }
  return `${bounded}…`;
};

const labelFor = (activity: DurableWorkThreadActivity): string =>
  `${CHANNEL_ID_PATTERN.test(activity.channelId) ? activity.channelId : "Slack"} · ${SLACK_TIMESTAMP_PATTERN.test(activity.rootTs) ? activity.rootTs : "0"}`;

const stateChangedAt = (
  existing: OperatorWorkThread | undefined,
  activity: OperatorWorkThread["activity"],
  evidenceAt: number,
  observedAt: number
): number => {
  if (existing === undefined) {
    return evidenceAt;
  }
  return existing.activity === activity
    ? existing.stateChangedAtUnixMs
    : observedAt;
};

const activityOrder = (
  left: OperatorWorkThread,
  right: OperatorWorkThread
): number => {
  if (left.activity === right.activity) {
    return 0;
  }
  return left.activity === "in-progress" ? -1 : 1;
};

export const makeWorkThreadActivityProjection = (
  options: { readonly now?: () => number } = {}
) => {
  const now = options.now ?? Date.now;
  const projected = new Map<string, Map<string, OperatorWorkThread>>();
  return {
    observe: (
      workspaceId: string,
      observations: readonly DurableWorkThreadActivity[]
    ): void => {
      const observedAt = now();
      const previous = projected.get(workspaceId) ?? new Map();
      const next = new Map<string, OperatorWorkThread>();
      for (const observation of observations) {
        if (observation.workspaceId !== workspaceId) {
          throw new Error("work-thread activity ownership is inconsistent");
        }
        const activity =
          observation.conversationInProgress ||
          observation.executions.length > 0
            ? "in-progress"
            : "dormant";
        const existing = previous.get(observation.conversationId);
        const evidenceAt = Math.min(
          observedAt,
          Math.max(0, observation.evidenceAtUnixMs)
        );
        next.set(observation.conversationId, {
          activity,
          executions: observation.executions.map((execution) => ({
            actionName: execution.actionName,
            id: execution.executionId,
            lifecycle: execution.lifecycle,
            startedAtUnixMs: execution.startedAtUnixMs,
            workThreadId: observation.conversationId,
            workspaceId,
          })),
          excerpt: boundedExcerpt(observation.excerpt),
          id: observation.conversationId,
          label: labelFor(observation),
          stateChangedAtUnixMs: stateChangedAt(
            existing,
            activity,
            evidenceAt,
            observedAt
          ),
          workspaceId,
        });
      }
      projected.set(workspaceId, next);
    },
    snapshot: (workspaceId: string): readonly OperatorWorkThread[] => {
      let dormant = 0;
      return [...(projected.get(workspaceId)?.values() ?? [])]
        .sort(
          (left, right) =>
            activityOrder(left, right) ||
            right.stateChangedAtUnixMs - left.stateChangedAtUnixMs ||
            left.id.localeCompare(right.id)
        )
        .filter((thread) => {
          if (thread.activity === "in-progress") {
            return true;
          }
          dormant += 1;
          return dormant <= MAX_RECENT_DORMANT_THREADS;
        });
    },
  };
};

export const makePostCutoverOperatorProjection = (
  bindings: readonly {
    readonly bindingIndex: number;
    readonly expectedTeamId?: string;
    readonly tokenIsValid: boolean;
  }[]
) => {
  const activity = makeWorkThreadActivityProjection();
  let receiver: "connected" | "connecting" = "connecting";
  const ready = new Set<string>();
  const workspaces: OperatorWorkspaceBinding[] = bindings.map((binding) => {
    const teamId =
      binding.tokenIsValid && binding.expectedTeamId !== undefined
        ? binding.expectedTeamId
        : null;
    return {
      detail: teamId === null ? "configuration-invalid" : null,
      id:
        teamId === null ? `binding:${binding.bindingIndex}` : `slack:${teamId}`,
      label:
        teamId === null
          ? `Workspace binding ${binding.bindingIndex + 1}`
          : teamId,
      readiness: teamId === null ? "unknown" : "pending",
      teamId,
      threads: [],
    };
  });
  return {
    markReceiverConnected: (): void => {
      receiver = "connected";
    },
    markWorkspaceReady: (workspaceId: string): void => {
      ready.add(workspaceId);
    },
    observe: (
      workspaceId: string,
      observations: readonly DurableWorkThreadActivity[]
    ): void => activity.observe(workspaceId, observations),
    snapshot: () => ({
      receiver,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        ...(workspace.teamId !== null && ready.has(workspace.teamId)
          ? { detail: null, readiness: "ready" as const }
          : {}),
        threads:
          workspace.teamId === null
            ? []
            : [...activity.snapshot(workspace.teamId)],
      })),
    }),
  };
};
