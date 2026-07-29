import type { PrototypeState, WorkThreadState } from "../prototype/domain.ts";

export type WorkThreadActivity = "in-progress" | "needs-attention" | "dormant";

export interface WorkThreadActivityObservation {
  readonly activity: WorkThreadActivity;
  readonly evidenceAtUnixMs: number;
  readonly executions: readonly PendingExecutionObservation[];
  readonly id: string;
  readonly label: string;
  readonly workspaceId: string;
}

export interface ProjectedWorkThread {
  readonly activity: WorkThreadActivity;
  readonly executions: ProjectedPendingExecution[];
  readonly id: string;
  readonly label: string;
  readonly stateChangedAtUnixMs: number;
  readonly workspaceId: string;
}

export interface ExecutionActivityObservation {
  readonly actionName: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly lifecycle:
    | "allocated"
    | "cancelling"
    | "implementation-ready"
    | "recovery-blocked"
    | "running"
    | "starting";
  readonly startedAtUnixMs: number | null;
  readonly workspaceId: string;
}

export interface PendingExecutionObservation {
  readonly actionName: string;
  readonly id: string;
  readonly lifecycle: ExecutionActivityObservation["lifecycle"];
  readonly startedAtUnixMs: number | null;
  readonly workspaceId: string;
  readonly workThreadId: string;
}

export type ProjectedPendingExecution = PendingExecutionObservation;

const MAX_DISPLAY_LABEL_LENGTH = 80;
const MAX_RECENT_DORMANT_THREADS = 4;
const MAX_PROJECTED_WORK_THREADS = 512;
const MAX_RECENT_EVIDENCE_RECORDS = 1024;
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]+$/;
const SLACK_TIMESTAMP_PATTERN = /^\d{1,16}(?:\.\d{1,9})?$/;
const recent = <A>(values: readonly A[]): readonly A[] =>
  values.slice(-MAX_RECENT_EVIDENCE_RECORDS);
const threadLabel = (thread: WorkThreadState): string =>
  `${CHANNEL_ID_PATTERN.test(thread.channelId) ? thread.channelId : "Slack"} · ${SLACK_TIMESTAMP_PATTERN.test(thread.rootTs) ? thread.rootTs : "0"}`.slice(
    0,
    MAX_DISPLAY_LABEL_LENGTH
  );

