import type { PrototypeState, WorkThreadState } from "../prototype/domain.ts";

export type WorkThreadActivity = "in-progress" | "needs-attention" | "dormant";

export interface WorkThreadActivityObservation {
  readonly activity: WorkThreadActivity;
  readonly evidenceAtUnixMs: number;
  readonly id: string;
  readonly label: string;
  readonly workspaceId: string;
}

export interface ProjectedWorkThread {
  readonly activity: WorkThreadActivity;
  readonly id: string;
  readonly label: string;
  readonly stateChangedAtUnixMs: number;
  readonly workspaceId: string;
}

export interface ExecutionActivityObservation {
  readonly conversationId: string;
  readonly status: "needs-attention" | "queued" | "running";
}

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
      (execution) => execution.status === "needs-attention"
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
      (execution) =>
        execution.status === "queued" || execution.status === "running"
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
  return threads.map((thread) => ({
    activity: activityForThread(state, thread, executions),
    evidenceAtUnixMs: evidenceTime(state, thread),
    id: thread.id,
    label: threadLabel(thread),
    workspaceId,
  }));
};

const activityRank: Record<WorkThreadActivity, number> = {
  "needs-attention": 0,
  "in-progress": 1,
  dormant: 2,
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
      const previous = byWorkspace.get(workspaceId) ?? new Map();
      const next = new Map<string, ProjectedWorkThread>();
      for (const observation of observations) {
        if (observation.workspaceId !== workspaceId) {
          continue;
        }
        const existing = previous.get(observation.id);
        const changed =
          existing === undefined || existing.activity !== observation.activity;
        const laterDormancyEvidence =
          existing?.activity === "dormant" &&
          observation.activity === "dormant" &&
          observation.evidenceAtUnixMs > existing.stateChangedAtUnixMs;
        let stateChangedAtUnixMs =
          existing?.stateChangedAtUnixMs ?? observedAtUnixMs;
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
        next.set(observation.id, {
          activity: observation.activity,
          id: observation.id,
          label: observation.label,
          stateChangedAtUnixMs,
          workspaceId,
        });
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