const slackTimestampMillis = (value: string | null): number => {
  if (value === null || !SLACK_TIMESTAMP_PATTERN.test(value)) {
    return 0;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.floor(seconds * 1000) : 0;
};

const evidenceTime = (
  state: PrototypeState,
  thread: WorkThreadState
): number => {
  const values = [
    slackTimestampMillis(thread.activationTs),
    slackTimestampMillis(thread.rootTs),
    ...recent(thread.unassigned).map((message) =>
      slackTimestampMillis(message.slackTs)
    ),
    ...recent(thread.turns).flatMap((turn) =>
      turn.messages.map((message) => slackTimestampMillis(message.slackTs))
    ),
    ...recent(thread.outbox).map((item) => slackTimestampMillis(item.slackTs)),
    ...recent(thread.turns).flatMap((turn) =>
      turn.blocked === null || turn.blocked === undefined
        ? []
        : [turn.blocked.blockedAt]
    ),
    ...recent(thread.applicationEvents).flatMap((event) =>
      event.blocked === null || event.blocked === undefined
        ? []
        : [event.blocked.blockedAt]
    ),
    ...state.conversationStreams.flatMap((stream) =>
      stream.threadId === thread.id
        ? [stream.createdAtMillis, stream.stoppedAtMillis ?? 0]
        : []
    ),
    ...state.conversationStreamTombstones.flatMap((stream) =>
      stream.threadId === thread.id ? [stream.stoppedAtMillis] : []
    ),
  ];
  return Math.max(0, ...values);
};

const activityForThread = (
  state: PrototypeState,
  thread: WorkThreadState,
  executions: readonly ExecutionActivityObservation[]
): WorkThreadActivity => {
  const threadExecutions = executions.filter(
    (execution) => execution.conversationId === thread.id
  );
  const streams = state.conversationStreams.filter(
    (stream) => stream.threadId === thread.id
  );
  const tombstones = state.conversationStreamTombstones.filter(
    (stream) => stream.threadId === thread.id
  );
  const blocked =
    thread.outbox.some((item) => item.status === "blocked") ||
    thread.turns.some((turn) => turn.status === "blocked") ||
    thread.applicationEvents.some((event) => event.status === "blocked") ||
    streams.some((stream) => stream.lifecycle === "unresolved") ||
    tombstones.some((stream) => stream.lifecycle === "unresolved") ||
    threadExecutions.some(
      (execution) => execution.lifecycle === "recovery-blocked"
    );
  if (blocked) {
    return "needs-attention";
  }
  const inProgress =
    thread.contextStatus === "pending" ||
    thread.initializationStatus === "pending" ||
    thread.unassigned.length > 0 ||
    thread.applicationInputQueue.length > 0 ||
    thread.turns.some(
      (turn) => turn.status === "running" || turn.status === "awaiting_delivery"
    ) ||
    thread.applicationEvents.some(
      (event) =>
        event.status === "pending" ||
        event.status === "running" ||
        event.status === "awaiting_delivery"
    ) ||
    thread.outbox.some(
      (item) => item.status === "pending" || item.status === "delivering"
    ) ||
    streams.some(
      (stream) =>
        stream.lifecycle === "open" || stream.lifecycle === "finalizing"
    ) ||
    threadExecutions.some(
      (execution) => execution.lifecycle !== "recovery-blocked"
    );
  return inProgress ? "in-progress" : "dormant";
};

export const observePrototypeWorkThreads = (
  state: PrototypeState,
  workspaceId: string,
  executions: readonly ExecutionActivityObservation[] = []
): readonly WorkThreadActivityObservation[] => {
  const threads = state.threads.filter(
    (thread) => thread.workspaceId === workspaceId
  );
  if (threads.length > MAX_PROJECTED_WORK_THREADS) {
    throw new Error("too many work threads for operator projection");
  }
  const threadIds = new Set<string>(threads.map((thread) => thread.id));
  if (
    executions.some(
      (execution) =>
        execution.workspaceId !== workspaceId ||
        !threadIds.has(execution.conversationId)
    ) ||
    new Set(executions.map((execution) => execution.executionId)).size !==
      executions.length
  ) {
    throw new Error("pending Execution ownership is inconsistent");
  }
  return threads.map((thread) => ({
    activity: activityForThread(state, thread, executions),
    evidenceAtUnixMs: evidenceTime(state, thread),
    id: thread.id,
    label: threadLabel(thread),
    executions: executions
      .filter((execution) => execution.conversationId === thread.id)
      .map((execution) => ({
        actionName: execution.actionName,
        id: execution.executionId,
        lifecycle: execution.lifecycle,
        startedAtUnixMs: execution.startedAtUnixMs,
        workThreadId: thread.id,
        workspaceId,
      })),
    workspaceId,
  }));
};

const activityRank: Record<WorkThreadActivity, number> = {
  "needs-attention": 0,
  "in-progress": 1,
  dormant: 2,
};

const hasConsistentExecutionOwnership = (
  observations: readonly WorkThreadActivityObservation[],
  previous: ReadonlyMap<string, ProjectedWorkThread>,
  workspaceId: string
): boolean => {
  const previousExecutionOwners = new Map(
    [...previous.values()].flatMap((thread) =>
      thread.executions.map((execution) => [execution.id, thread.id] as const)
    )
  );
  const observedExecutionIds = observations.flatMap((observation) =>
    observation.executions.map((execution) => execution.id)
  );
  return (
    new Set(observedExecutionIds).size === observedExecutionIds.length &&
    observations.every((observation) =>
      observation.executions.every(
        (execution) =>
          execution.workspaceId === workspaceId &&
          execution.workThreadId === observation.id &&
          (!previousExecutionOwners.has(execution.id) ||
            previousExecutionOwners.get(execution.id) === observation.id)
      )
    )
  );
};

const projectWorkThread = (
  observation: WorkThreadActivityObservation,
  existing: ProjectedWorkThread | undefined,
  observedAtUnixMs: number,
  workspaceId: string
): ProjectedWorkThread => {
  const changed =
    existing === undefined || existing.activity !== observation.activity;
  const laterDormancyEvidence =
    existing?.activity === "dormant" &&
    observation.activity === "dormant" &&
    observation.evidenceAtUnixMs > existing.stateChangedAtUnixMs;
  let stateChangedAtUnixMs = existing?.stateChangedAtUnixMs ?? observedAtUnixMs;
  if (changed) {
    stateChangedAtUnixMs =
      existing === undefined
        ? Math.min(
            observation.evidenceAtUnixMs || observedAtUnixMs,
            observedAtUnixMs
          )
        : observedAtUnixMs;
  } else if (laterDormancyEvidence) {
    stateChangedAtUnixMs = Math.min(
      observation.evidenceAtUnixMs,
      observedAtUnixMs
    );
  }
  return {
    activity: observation.activity,
    executions: [...observation.executions],
    id: observation.id,
    label: observation.label,
    stateChangedAtUnixMs,
    workspaceId,
  };
};

export const makeWorkThreadActivityProjection = (
  options: { readonly now?: () => number } = {}
) => {
  const now = options.now ?? Date.now;
  const byWorkspace = new Map<string, Map<string, ProjectedWorkThread>>();

  return {
    observe: (
      workspaceId: string,
      observations: readonly WorkThreadActivityObservation[]
    ): void => {
      const observedAtUnixMs = now();
      const previous =
        byWorkspace.get(workspaceId) ?? new Map<string, ProjectedWorkThread>();
      const next = new Map<string, ProjectedWorkThread>();
      if (
        !hasConsistentExecutionOwnership(observations, previous, workspaceId)
      ) {
        throw new Error("pending Execution ownership is inconsistent");
      }
      for (const observation of observations) {
        if (observation.workspaceId !== workspaceId) {
          continue;
        }
        const existing = previous.get(observation.id);
        next.set(
          observation.id,
          projectWorkThread(
            observation,
            existing,
            observedAtUnixMs,
            workspaceId
          )
        );
      }
      byWorkspace.set(workspaceId, next);
    },
    snapshot: (workspaceId: string): readonly ProjectedWorkThread[] => {
      const threads = [...(byWorkspace.get(workspaceId)?.values() ?? [])].sort(
        (left, right) =>
          activityRank[left.activity] - activityRank[right.activity] ||
          right.stateChangedAtUnixMs - left.stateChangedAtUnixMs ||
          left.id.localeCompare(right.id)
      );
      let dormant = 0;
      return threads.filter((thread) => {
        if (thread.activity !== "dormant") {
          return true;
        }
        dormant += 1;
        return dormant <= MAX_RECENT_DORMANT_THREADS;
      });
    },
  };
};
